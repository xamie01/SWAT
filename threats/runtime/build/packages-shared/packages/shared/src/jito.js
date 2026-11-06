/**
 * Jito block-engine client for atomic bundle submission (DG-1, checklist S3-2).
 *
 * **Why bundles rather than a public RPC broadcast.** A swap broadcast to the
 * public mempool is visible to searchers before it lands, which is precisely the
 * window a sandwich attack needs. A Jito bundle is delivered straight to block
 * builders and lands atomically — all transactions or none — so there is no
 * partially-executed state to reconcile and no public pre-trade signal.
 *
 * The tip is what buys inclusion: block builders order bundles by tip, so a tip
 * below the current floor is simply never built.
 */
/**
 * Local rather than shared: `jupiter.ts` and `prices.ts` each already carry their
 * own private variant with a different signature, and unifying all three is a
 * refactor of two working call sites that this module does not need.
 */
async function fetchWithTimeout(url, init = {}, timeoutMs = 10_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
const LAMPORTS_PER_SOL = 1_000_000_000;
/**
 * Fallback tip accounts — **not** the source of truth (checklist S4-P18).
 *
 * A tip must go to one of Jito's *current* tip accounts or the bundle is silently
 * ignored: nothing lands and the executor still reports a successful submission.
 * Jito rotates these addresses, so a hard-coded array is a liveness fuse whose
 * only repair is a code deploy.
 *
 * `getJitoTipAccounts` resolves the live set at runtime and falls back here when
 * it cannot. This array is the floor of that arrangement, kept because an
 * unreadable endpoint must never block an otherwise-valid trade.
 */
export const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
];
function lamportsFromSol(sol) {
    return Math.round(sol * LAMPORTS_PER_SOL);
}
/**
 * Converts a lamport amount to USD.
 *
 * Returns `null` when the price is unusable rather than substituting a guess.
 * This value becomes `feeUsd` on a trade row and feeds cost-basis arithmetic, so
 * a wrong number is strictly worse than a missing one: a missing fee is visibly
 * absent, a wrong fee silently misstates realised P&L forever.
 */
export function lamportsToUsd(lamports, solPriceUsd) {
    if (!Number.isFinite(lamports) || lamports < 0)
        return null;
    if (solPriceUsd === null || !Number.isFinite(solPriceUsd) || solPriceUsd <= 0)
        return null;
    return (lamports / LAMPORTS_PER_SOL) * solPriceUsd;
}
/**
 * Reads the current tip floor.
 *
 * Returns `null` rather than throwing: the caller's correct response to an
 * unreadable floor is to fall back to a configured default tip, not to abandon
 * an otherwise-valid trade.
 */
