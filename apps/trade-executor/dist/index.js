import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { DEFAULT_RISK_CONFIG } from '@swat/shared';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const mode = process.env.TRADING_MODE ?? 'paper';
const TROJAN_WEBHOOK_URL = process.env.TROJAN_WEBHOOK_URL;
const TROJAN_API_KEY = process.env.TROJAN_API_KEY;
const BASE_POSITION_SOL = parseFloat(process.env.BASE_POSITION_SOL ?? '0.5');
const AUTO_EXECUTE = process.env.AUTO_EXECUTE === 'true';
const AUTO_EXECUTE_MIN_SCORE = Number(process.env.AUTO_EXECUTE_MIN_SCORE ?? 90);
let consecutiveFailures = 0;
const TIER_MULTIPLIER = {
    elite: 1.0,
    pro: 0.75,
    promising: 0.5,
    speculative: 0.25
};
function calculatePositionSize(score, clusterTier = 'promising') {
    const tierMult = TIER_MULTIPLIER[clusterTier] ?? 0.5;
    const scoreMult = score >= 90 ? 1.0 : score >= 80 ? 0.75 : 0.5;
    return Number((BASE_POSITION_SOL * tierMult * scoreMult).toFixed(4));
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
        const text = await response.text();
        throw new Error(`Trojan API error ${response.status}: ${text}`);
    }
    return response.json();
}
// ─── Worker ───────────────────────────────────────────────────────────────────
new Worker('swat-trades', async (job) => {
    if (consecutiveFailures >= DEFAULT_RISK_CONFIG.maxConsecutiveFailures) {
        throw new Error('[trade-executor] Circuit breaker active: too many consecutive failures');
    }
    const payload = job.data;
    // Auto-execute only fires above the configured threshold unless manually triggered
    if (!payload.manual && (!AUTO_EXECUTE || payload.score < AUTO_EXECUTE_MIN_SCORE)) {
        return {
            status: 'skipped',
            reason: `Auto-execute disabled or score ${payload.score} < threshold ${AUTO_EXECUTE_MIN_SCORE}`
        };
    }
    const sizeSol = calculatePositionSize(payload.score, payload.clusterTier ?? 'promising');
    if (sizeSol <= 0) {
        return { status: 'skipped', reason: 'Position size calculated to 0' };
    }
    if (mode === 'paper') {
        console.log(`[trade-executor] PAPER: would buy ${payload.tokenMint} with ${sizeSol} SOL (score: ${payload.score})`);
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
    return {
        status: 'live-executed',
        signalId: payload.signalId,
        tokenMint: payload.tokenMint,
        sizeSol,
        trojanResult: result
    };
}, { connection: redis })
    .on('failed', (_job, err) => {
    consecutiveFailures++;
    console.error('[trade-executor] job failed', err.message);
})
    .on('completed', () => {
    consecutiveFailures = 0;
});
console.log(`[trade-executor] running in ${mode} mode | auto-execute: ${AUTO_EXECUTE} (min score: ${AUTO_EXECUTE_MIN_SCORE})`);
//# sourceMappingURL=index.js.map