import type { JupiterQuote } from './jupiter.js';

/**
 * Jupiter `/swap` transaction-build step (checklist S3-1).
 *
 * The quote tells us the route and amounts; this step produces the actual
 * transaction that, once signed, will execute that swap on-chain.
 *
 * **Signer as parameter, not hardcoded.** Right now the operator wallet; at
 * Stage 4 per-user custodial keys, no call-site change required.
 */

const JUPITER_API_BASE = 'https://api.jup.ag/swap/v1';
const JUPITER_SWAP_BUILD_TIMEOUT_MS = 8_000;

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

export interface JupiterSwapBuildParams {
  readonly quote: JupiterQuote;
  /** The wallet that will sign and pay for the transaction. */
  readonly userPublicKey: string;
  /**
   * Wrap/unwrap SOL as needed. Set `true` for safety: a user cannot *spend* an
   * unwrapped SOL balance without this, and a swap that would leave dust in a
   * wrapped token account is wasteful — better to close it and recover the rent.
   */
  readonly wrapUnwrapSOL?: boolean;
  /**
   * When true, include compute-budget and priority-fee instructions. Should
   * always be false for Jito bundles — the *tip* is what buys inclusion, and a
   * priority fee layered on top is double-paying for the same thing.
   */
  readonly computeUnitPriceMicroLamports?: number;
  readonly apiKey?: string;
}

export interface JupiterSwapTransaction {
  /** Base64-encoded transaction ready to sign. */
  readonly swapTransaction: string;
  /** The slot the quote was built against; after this expires the tx is stale. */
  readonly lastValidBlockHeight: number;
}

/**
 * Builds the swap transaction from a quote.
 *
 * Returns `null` rather than throwing: the caller's correct response to an
 * unbuildable swap is to fall back gracefully (re-quote or skip), not to crash
 * the executor job.
 */
export async function buildJupiterSwap(
  params: JupiterSwapBuildParams
): Promise<JupiterSwapTransaction | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (params.apiKey) headers['x-api-key'] = params.apiKey;

  const body = {
    quoteResponse: params.quote,
    userPublicKey: params.userPublicKey,
    wrapUnwrapSOL: params.wrapUnwrapSOL ?? true,
    computeUnitPriceMicroLamports: params.computeUnitPriceMicroLamports ?? undefined,
    // asLegacyTransaction: false is the default; we need versioned transactions
    // for Jupiter's route plan, which often includes lookup tables.
    asLegacyTransaction: false
  };

  try {
    const response = await fetchWithTimeout(
      `${JUPITER_API_BASE}/swap`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      },
      JUPITER_SWAP_BUILD_TIMEOUT_MS
    );

    if (!response.ok) {
      const snippet = (await response.text().catch(() => '')).slice(0, 200);
      console.error(`[jupiter] swap build failed ${response.status}: ${snippet}`);
      return null;
    }

    const payload = (await response.json()) as {
      swapTransaction?: string;
      lastValidBlockHeight?: number;
      error?: string;
    };
    if (payload.error) {
      console.error(`[jupiter] swap build error: ${payload.error}`);
      return null;
    }
    if (!payload.swapTransaction || typeof payload.lastValidBlockHeight !== 'number') {
      console.error('[jupiter] swap build response missing required fields');
      return null;
    }
    return {
      swapTransaction: payload.swapTransaction,
      lastValidBlockHeight: payload.lastValidBlockHeight
    };
  } catch (error) {
    console.error(
      '[jupiter] swap build request failed:',
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
