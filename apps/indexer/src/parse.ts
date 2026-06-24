// Pure transaction-parsing helpers — no Redis/Worker/network side effects so
// they can be unit tested in isolation.

export type HeliusTokenBalance = {
  owner?: string;
  mint: string;
  uiTokenAmount?: { amount?: string };
};

export type HeliusParsedInstruction = {
  programId?: string;
  program?: string;
  parsed?: {
    type?: string;
    info?: {
      source?: string;
      destination?: string;
      lamports?: number | string;
    };
  };
};

// With jsonParsed encoding each account key is an object; some RPCs still
// return bare pubkey strings, so accept both.
export type HeliusAccountKey = string | { pubkey?: string };

export type HeliusParsedTransaction = {
  slot?: number;
  blockTime?: number;
  transaction?: {
    signatures?: string[];
    message?: {
      instructions?: HeliusParsedInstruction[];
      accountKeys?: HeliusAccountKey[];
    };
  };
  meta?: {
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: HeliusTokenBalance[];
    postTokenBalances?: HeliusTokenBalance[];
    innerInstructions?: Array<{ instructions?: HeliusParsedInstruction[] }>;
  };
};

export function accountKeyPubkey(key: HeliusAccountKey | undefined): string | undefined {
  return typeof key === 'string' ? key : key?.pubkey;
}

/**
 * Convert a base-unit integer amount (as a string) to a human-unit float
 * WITHOUT precision loss for large values. `Number("50000000000000000")`
 * silently rounds past 2^53 (~9e15); a 9-decimal memecoin trade routinely
 * exceeds that. We split the integer and fractional parts in BigInt space first
 * so only the (small) scaled quotient is handed to Number.
 */
export function baseUnitsToFloat(amountStr: string, decimals: number): number {
  let v: bigint;
  try {
    v = BigInt(amountStr);
  } catch {
    return 0;
  }
  if (decimals <= 0) return Number(v);
  const negative = v < 0n;
  if (negative) v = -v;
  const divisor = 10n ** BigInt(decimals);
  const intPart = v / divisor;
  const fracPart = v % divisor;
  const fracStr = fracPart.toString().padStart(decimals, '0');
  const num = Number(`${intPart.toString()}.${fracStr}`);
  return negative ? -num : num;
}

// Ignore native-SOL deltas below this when treating SOL as a swap leg, so that
// pure-fee txs and tiny rent movements aren't mistaken for trades (0.001 SOL).
export const MIN_SOL_LEG_LAMPORTS = 1_000_000;

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
// Ignore dust / fee-sized transfers when inferring funding (0.05 SOL).
export const MIN_FUNDING_LAMPORTS = 50_000_000;

export type FundingTransfer = { source: string; destination: string; lamports: number };

/**
 * Extract SystemProgram SOL transfers from a parsed transaction.
 * Looks at both top-level and inner instructions. Filters to `transfer` /
 * `transferChecked` instructions above the dust threshold.
 */
export function extractFundingTransfers(
  tx: HeliusParsedTransaction,
  minLamports = MIN_FUNDING_LAMPORTS
): FundingTransfer[] {
  const top = tx.transaction?.message?.instructions ?? [];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? []);
  const all = [...top, ...inner];

  const transfers: FundingTransfer[] = [];
  // Dedup identical transfers within the same tx: a CPI'd SystemProgram transfer
  // can surface in both the top-level and inner instruction lists, which would
  // otherwise double-count the funding edge's accumulated lamports.
  const seen = new Set<string>();
  for (const ix of all) {
    const isSystem = ix.programId === SYSTEM_PROGRAM_ID || ix.program === 'system';
    if (!isSystem) continue;
    // SystemProgram funding is always a plain `transfer` (SPL `transferChecked`
    // carries tokenAmount, not lamports), so only `transfer` is relevant here.
    if (ix.parsed?.type !== 'transfer') continue;

    const info = ix.parsed?.info;
    const source = info?.source;
    const destination = info?.destination;
    const lamports = info?.lamports != null ? Number(info.lamports) : NaN;

    if (!source || !destination) continue;
    if (!Number.isFinite(lamports) || lamports < minLamports) continue;
    if (source === destination) continue;

    const key = `${source}|${destination}|${lamports}`;
    if (seen.has(key)) continue;
    seen.add(key);

    transfers.push({ source, destination, lamports });
  }
  return transfers;
}

/**
 * Compute the buy/sell direction and target token for a swap from the wallet's
 * pre/post token balance deltas. Returns null if the tx isn't a clean 2-sided
 * swap for this wallet.
 */
