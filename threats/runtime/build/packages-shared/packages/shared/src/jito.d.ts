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
export declare const JITO_TIP_ACCOUNTS: readonly ["96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe", "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49", "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt", "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"];
export interface JitoBundleStatus {
    readonly bundleId: string;
    /** `Invalid` means the block engine has never seen this bundle id. */
    readonly status: 'Invalid' | 'Pending' | 'Failed' | 'Landed';
    /** Signatures in the bundle, present once it lands. */
    readonly transactions: readonly string[];
    readonly slot: number | null;
}
export interface JitoClientOptions {
    /** Block-engine base URL, e.g. `https://mainnet.block-engine.jito.wtf`. */
    readonly baseUrl: string;
    readonly apiKey?: string;
    readonly timeoutMs?: number;
}
/**
 * Tip floor percentiles, in **lamports**, as published by the block engine.
 *
 * These move with congestion. Sizing a tip off a hard-coded constant either
 * overpays permanently or silently stops landing when the floor rises.
 */
export interface JitoTipFloor {
    readonly p25: number;
    readonly p50: number;
    readonly p75: number;
    readonly p95: number;
    readonly p99: number;
}
/**
 * Converts a lamport amount to USD.
 *
 * Returns `null` when the price is unusable rather than substituting a guess.
 * This value becomes `feeUsd` on a trade row and feeds cost-basis arithmetic, so
 * a wrong number is strictly worse than a missing one: a missing fee is visibly
 * absent, a wrong fee silently misstates realised P&L forever.
 */
export declare function lamportsToUsd(lamports: number, solPriceUsd: number | null): number | null;
/**
 * Reads the current tip floor.
 *
 * Returns `null` rather than throwing: the caller's correct response to an
 * unreadable floor is to fall back to a configured default tip, not to abandon
 * an otherwise-valid trade.
 */
export declare function getJitoTipFloor(options: JitoClientOptions): Promise<JitoTipFloor | null>;
export interface TipSizingInput {
    readonly floor: JitoTipFloor | null;
    /** Percentile to target. Higher lands more reliably and costs more. */
    readonly percentile: 'p50' | 'p75' | 'p95';
    /** Hard ceiling from `JITO_MAX_TIP_LAMPORTS`. Never exceeded. */
    readonly maxTipLamports: number;
    /** Used when the floor is unreadable. */
    readonly fallbackTipLamports: number;
}
/**
 * Chooses a tip, bounded by an absolute cap (checklist S3-3).
 *
 * The cap is not advisory. Without it a congestion spike — or a malformed floor
 * response reporting an absurd percentile — would let the executor spend an
 * unbounded amount of SOL per trade, and the tip is a real cost that counts
 * against position P&L.
 */
export declare function selectJitoTip(input: TipSizingInput): number;
/**
 * Reads the live tip-account set.
 *
 * Returns `null` rather than throwing, exactly like `getJitoTipFloor`: the
 * caller's correct response to an unreadable set is the hard-coded fallback, not
 * abandoning the trade.
 */
export declare function fetchJitoTipAccounts(options: JitoClientOptions): Promise<readonly string[] | null>;
/** How long a successfully resolved set is trusted. */
export declare const JITO_TIP_ACCOUNTS_CACHE_TTL_MS = 300000;
/**
 * How long a *failed* resolution is remembered.
 *
 * Shorter than the success TTL so a transient outage recovers quickly, but
 * non-zero so an endpoint that is simply misconfigured does not add a failing
 * round trip to the latency of every single trade.
 */
export declare const JITO_TIP_ACCOUNTS_FALLBACK_TTL_MS = 60000;
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
export declare const JITO_TIP_ACCOUNTS_CACHE_MAX_ENTRIES = 64;
/**
 * The tip-account set to pay into, resolved at runtime and cached with a TTL.
 *
 * Never returns an empty set and never rejects: an unresolvable endpoint yields
 * `JITO_TIP_ACCOUNTS`, so the worst case is the behaviour that shipped before
 * this seam existed. Concurrent callers share one in-flight lookup rather than
 * each firing their own — a batch of submits arriving together would otherwise
 * stampede the block engine on every cold cache.
 */
export declare function getJitoTipAccounts(options: JitoClientOptions): Promise<readonly string[]>;
/** Drops every cached set, invalidating in-flight lookups. */
export declare function clearJitoTipAccountsCache(): void;
/** Entry count. Test-only — lets a test assert the cache is actually bounded. */
export declare function jitoTipAccountsCacheSize(): number;
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
export declare function selectTipAccount(seed: string, accounts: readonly string[]): string;
export type JitoSubmitResult = {
    readonly ok: true;
    readonly bundleId: string;
} | {
    readonly ok: false;
    readonly reason: string;
    readonly retryable: boolean;
};
/**
 * Submits a bundle of base64 transactions.
 *
 * A failure here is reported honestly and never silently downgraded to a public
 * RPC broadcast (checklist S3-5). Downgrading would reintroduce exactly the
 * front-running exposure bundles exist to remove, and would do so invisibly —
 * the operator would believe they were protected.
 */
export declare function submitJitoBundle(transactionsBase64: readonly string[], options: JitoClientOptions): Promise<JitoSubmitResult>;
/**
 * Reads bundle status.
 *
 * `null` means the status could not be observed — deliberately distinct from
 * `Invalid`, which is a definitive "never seen". Treating an unreachable block
 * engine as `Invalid` would let the executor conclude a submitted bundle failed
 * and re-submit it, double-spending the position.
 */
export declare function getJitoBundleStatus(bundleId: string, options: JitoClientOptions): Promise<JitoBundleStatus | null>;
//# sourceMappingURL=jito.d.ts.map