export async function getJitoTipFloor(options) {
    try {
        const response = await fetchWithTimeout('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {}, options.timeoutMs ?? 5_000);
        if (!response.ok)
            return null;
        const payload = (await response.json());
        const row = payload[0];
        if (!row)
            return null;
        // The endpoint reports SOL; everything downstream works in lamports, and
        // mixing the two would misprice the tip by 10^9.
        return {
            p25: lamportsFromSol(row.landed_tips_25th_percentile ?? 0),
            p50: lamportsFromSol(row.landed_tips_50th_percentile ?? 0),
            p75: lamportsFromSol(row.landed_tips_75th_percentile ?? 0),
            p95: lamportsFromSol(row.landed_tips_95th_percentile ?? 0),
            p99: lamportsFromSol(row.landed_tips_99th_percentile ?? 0)
        };
    }
    catch {
        return null;
    }
}
/**
 * Chooses a tip, bounded by an absolute cap (checklist S3-3).
 *
 * The cap is not advisory. Without it a congestion spike — or a malformed floor
 * response reporting an absurd percentile — would let the executor spend an
 * unbounded amount of SOL per trade, and the tip is a real cost that counts
 * against position P&L.
 */
export function selectJitoTip(input) {
    const raw = input.floor ? input.floor[input.percentile] : input.fallbackTipLamports;
    // A zero or negative floor means "no data", not "free" — a zero tip never lands.
    const candidate = raw > 0 ? raw : input.fallbackTipLamports;
    return Math.max(1, Math.min(Math.round(candidate), input.maxTipLamports));
}
// ─── Tip-account resolution (checklist S4-P18) ───────────────────────────────
/**
 * JSON-RPC method that returns the live tip-account list.
 *
 * **Verified**, not guessed. Jito's own client — `jito-labs/jito-js-rpc`,
 * `src/index.ts` — implements `getTipAccounts` by posting
 * `{jsonrpc, id, method: 'getTipAccounts', params: []}` to the `/bundles`
 * endpoint, the *same* endpoint its `sendBundle` and `getBundleStatuses` use, on a
 * base URL its examples give as `https://mainnet.block-engine.jito.wtf/api/v1`.
 * Its README lists the method as "get accounts eligible for tips".
 *
 * The separate `bundles.jito.wtf` REST host that `getJitoTipFloor` reads serves
 * tip *percentiles*, not tip *accounts*, and is not an alternative here.
 */
const TIP_ACCOUNTS_RPC_METHOD = 'getTipAccounts';
/**
 * Resolves the bundle endpoint to ask, or `null` when there is nothing to ask.
 *
 * Derived from the already-configured `JITO_BLOCK_ENGINE_URL` rather than from a
 * tip-account-specific setting. That is deliberate: this list is a payment
 * allowlist, and a second, separately-settable source for it would let anything
 * with environment access redirect every tip this executor pays without touching
 * the block-engine URL an operator actually reviews.
 */
function tipAccountsEndpoint(options) {
    const base = options.baseUrl?.trim().replace(/\/+$/, '') ?? '';
    return base ? `${base}/api/v1/bundles` : null;
}
/** Base58 without the ambiguous characters Solana omits (`0`, `O`, `I`, `l`). */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/**
 * Keeps only plausible base58 addresses, or `null` if none survive.
 *
 * A tip is an unconditional SOL transfer, so this list is a payment allowlist:
 * anything that lands in it gets paid on every trade until the TTL expires.
 * A malformed or hostile response must therefore never widen it, and a wholly
 * unusable response must resolve to `null` so the caller keeps the known-good
 * fallback rather than an empty set it would then have to special-case.
 */
function sanitizeTipAccounts(values) {
    if (!Array.isArray(values))
        return null;
    const accounts = values.filter((value) => typeof value === 'string' && BASE58_ADDRESS.test(value));
    return accounts.length > 0 ? [...new Set(accounts)] : null;
}
/**
 * Reads the live tip-account set.
 *
 * Returns `null` rather than throwing, exactly like `getJitoTipFloor`: the
 * caller's correct response to an unreadable set is the hard-coded fallback, not
 * abandoning the trade.
 */
export async function fetchJitoTipAccounts(options) {
    const url = tipAccountsEndpoint(options);
    if (!url)
        return null;
    const headers = { 'Content-Type': 'application/json' };
    if (options.apiKey)
        headers['x-jito-auth'] = options.apiKey;
    try {
        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: TIP_ACCOUNTS_RPC_METHOD,
                params: []
            })
        }, options.timeoutMs ?? 5_000);
        if (!response.ok)
            return null;
        const payload = (await response.json());
        if (payload.error)
            return null;
        return sanitizeTipAccounts(payload.result);
    }
    catch {
        return null;
    }
}
/** How long a successfully resolved set is trusted. */
export const JITO_TIP_ACCOUNTS_CACHE_TTL_MS = 300_000;
/**
 * How long a *failed* resolution is remembered.
 *
 * Shorter than the success TTL so a transient outage recovers quickly, but
 * non-zero so an endpoint that is simply misconfigured does not add a failing
 * round trip to the latency of every single trade.
 */
export const JITO_TIP_ACCOUNTS_FALLBACK_TTL_MS = 60_000;
/**
 * Hard entry cap, following the `S4-P3` discipline in
 * `packages/db/src/risk-policy.ts`.
 *
 * The key is derived from the block-engine endpoint, which is operator config
 * today and per-tenant config under fan-out. An unbounded module-level `Map`
 * keyed by anything caller-derived is the defect class that fix exists to close,
 * so this one is swept on write and capped — 64 distinct endpoints is far past
 * any plausible deployment.
 */
