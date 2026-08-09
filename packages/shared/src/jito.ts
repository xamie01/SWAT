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
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Jito tip accounts. A tip must go to one of these or the bundle is ignored. */
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
] as const;

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

function lamportsFromSol(sol: number): number {
  return Math.round(sol * 1_000_000_000);
}

/**
 * Reads the current tip floor.
 *
 * Returns `null` rather than throwing: the caller's correct response to an
 * unreadable floor is to fall back to a configured default tip, not to abandon
 * an otherwise-valid trade.
 */
export async function getJitoTipFloor(
  options: JitoClientOptions
): Promise<JitoTipFloor | null> {
  try {
    const response = await fetchWithTimeout(
      'https://bundles.jito.wtf/api/v1/bundles/tip_floor',
      {},
      options.timeoutMs ?? 5_000
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as Array<Record<string, number>>;
    const row = payload[0];
    if (!row) return null;
    // The endpoint reports SOL; everything downstream works in lamports, and
    // mixing the two would misprice the tip by 10^9.
    return {
      p25: lamportsFromSol(row.landed_tips_25th_percentile ?? 0),
      p50: lamportsFromSol(row.landed_tips_50th_percentile ?? 0),
      p75: lamportsFromSol(row.landed_tips_75th_percentile ?? 0),
      p95: lamportsFromSol(row.landed_tips_95th_percentile ?? 0),
      p99: lamportsFromSol(row.landed_tips_99th_percentile ?? 0)
    };
  } catch {
    return null;
  }
}

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
export function selectJitoTip(input: TipSizingInput): number {
  const raw = input.floor ? input.floor[input.percentile] : input.fallbackTipLamports;
  // A zero or negative floor means "no data", not "free" — a zero tip never lands.
  const candidate = raw > 0 ? raw : input.fallbackTipLamports;
  return Math.max(1, Math.min(Math.round(candidate), input.maxTipLamports));
}

/** Deterministically picks a tip account, spreading load across the set. */
export function selectTipAccount(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % JITO_TIP_ACCOUNTS.length;
  return JITO_TIP_ACCOUNTS[index]!;
}

export type JitoSubmitResult =
  | { readonly ok: true; readonly bundleId: string }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

/**
 * Submits a bundle of base64 transactions.
 *
 * A failure here is reported honestly and never silently downgraded to a public
 * RPC broadcast (checklist S3-5). Downgrading would reintroduce exactly the
 * front-running exposure bundles exist to remove, and would do so invisibly —
 * the operator would believe they were protected.
 */
export async function submitJitoBundle(
  transactionsBase64: readonly string[],
  options: JitoClientOptions
): Promise<JitoSubmitResult> {
  if (transactionsBase64.length === 0) {
    return { ok: false, reason: 'empty-bundle', retryable: false };
  }
  // The block engine caps a bundle at 5 transactions; a larger one is rejected
  // wholesale, so catch it here where the reason is legible.
  if (transactionsBase64.length > 5) {
    return { ok: false, reason: 'bundle-too-large', retryable: false };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey) headers['x-jito-auth'] = options.apiKey;

  try {
    const response = await fetchWithTimeout(
      `${options.baseUrl}/api/v1/bundles`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [transactionsBase64, { encoding: 'base64' }]
        })
      },
      options.timeoutMs ?? 10_000
    );

    if (!response.ok) {
      // 429 and 5xx are transient; 4xx is a malformed bundle we must not retry.
      const retryable = response.status === 429 || response.status >= 500;
      const snippet = (await response.text().catch(() => '')).slice(0, 200);
      return { ok: false, reason: `http-${response.status}: ${snippet}`, retryable };
    }

    const payload = (await response.json()) as {
      result?: string;
      error?: { message?: string };
    };
    if (payload.error) {
      return { ok: false, reason: payload.error.message ?? 'unknown-error', retryable: false };
    }
    if (!payload.result) {
      return { ok: false, reason: 'no-bundle-id', retryable: false };
    }
    return { ok: true, bundleId: payload.result };
  } catch (error) {
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
export async function getJitoBundleStatus(
  bundleId: string,
  options: JitoClientOptions
): Promise<JitoBundleStatus | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey) headers['x-jito-auth'] = options.apiKey;

  try {
    const response = await fetchWithTimeout(
      `${options.baseUrl}/api/v1/bundles`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]]
        })
      },
      options.timeoutMs ?? 5_000
    );
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      result?: { value?: Array<{ bundle_id: string; confirmation_status?: string; transactions?: string[]; slot?: number } | null> };
    };
    const entry = payload.result?.value?.[0];
    if (!entry) {
      return { bundleId, status: 'Invalid', transactions: [], slot: null };
    }
    const confirmation = entry.confirmation_status ?? '';
    const status: JitoBundleStatus['status'] =
      confirmation === 'finalized' || confirmation === 'confirmed'
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
  } catch {
    return null;
  }
}
