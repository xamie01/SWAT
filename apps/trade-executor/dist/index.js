import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_RISK_CONFIG, fetchTokenPriceUsd } from '@swat/shared';
import { insertTrade, markSignalExecuted, claimSignalForExecution, releaseSignalClaim, hasRecentBuy } from '@swat/db';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const mode = process.env.TRADING_MODE ?? 'paper';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TROJAN_WEBHOOK_URL = process.env.TROJAN_WEBHOOK_URL;
const TROJAN_API_KEY = process.env.TROJAN_API_KEY;
const BASE_POSITION_SOL = parseFloat(process.env.BASE_POSITION_SOL ?? '0.5');
// Absolute ceiling on a single position, as a final safety clamp on the
// computed size (defends against misconfiguration sending a huge live buy).
const MAX_POSITION_SOL = parseFloat(process.env.MAX_POSITION_SOL ?? '5');
const AUTO_EXECUTE = process.env.AUTO_EXECUTE === 'true';
const AUTO_EXECUTE_MIN_SCORE = Number(process.env.AUTO_EXECUTE_MIN_SCORE ?? 90);
// Don't re-buy the same token within this window (a held position keeps
// re-triggering snipe signals). 0 disables the cooldown.
const REBUY_COOLDOWN_MINUTES = Number(process.env.REBUY_COOLDOWN_MINUTES ?? 60);
// Fail fast on a misconfigured base size rather than sending NaN/garbage to the
// live trade path.
if (!Number.isFinite(BASE_POSITION_SOL) || BASE_POSITION_SOL <= 0) {
    throw new Error(`[trade-executor] invalid BASE_POSITION_SOL: ${process.env.BASE_POSITION_SOL}`);
}
if (!Number.isFinite(MAX_POSITION_SOL) || MAX_POSITION_SOL <= 0) {
    throw new Error(`[trade-executor] invalid MAX_POSITION_SOL: ${process.env.MAX_POSITION_SOL}`);
}
let consecutiveFailures = 0;
// ─── Price helpers ─────────────────────────────────────────────────────────────
/**
 * SOL/USD with a 30s Redis cache (shared key with the indexer). Returns null
 * when no real price is available — never a fabricated fallback, which would
 * silently corrupt cost basis on real trades.
 */
async function getCachedSolPrice() {
    const cached = await redis.get('sol:price');
    if (cached) {
        const p = parseFloat(cached);
        if (Number.isFinite(p))
            return p;
    }
    const price = await fetchTokenPriceUsd(SOL_MINT);
    if (price === null || !Number.isFinite(price))
        return null;
    await redis.setex('sol:price', 30, price.toString());
    return price;
}
/**
 * Persist a filled trade. Best-effort: a logging failure must not fail the job
 * (which would trip the circuit breaker for a non-execution reason).
 */