export const JITO_TIP_ACCOUNTS_CACHE_MAX_ENTRIES = 64;
const cachedTipAccounts = new Map();
const tipAccountLoads = new Map();
let tipAccountsGeneration = 0;
function tipAccountsCacheKey(options) {
    return tipAccountsEndpoint(options) ?? 'unconfigured';
}
function tipAccountsTtlMs(entry) {
    return entry.resolved ? JITO_TIP_ACCOUNTS_CACHE_TTL_MS : JITO_TIP_ACCOUNTS_FALLBACK_TTL_MS;
}
/**
 * Drops expired entries, then evicts oldest-first if still over the cap.
 *
 * Eviction is by insertion order, which `Map` preserves — a free approximation of
 * LRU, adequate because every entry expires within its TTL anyway. The cap is the
 * backstop for a burst that outruns expiry, not the primary mechanism.
 */
function pruneTipAccountsCache(now) {
    for (const [key, entry] of cachedTipAccounts) {
        if (now - entry.timestamp >= tipAccountsTtlMs(entry))
            cachedTipAccounts.delete(key);
    }
    if (cachedTipAccounts.size <= JITO_TIP_ACCOUNTS_CACHE_MAX_ENTRIES)
        return;
    const excess = cachedTipAccounts.size - JITO_TIP_ACCOUNTS_CACHE_MAX_ENTRIES;
    let removed = 0;
    for (const key of cachedTipAccounts.keys()) {
        if (removed >= excess)
            break;
        cachedTipAccounts.delete(key);
        removed += 1;
    }
}
/**
 * The tip-account set to pay into, resolved at runtime and cached with a TTL.
 *
 * Never returns an empty set and never rejects: an unresolvable endpoint yields
 * `JITO_TIP_ACCOUNTS`, so the worst case is the behaviour that shipped before
 * this seam existed. Concurrent callers share one in-flight lookup rather than
 * each firing their own — a batch of submits arriving together would otherwise
 * stampede the block engine on every cold cache.
 */
export async function getJitoTipAccounts(options) {
    const key = tipAccountsCacheKey(options);
    const cached = cachedTipAccounts.get(key);
    if (cached && Date.now() - cached.timestamp < tipAccountsTtlMs(cached)) {
        return cached.accounts;
    }
    const inFlight = tipAccountLoads.get(key);
    if (inFlight?.generation === tipAccountsGeneration)
        return inFlight.promise;
    const generation = tipAccountsGeneration;
    const promise = Promise.resolve()
        .then(() => fetchJitoTipAccounts(options))
        // `fetchJitoTipAccounts` already swallows its own failures; this is the
        // backstop for anything it cannot (a `fetch` global that throws
        // synchronously, say). Propagating would fail a trade over a tip-address
        // lookup, which is never the right trade-off.
        .catch(() => null)
        .then((resolved) => {
        const accounts = resolved ?? JITO_TIP_ACCOUNTS;
        if (generation === tipAccountsGeneration) {
            const now = Date.now();
            cachedTipAccounts.set(key, { accounts, resolved: resolved !== null, timestamp: now });
            // Swept on write rather than on a timer: a timer keeps the process alive
            // and runs when nothing is being cached, whereas growth only happens here.
            pruneTipAccountsCache(now);
        }
        return accounts;
    });
    tipAccountLoads.set(key, { generation, promise });
    try {
        return await promise;
    }
    finally {
        if (tipAccountLoads.get(key)?.promise === promise)
            tipAccountLoads.delete(key);
    }
}
/** Drops every cached set, invalidating in-flight lookups. */
export function clearJitoTipAccountsCache() {
    tipAccountsGeneration += 1;
    cachedTipAccounts.clear();
    tipAccountLoads.clear();
}
/** Entry count. Test-only — lets a test assert the cache is actually bounded. */
export function jitoTipAccountsCacheSize() {
    return cachedTipAccounts.size;
}
/**
 * Deterministically picks one tip account out of a **caller-supplied** set.
 *
 * `accounts` is required, and deliberately has no default (checklist S4-P18).
 * It used to close over `JITO_TIP_ACCOUNTS` directly; a default parameter would
 * preserve that for any call site that forgot to pass the live set, and the
 * failure mode is the one this item exists to remove — a tip to a rotated-away
 * address means the block engine ignores the bundle, nothing lands, and the
 * executor still reports a successful submission. A required parameter turns that
 * omission into a compile error instead. Pass the result of
 * `getJitoTipAccounts`, which is never empty.
 *
 * **Determinism is per-set, not absolute.** The index is `hash % accounts.length`,
 * so the same seed can map to a different account after a refresh changes the set
 * (or its length). That is intentional and harmless: nothing downstream keys off
 * *which* tip account was used, only that it is a currently-valid one, and the
 * property that does matter — one stable account for the single bundle being
 * built, since this is called once per submission — is unaffected. A seed-stable
 * mapping across refreshes would be strictly worse, because it could only be
 * achieved by pinning to a set that may already be stale.
 */
