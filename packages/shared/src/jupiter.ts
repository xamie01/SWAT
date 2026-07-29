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
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  priceImpactPct: string;
  routePlan: JupiterRouteStep[];
  contextSlot: number;
}

/** Parameters accepted by {@link getJupiterQuote}. */
export interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  /**
   * Raw amount in the specified side's smallest unit: input for ExactIn,
   * output for ExactOut. The legacy name is retained for caller compatibility.
   */
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
  /** This is quote evidence, not a confirmed or submitted chain fill. */
  status: 'quoted';
  swapMode: 'ExactIn' | 'ExactOut';
  /** Raw input amount returned by Jupiter (smallest input-token unit). */
  inAmountRaw: string;
  /** Raw output amount as returned by Jupiter (smallest token unit). */
  outAmountRaw: string;
  /** Output amount converted to human units using `outputDecimals`. */
  tokenAmount: number;
  /** Minimum output after slippage for ExactIn; null for ExactOut. */
  minTokenAmount: number | null;
  /** Maximum input after slippage for ExactOut; null for ExactIn. */
  maxInputAmount: number | null;
  /** Direction-aware interpretation of Jupiter's otherAmountThreshold. */
  threshold:
    | { kind: 'minimum-output'; rawAmount: string; amount: number; decimals: number }
    | { kind: 'maximum-input'; rawAmount: string; amount: number; decimals: number };
  /** Price impact as a number (e.g. 0.12 means 0.12 %). */
  priceImpactPct: number;
  /** The full route plan for informational logging / storage. */
  routePlan: JupiterRouteStep[];
  /** Solana slot the quote was computed at. */
  contextSlot: number;
}

export type JupiterQuoteDecimals = {
  inputDecimals: number;
  outputDecimals: number;
};

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

function assertTokenDecimals(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 30) {
    throw new Error(`Invalid ${label} token decimals: ${value}`);
  }
}

function parsePositiveRawAmount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

function rawAmountToNumber(rawAmount: string, decimals: number): number | null {
  const parsed = parsePositiveRawAmount(rawAmount);
  if (parsed === null) return null;
  if (decimals === 0) {
    const value = Number(parsed);
    return Number.isFinite(value) ? value : null;
  }

  const divisor = 10n ** BigInt(decimals);
  const whole = parsed / divisor;
  const fraction = (parsed % divisor).toString().padStart(decimals, '0');
  const value = Number(`${whole.toString()}.${fraction}`);
  return Number.isFinite(value) ? value : null;
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
  if (!Number.isSafeInteger(params.amountLamports) || params.amountLamports <= 0) {
    throw new Error(`Invalid Jupiter raw quote amount: ${params.amountLamports}`);
  }
  const requestedSwapMode = params.swapMode ?? 'ExactIn';
  const url = new URL(`${JUPITER_API_BASE}/quote`);
  url.searchParams.set('inputMint', params.inputMint);
  url.searchParams.set('outputMint', params.outputMint);
  url.searchParams.set('amount', Math.round(params.amountLamports).toString());
  url.searchParams.set(
    'slippageBps',
    (params.slippageBps ?? 150).toString()
  );
  url.searchParams.set('swapMode', requestedSwapMode);

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
    if (
      parsePositiveRawAmount(data.outAmount) === null
      || parsePositiveRawAmount(data.inAmount) === null
      || parsePositiveRawAmount(data.otherAmountThreshold) === null
      || data.swapMode !== requestedSwapMode
    ) {
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
 * @param decimals       Resolved token decimals. ExactOut requires both input
 *                       and output decimals because its threshold is max-input.
 *                       ExactIn temporarily accepts an output-decimals number
 *                       for existing callers, with no guessed fallback.
 * @param apiKey         Jupiter API key (optional, but recommended).
 */
export async function getJupiterSimulatedFill(
  params: JupiterQuoteParams,
  decimals: number | JupiterQuoteDecimals,
  apiKey?: string
): Promise<JupiterSimulatedFill | null> {
  const requestedSwapMode = params.swapMode ?? 'ExactIn';
  const outputDecimals = typeof decimals === 'number'
    ? decimals
    : decimals.outputDecimals;
  const inputDecimals = typeof decimals === 'number'
    ? null
    : decimals.inputDecimals;

  assertTokenDecimals(outputDecimals, 'output');
  if (inputDecimals !== null) assertTokenDecimals(inputDecimals, 'input');
  if (requestedSwapMode === 'ExactOut' && inputDecimals === null) {
    throw new Error('ExactOut Jupiter quotes require resolved input token decimals');
  }

  const quote = await getJupiterQuote(params, apiKey);
  if (!quote) return null;

  const tokenAmount = rawAmountToNumber(quote.outAmount, outputDecimals);
  const priceImpact = parseFloat(quote.priceImpactPct);
  const thresholdDecimals = quote.swapMode === 'ExactIn'
    ? outputDecimals
    : inputDecimals!;
  const thresholdAmount = rawAmountToNumber(
    quote.otherAmountThreshold,
    thresholdDecimals
  );

  // Guard against NaN leaking into the DB.
  if (tokenAmount === null || tokenAmount <= 0 || thresholdAmount === null) {
    console.error(
      `[jupiter] non-finite quote amounts: ${quote.inAmount}/${quote.outAmount}/${quote.otherAmountThreshold}`
    );
    return null;
  }

  const threshold = quote.swapMode === 'ExactIn'
    ? {
        kind: 'minimum-output' as const,
        rawAmount: quote.otherAmountThreshold,
        amount: thresholdAmount,
        decimals: thresholdDecimals
      }
    : {
        kind: 'maximum-input' as const,
        rawAmount: quote.otherAmountThreshold,
        amount: thresholdAmount,
        decimals: thresholdDecimals
      };

  return {
    status: 'quoted',
    swapMode: quote.swapMode,
    inAmountRaw: quote.inAmount,
    outAmountRaw: quote.outAmount,
    tokenAmount,
    minTokenAmount: quote.swapMode === 'ExactIn' ? thresholdAmount : null,
    maxInputAmount: quote.swapMode === 'ExactOut' ? thresholdAmount : null,
    threshold,
    priceImpactPct: Number.isFinite(priceImpact) ? priceImpact : 0,
    routePlan: quote.routePlan ?? [],
    contextSlot: quote.contextSlot ?? 0
  };
}