async function persistTrade(opts) {
    try {
        const [solPrice, tokenPrice] = await Promise.all([
            getCachedSolPrice(),
            fetchTokenPriceUsd(opts.tokenMint)
        ]);
        // If SOL price is unavailable, store null USD rather than a fabricated cost
        // basis — the on-chain SOL amount is still recorded for later reconciliation.
        const amountUsd = solPrice !== null ? opts.sizeSol * solPrice : null;
        const tokenAmount = amountUsd !== null && tokenPrice && tokenPrice > 0 ? amountUsd / tokenPrice : null;
        await insertTrade({
            signalId: opts.signalId,
            tokenMint: opts.tokenMint,
            direction: 'buy',
            amountSol: opts.sizeSol,
            amountUsd,
            tokenAmount,
            priceUsd: tokenPrice,
            slippageBps: 1500,
            signature: opts.signature ?? null,
            executionMode: opts.executionMode,
            executor: opts.executor,
            status: 'filled'
        });
        await markSignalExecuted(opts.signalId);
    }
    catch (error) {
        console.error('[trade-executor] failed to persist trade', error);
    }
}
const TIER_MULTIPLIER = {
    elite: 1.0,
    pro: 0.75,
    promising: 0.5,
    speculative: 0.25
};
function calculatePositionSize(score, clusterTier = 'promising') {
    const tierMult = TIER_MULTIPLIER[clusterTier] ?? 0.5;
    const scoreMult = score >= 90 ? 1.0 : score >= 80 ? 0.75 : 0.5;
    const raw = BASE_POSITION_SOL * tierMult * scoreMult;
    if (!Number.isFinite(raw) || raw <= 0)
        return 0;
    // Clamp to the absolute ceiling so a misconfiguration can't size a huge buy.
    return Number(Math.min(raw, MAX_POSITION_SOL).toFixed(4));
}
// ─── Trojan API integration ───────────────────────────────────────────────────
async function triggerTrojan(params) {
    const url = TROJAN_WEBHOOK_URL;
    if (!url)
        throw new Error('TROJAN_WEBHOOK_URL is not configured');
    const headers = { 'content-type': 'application/json' };
    if (TROJAN_API_KEY) {
        headers['Authorization'] = `Bearer ${TROJAN_API_KEY}`;
    }
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            action: 'buy',
            token: params.tokenMint,
            amount: params.amountSol,
            slippage: (params.slippageBps ?? 1500) / 100, // bps → %
            mev_protection: true,
            source: 'SWAT_ENGINE'
        })
    });
    if (!response.ok) {
        // Truncate the response body before embedding it in the (logged) error so a
        // verbose upstream error can't dump request/credential echoes into logs.
        const text = (await response.text()).slice(0, 200);
        throw new Error(`Trojan API error ${response.status}: ${text}`);
    }
    return response.json();
}
// ─── Worker ───────────────────────────────────────────────────────────────────
async function handleJob(job) {
    const payload = job.data;
    // Auto-execute only fires above the configured threshold unless manually triggered
    if (!payload.manual && (!AUTO_EXECUTE || payload.score < AUTO_EXECUTE_MIN_SCORE)) {
        return {
            status: 'skipped',
            reason: `Auto-execute disabled or score ${payload.score} < threshold ${AUTO_EXECUTE_MIN_SCORE}`
        };
    }
    const sizeSol = calculatePositionSize(payload.score, payload.clusterTier ?? 'promising');
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
        return { status: 'skipped', reason: 'Position size calculated to 0' };
    }
    // Re-buy cooldown: skip if we already bought this token recently (a held
    // position keeps producing fresh snipe signals after the dedupe window).
    if (REBUY_COOLDOWN_MINUTES > 0 && await hasRecentBuy(payload.tokenMint, REBUY_COOLDOWN_MINUTES)) {
        return { status: 'skipped', reason: `Re-buy cooldown active for ${payload.tokenMint}` };
    }
    // IDEMPOTENCY GUARD: atomically claim the signal before placing any trade.
    // A duplicate/re-delivered signal (e.g. repeated manual /execute clicks) loses
    // the claim and is skipped — preventing a second (live) buy.
    const claimed = await claimSignalForExecution(payload.signalId);
    if (!claimed) {
        return { status: 'skipped', reason: 'Signal already executing or executed' };
    }
    try {
        if (mode === 'paper') {
            console.log(`[trade-executor] PAPER: would buy ${payload.tokenMint} with ${sizeSol} SOL (score: ${payload.score})`);
            await persistTrade({
                signalId: payload.signalId,
                tokenMint: payload.tokenMint,
                sizeSol,
                executionMode: 'paper',
                executor: 'paper'
            });
            return {
                status: 'paper-filled',
                signalId: payload.signalId,
                tokenMint: payload.tokenMint,
                sizeSol,
                mode: 'paper'
            };
        }
        // Live execution via Trojan
        const result = await triggerTrojan({
            tokenMint: payload.tokenMint,
            amountSol: sizeSol,
            slippageBps: 1500
        });
        console.log(`[trade-executor] LIVE: executed buy for ${payload.tokenMint} @ ${sizeSol} SOL`);
        await persistTrade({
            signalId: payload.signalId,
            tokenMint: payload.tokenMint,
            sizeSol,
            executionMode: 'live',
            executor: 'trojan',
            signature: result?.signature ?? null
        });
        return {
            status: 'live-executed',
            signalId: payload.signalId,
            tokenMint: payload.tokenMint,
            sizeSol,
            trojanResult: result
        };
    }
    catch (err) {
        // Execution failed before fill — release the claim so it can be retried.
        await releaseSignalClaim(payload.signalId).catch(() => { });
        throw err;
    }
}
new Worker('swat-trades', async (job) => {
    // Synchronous circuit breaker: checked and mutated inside the job (with
    // concurrency 1) so a burst of jobs can't all read 0 before the async
    // 'failed' handler fires.
    if (consecutiveFailures >= DEFAULT_RISK_CONFIG.maxConsecutiveFailures) {
        throw new Error('[trade-executor] Circuit breaker active: too many consecutive failures');
    }
    try {
        const result = await handleJob(job);
        consecutiveFailures = 0;
        return result;
    }
    catch (err) {
        consecutiveFailures++;
        throw err;
    }
}, 
// concurrency 1 keeps the breaker counter coherent and serializes live trades.
{ connection: redis, concurrency: 1 })
    .on('failed', (_job, err) => {
    console.error('[trade-executor] job failed', err?.message);
});
console.log(`[trade-executor] running in ${mode} mode | auto-execute: ${AUTO_EXECUTE} (min score: ${AUTO_EXECUTE_MIN_SCORE})`);
//# sourceMappingURL=index.js.map