export function selectTipAccount(seed, accounts) {
    // An empty set would make the modulo below produce NaN and the lookup
    // undefined — a tip to no one. Fall back rather than emit that.
    const set = accounts.length > 0 ? accounts : JITO_TIP_ACCOUNTS;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    const index = Math.abs(hash) % set.length;
    return set[index];
}
/**
 * Submits a bundle of base64 transactions.
 *
 * A failure here is reported honestly and never silently downgraded to a public
 * RPC broadcast (checklist S3-5). Downgrading would reintroduce exactly the
 * front-running exposure bundles exist to remove, and would do so invisibly —
 * the operator would believe they were protected.
 */
export async function submitJitoBundle(transactionsBase64, options) {
    if (transactionsBase64.length === 0) {
        return { ok: false, reason: 'empty-bundle', retryable: false };
    }
    // The block engine caps a bundle at 5 transactions; a larger one is rejected
    // wholesale, so catch it here where the reason is legible.
    if (transactionsBase64.length > 5) {
        return { ok: false, reason: 'bundle-too-large', retryable: false };
    }
    const headers = { 'Content-Type': 'application/json' };
    if (options.apiKey)
        headers['x-jito-auth'] = options.apiKey;
    try {
        const response = await fetchWithTimeout(`${options.baseUrl}/api/v1/bundles`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'sendBundle',
                params: [transactionsBase64, { encoding: 'base64' }]
            })
        }, options.timeoutMs ?? 10_000);
        if (!response.ok) {
            // 429 and 5xx are transient; 4xx is a malformed bundle we must not retry.
            const retryable = response.status === 429 || response.status >= 500;
            const snippet = (await response.text().catch(() => '')).slice(0, 200);
            return { ok: false, reason: `http-${response.status}: ${snippet}`, retryable };
        }
        const payload = (await response.json());
        if (payload.error) {
            return { ok: false, reason: payload.error.message ?? 'unknown-error', retryable: false };
        }
        if (!payload.result) {
            return { ok: false, reason: 'no-bundle-id', retryable: false };
        }
        return { ok: true, bundleId: payload.result };
    }
    catch (error) {
        // A timeout is genuinely ambiguous: the bundle may have been received. It is
        // marked retryable, but the caller must reconcile by bundle status rather
        // than blindly resubmitting — see the executor's confirmation path.
        return {
            ok: false,
            reason: error instanceof Error ? error.message : 'network-error',
            retryable: true
        };
    }
}
/**
 * Reads bundle status.
 *
 * `null` means the status could not be observed — deliberately distinct from
 * `Invalid`, which is a definitive "never seen". Treating an unreachable block
 * engine as `Invalid` would let the executor conclude a submitted bundle failed
 * and re-submit it, double-spending the position.
 */
export async function getJitoBundleStatus(bundleId, options) {
    const headers = { 'Content-Type': 'application/json' };
    if (options.apiKey)
        headers['x-jito-auth'] = options.apiKey;
    try {
        const response = await fetchWithTimeout(`${options.baseUrl}/api/v1/bundles`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getBundleStatuses',
                params: [[bundleId]]
            })
        }, options.timeoutMs ?? 5_000);
        if (!response.ok)
            return null;
        const payload = (await response.json());
        const entry = payload.result?.value?.[0];
        if (!entry) {
            return { bundleId, status: 'Invalid', transactions: [], slot: null };
        }
        const confirmation = entry.confirmation_status ?? '';
        const status = confirmation === 'finalized' || confirmation === 'confirmed'
            ? 'Landed'
            : confirmation === 'failed'
                ? 'Failed'
                : 'Pending';
        return {
            bundleId,
            status,
            transactions: entry.transactions ?? [],
            slot: entry.slot ?? null
        };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=jito.js.map