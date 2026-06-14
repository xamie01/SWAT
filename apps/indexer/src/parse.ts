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

export type HeliusParsedTransaction = {
  slot?: number;
  blockTime?: number;
  transaction?: {
    signatures?: string[];
    message?: { instructions?: HeliusParsedInstruction[] };
  };
  meta?: {
    preTokenBalances?: HeliusTokenBalance[];
    postTokenBalances?: HeliusTokenBalance[];
    innerInstructions?: Array<{ instructions?: HeliusParsedInstruction[] }>;
  };
};

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
  for (const ix of all) {
    const isSystem = ix.programId === SYSTEM_PROGRAM_ID || ix.program === 'system';
    if (!isSystem) continue;
    const type = ix.parsed?.type;
    if (type !== 'transfer' && type !== 'transferChecked') continue;

    const info = ix.parsed?.info;
    const source = info?.source;
    const destination = info?.destination;
    const lamports = info?.lamports != null ? Number(info.lamports) : NaN;

    if (!source || !destination) continue;
    if (!Number.isFinite(lamports) || lamports < minLamports) continue;
    if (source === destination) continue;

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