export function getWalletTokenDeltas(tx: HeliusParsedTransaction, walletAddress: string) {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const balances = new Map<string, { pre: bigint; post: bigint }>();

  for (const item of pre) {
    if (item.owner !== walletAddress || !item.mint) continue;
    const amount = BigInt(item.uiTokenAmount?.amount ?? '0');
    const current = balances.get(item.mint) ?? { pre: 0n, post: 0n };
    balances.set(item.mint, { pre: current.pre + amount, post: current.post });
  }

  for (const item of post) {
    if (item.owner !== walletAddress || !item.mint) continue;
    const amount = BigInt(item.uiTokenAmount?.amount ?? '0');
    const current = balances.get(item.mint) ?? { pre: 0n, post: 0n };
    balances.set(item.mint, { pre: current.pre, post: current.post + amount });
  }

  // Native SOL is NOT in pre/postTokenBalances — it lives in the lamports
  // arrays. Without this leg, SOL→token buys and token→SOL sells (the common
  // memecoin case) look one-sided and get skipped. Synthesize a SOL_MINT delta
  // from the wallet's native balance change, removing the tx fee when the
  // wallet paid it so the leg reflects only swapped SOL.
  const accountKeys = tx.transaction?.message?.accountKeys ?? [];
  const walletIndex = accountKeys.findIndex((k) => accountKeyPubkey(k) === walletAddress);
  const preLamports = tx.meta?.preBalances;
  const postLamports = tx.meta?.postBalances;
  if (walletIndex >= 0 && preLamports && postLamports &&
      preLamports[walletIndex] != null && postLamports[walletIndex] != null) {
    let nativeDelta = BigInt(postLamports[walletIndex]) - BigInt(preLamports[walletIndex]);
    // The fee payer is always account index 0; add the fee back so it doesn't
    // count as SOL spent on the swap.
    if (walletIndex === 0 && tx.meta?.fee != null) nativeDelta += BigInt(tx.meta.fee);
    if (nativeDelta < 0n ? -nativeDelta >= MIN_SOL_LEG_LAMPORTS : nativeDelta >= MIN_SOL_LEG_LAMPORTS) {
      const current = balances.get(SOL_MINT) ?? { pre: 0n, post: 0n };
      // Fold the native delta into the existing SOL entry (covers wrapped-SOL too).
      balances.set(SOL_MINT, { pre: current.pre, post: current.post + nativeDelta });
    }
  }

  const deltas = Array.from(balances.entries())
    .map(([mint, value]) => ({ mint, delta: value.post - value.pre }))
    .filter((e) => e.delta !== 0n);

  if (deltas.length < 2) return null;

  const negatives = deltas.filter((e) => e.delta < 0n);
  const positives = deltas.filter((e) => e.delta > 0n);
  if (negatives.length === 0 || positives.length === 0) return null;

  const tokenIn = negatives.reduce((min, cur) => (cur.delta < min.delta ? cur : min));
  const tokenOut = positives.reduce((max, cur) => (cur.delta > max.delta ? cur : max));
  if (!tokenIn || !tokenOut) return null;

  const direction: 'buy' | 'sell' =
    tokenIn.mint === SOL_MINT ? 'buy' : tokenOut.mint === SOL_MINT ? 'sell' : 'buy';
  const targetToken = direction === 'buy' ? tokenOut.mint : tokenIn.mint;

  return {
    tokenIn: tokenIn.mint,
    tokenOut: tokenOut.mint,
    amountIn: (-tokenIn.delta).toString(),
    amountOut: tokenOut.delta.toString(),
    direction,
    targetToken
  };
}

export type TokenBuyer = {
  owner: string;
  /** Base units of `mint` the owner gained in this tx (post - pre, > 0). */
  amount: bigint;
};

/**
 * Find every account that NET-GAINED a balance of `mint` in this transaction —
 * i.e. the buyers/receivers of the token in this tx. Used by token-discovery to
 * enumerate candidate early/big buyers from each on-chain swap.
 *
 * Aggregates per owner across all of that owner's token accounts for `mint`
 * (an owner can hold the mint in several ATAs). Owners whose net delta is <= 0
 * (sellers, unchanged) are excluded.
 */
export function extractTokenBuyers(tx: HeliusParsedTransaction, mint: string): TokenBuyer[] {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  // owner -> { pre, post } summed base units of `mint`.
  const balances = new Map<string, { pre: bigint; post: bigint }>();

  for (const item of pre) {
    if (item.mint !== mint || !item.owner) continue;
    const amount = BigInt(item.uiTokenAmount?.amount ?? '0');
    const current = balances.get(item.owner) ?? { pre: 0n, post: 0n };
    balances.set(item.owner, { pre: current.pre + amount, post: current.post });
  }

  for (const item of post) {
    if (item.mint !== mint || !item.owner) continue;
    const amount = BigInt(item.uiTokenAmount?.amount ?? '0');
    const current = balances.get(item.owner) ?? { pre: 0n, post: 0n };
    balances.set(item.owner, { pre: current.pre, post: current.post + amount });
  }

  const buyers: TokenBuyer[] = [];
  for (const [owner, value] of balances.entries()) {
    const delta = value.post - value.pre;
    if (delta > 0n) buyers.push({ owner, amount: delta });
  }
  return buyers;
}
