/**
 * Jupiter Swap API v1 client for SWAT paper-trade simulation.
 *
 * This module fetches **quotes only** — it never signs or broadcasts a
 * transaction.  A quote tells us the exact output amount, price impact, and
 * routing a real swap would produce, which is far more accurate than the
 * simple `amountUsd / spotPrice` division the paper path used before.
 *
 * Every public function returns `null` on failure so callers can gracefully
 * fall back to the existing spot-price logic without crashing the job.
 *
 * Endpoint:  GET https://api.jup.ag/swap/v1/quote
 * Auth:      x-api-key header (free tier from https://developers.jup.ag/portal)
 * Rate limit: ~60 req/min on free tier (trade-executor runs at concurrency 1,
 *             signals fire every 15 s max — well within this budget).
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const JUPITER_API_BASE = 'https://api.jup.ag/swap/v1';

/** Per-request timeout. Mirrors the convention in prices.ts. */
const JUPITER_QUOTE_TIMEOUT_MS = Number(
  process.env.JUPITER_QUOTE_TIMEOUT_MS ?? 8000
);

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single hop in the route returned by the Quote API. */
export interface JupiterRouteStep {
  swapInfo: {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
  };
  percent: number;
}

/** Subset of the Quote API response we actually consume. */
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRouteStep[];
  contextSlot: number;
}

/** Parameters accepted by {@link getJupiterQuote}. */
export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  /** Raw amount in the input token's smallest unit (lamports for SOL). */
  amountLamports: number;
  /** Slippage tolerance in basis points.  Defaults to 150 (1.5 %). */
  slippageBps?: number;
  swapMode?: 'ExactIn' | 'ExactOut';
}

/**
 * Pre-processed result returned by {@link getJupiterSimulatedFill}.
 * Contains human-friendly numbers ready to persist into the `trades` table.
 */
export interface JupiterSimulatedFill {
  /** Raw output amount as returned by Jupiter (smallest token unit). */
  outAmountRaw: string;
  /** Output amount converted to human units using `outputDecimals`. */
  tokenAmount: number;
  /** Minimum tokens after slippage, in human units. */
  minTokenAmount: number;
  /** Price impact as a number (e.g. 0.12 means 0.12 %). */
  priceImpactPct: number;
  /** The full route plan for informational logging / storage. */
  routePlan: JupiterRouteStep[];
  /** Solana slot the quote was computed at. */
  contextSlot: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = JUPITER_QUOTE_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch a Jupiter swap quote.  Returns `null` on any error (network, rate
 * limit, missing route, bad response shape) so the caller never has to
 * worry about exceptions.
 *
 * @param params  Quote parameters (mints, amount, slippage).
 * @param apiKey  Optional Jupiter API key.  When omitted the request is
 *                still sent (some endpoints allow unauthenticated access at
 *                a lower rate limit), but authenticated calls are preferred.
 */
export async function getJupiterQuote(
  params: JupiterQuoteParams,
  apiKey?: string
): Promise<JupiterQuote | null> {
  const url = new URL(`${JUPITER_API_BASE}/quote`);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', Math.round(params.amountLamports).toString());
  url.searchParams.set(
    'slippageBps',
    (params.slippageBps ?? 150).toString()
  );
  if (params.swapMode) {
    url.searchParams.set('swapMode', params.swapMode);
  }

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  try {
    const response = await fetchWithTimeout(url.toString(), { headers });

    if (!response.ok) {
      // Log status but don't throw — caller falls back gracefully.
      const snippet = (await response.text().catch(() => '')).slice(0, 200);
      console.error(
        `[jupiter] quote failed ${response.status}: ${snippet}`
      );
      return null;
    }

    const data = (await response.json()) as JupiterQuote;

    // Minimal shape validation — reject clearly malformed payloads rather than
    // letting a broken upstream silently produce NaN token amounts downstream.
    if (!data.outAmount || !data.inAmount) {
      console.error('[jupiter] malformed quote response — missing amounts');
      return null;
    }

    return data;
  } catch (error: unknown) {
    // AbortError (timeout) or network failure — log and return null.
    const msg =
      error instanceof Error ? error.message : String(error);
    console.error(`[jupiter] quote fetch error: ${msg}`);
    return null;
  }
}

/**
 * High-level helper that fetches a quote and converts it into values ready
 * for the `trades` table.  Returns `null` when the quote is unavailable so
 * the paper-fill path can fall back to the existing spot-price logic.
 *
 * @param params         Same as {@link getJupiterQuote}.
 * @param outputDecimals The output token's decimal places (default 9 for most
 *                       SPL tokens).  Used to convert raw amounts to human
 *                       units.  When unknown, pass `undefined` to use 9.
 * @param apiKey         Jupiter API key (optional, but recommended).
 */
export async function getJupiterSimulatedFill(
  params: JupiterQuoteParams,
  outputDecimals?: number,
  apiKey?: string
): Promise<JupiterSimulatedFill | null> {
  const quote = await getJupiterQuote(params, apiKey);
  if (!quote) return null;

  const decimals = outputDecimals ?? 9;
  const divisor = 10 ** decimals;

  const outRaw = Number(quote.outAmount);
  const minRaw = Number(quote.otherAmountThreshold);
  const priceImpact = parseFloat(quote.priceImpactPct);

  // Guard against NaN leaking into the DB.
  if (!Number.isFinite(outRaw) || outRaw <= 0) {
    console.error(
      `[jupiter] non-finite outAmount: ${quote.outAmount}`
    );
    return null;
  }

  return {
    outAmountRaw: quote.outAmount,
    tokenAmount: outRaw / divisor,
    minTokenAmount: Number.isFinite(minRaw) ? minRaw / divisor : outRaw / divisor,
    priceImpactPct: Number.isFinite(priceImpact) ? priceImpact : 0,
    routePlan: quote.routePlan ?? [],
    contextSlot: quote.contextSlot ?? 0
  };
}
