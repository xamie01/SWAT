// Pure transaction-parsing helpers — no Redis/Worker/network side effects so
// they can be unit tested in isolation.
import { createHash } from 'node:crypto';

export type HeliusTokenBalance = {
  owner?: string;
  accountIndex?: number;
  mint: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
};

export type HeliusParsedInstruction = {
  programId?: string;
  program?: string;
  accounts?: string[];
  data?: string;
  parsed?: {
    type?: string;
    info?: {
      source?: string;
      destination?: string;
      amount?: string;
      tokenAmount?: { amount?: string };
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
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: HeliusTokenBalance[];
    postTokenBalances?: HeliusTokenBalance[];
    innerInstructions?: Array<{ index?: number; instructions?: HeliusParsedInstruction[] }>;
  };
};

export function accountKeyPubkey(key: HeliusAccountKey | undefined): string | undefined {
  return typeof key === 'string' ? key : key?.pubkey;
}

/**
 * Convert a base-unit integer string to a human-unit float, applying decimal
 * scaling before conversion. Integer accounting must retain the original string;
 * the returned Number is an approximation for display and USD enrichment.
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

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
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
  const balances = new Map<string, { pre: bigint; post: bigint; decimals?: number }>();

  for (const [side, items] of [['pre', pre], ['post', post]] as const) {
    for (const item of items) {
      if (item.owner !== walletAddress) continue;
      const text = item.uiTokenAmount?.amount;
      const decimals = item.uiTokenAmount?.decimals;
      if (!item.mint || typeof text !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(text)
          || BigInt(text) > 18446744073709551615n
          || (decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > 255))) return null;
      const current = balances.get(item.mint) ?? { pre: 0n, post: 0n, decimals };
      if (current.decimals !== undefined && decimals !== undefined && current.decimals !== decimals) return null;
      current.decimals ??= decimals;
      current[side] += BigInt(text);
      balances.set(item.mint, current);
    }
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
    const safeLamports = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0;
    if (!safeLamports(preLamports[walletIndex]) || !safeLamports(postLamports[walletIndex])
        || (tx.meta?.fee !== undefined && !safeLamports(tx.meta.fee))) return null;
    let nativeDelta = BigInt(postLamports[walletIndex]) - BigInt(preLamports[walletIndex]);
    const ownedIndices = new Set([...pre, ...post]
      .filter(item => item.owner === walletAddress && item.accountIndex !== undefined)
      .map(item => item.accountIndex!));
    for (const index of ownedIndices) {
      if (index === walletIndex || !safeLamports(preLamports[index]) || !safeLamports(postLamports[index])) return null;
      const change = BigInt(postLamports[index]) - BigInt(preLamports[index]);
      const wrapped = [...pre, ...post].some(item => item.accountIndex === index && item.mint === SOL_MINT);
      if (!wrapped && change !== 0n) {
        const account = accountKeyPubkey(accountKeys[index]);
        const transfers = [...tx.transaction?.message?.instructions ?? [],
          ...(tx.meta?.innerInstructions ?? []).flatMap(group => group.instructions ?? [])];
        const attributable = transfers.some(ix => {
          if (ix.program === 'system' || ix.programId === SYSTEM_PROGRAM_ID) {
            const amount = ix.parsed?.info?.lamports;
            if (typeof amount === 'number' && (!Number.isSafeInteger(amount) || amount < 0)) return false;
            if (typeof amount !== 'number' && (typeof amount !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(amount))) return false;
            return ix.parsed?.type === 'transfer' && ix.parsed.info?.source === walletAddress
              && ix.parsed.info?.destination === account && BigInt(amount) === change;
          }
          return ix.parsed?.type === 'closeAccount' && ix.parsed.info?.source === account
            && ix.parsed.info?.destination === walletAddress;
        });
        if (!attributable) return null;
      }
      nativeDelta += change;
    }
    const wrappedDelta = balances.get(SOL_MINT);
    if (wrappedDelta) nativeDelta -= wrappedDelta.post - wrappedDelta.pre;
    // The fee payer is always account index 0; add the fee back so it doesn't
    // count as SOL spent on the swap.
    if (walletIndex === 0) {
      if (tx.meta?.fee === undefined) return null;
      nativeDelta += BigInt(tx.meta.fee);
    }
    if (nativeDelta !== 0n) {
      const current = balances.get(SOL_MINT) ?? { pre: 0n, post: 0n };
      // Fold the native delta into the existing SOL entry (covers wrapped-SOL too).
      balances.set(SOL_MINT, { pre: current.pre, post: current.post + nativeDelta });
    }
  }

  const deltas = Array.from(balances.entries())
    .map(([mint, value]) => ({ mint, delta: value.post - value.pre }))
    .filter((e) => e.delta !== 0n);

  if (deltas.length !== 2) return null;

  const tokenIn = deltas.find(e => e.delta < 0n);
  const tokenOut = deltas.find(e => e.delta > 0n);
  if (!tokenIn || !tokenOut) return null;

  const inputIsQuote = QUOTE_MINTS.has(tokenIn.mint);
  const outputIsQuote = QUOTE_MINTS.has(tokenOut.mint);
  // Quote-to-quote conversions do not establish or exit a tracked position.
  if (inputIsQuote && outputIsQuote) return null;
  // Without an explicit target-token hint, a supported non-quote route is the
  // disposal of tokenIn. This fails safer than fabricating an entry in tokenOut.
  const direction: 'buy' | 'sell' = inputIsQuote ? 'buy' : 'sell';
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

export type CanonicalSolanaSwapEvent = {
  chain: 'solana';
  transactionIdentity: string;
  slot: number | null;
  walletAddress: string;
  occurredAt: Date;
  direction: 'buy' | 'sell';
  targetToken: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
};

const SWAP_INSTRUCTIONS = new Map<string, string[]>([
  ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', []],
  ['CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', ['swap', 'swap_v2']],
  ['whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', ['swap', 'swap_v2']],
  ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', ['route', 'route_with_token_ledger', 'shared_accounts_route', 'shared_accounts_route_with_token_ledger', 'exact_out_route', 'shared_accounts_exact_out_route']],
  ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', ['buy', 'sell', 'buy_exact_sol_in']],
  ['LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', ['swap', 'swap_exact_out', 'swap_with_price_impact', 'swap2', 'swap_exact_out2', 'swap_with_price_impact2']]
]);
export const SWAP_PROGRAM_IDS: ReadonlySet<string> = new Set(SWAP_INSTRUCTIONS.keys());

function instructionBytes(data: string | undefined): Buffer | null {
  if (!data || data.length > 4096) return null;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = 0n;
  for (const char of data) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const hex = value.toString(16);
  const body = value === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  return Buffer.concat([Buffer.alloc(data.match(/^1*/)?.[0].length ?? 0), body]);
}

export function decodeTransferInstruction(ix: HeliusParsedInstruction): HeliusParsedInstruction {
  if (ix.parsed) return ix;
  const bytes = instructionBytes(ix.data);
  const accounts = ix.accounts;
  if (!bytes || !accounts) return ix;
  if (ix.programId === SYSTEM_PROGRAM_ID && bytes.length === 12 && bytes.readUInt32LE(0) === 2 && accounts.length >= 2) {
    return { ...ix, parsed: { type: 'transfer', info: {
      source: accounts[0], destination: accounts[1], lamports: bytes.readBigUInt64LE(4).toString()
    } } };
  }
  if (!['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(ix.programId ?? '')) return ix;
  if (bytes.length === 9 && bytes[0] === 3 && accounts.length >= 3) {
    return { ...ix, parsed: { type: 'transfer', info: {
      source: accounts[0], destination: accounts[1], amount: bytes.readBigUInt64LE(1).toString()
    } } };
  }
  if (bytes.length === 10 && bytes[0] === 12 && accounts.length >= 4) {
    return { ...ix, parsed: { type: 'transferChecked', info: {
      source: accounts[0], destination: accounts[2], tokenAmount: { amount: bytes.readBigUInt64LE(1).toString() }
    } } };
  }
  return ix;
}

export function findWalletSwapInstruction(tx: HeliusParsedTransaction, walletAddress: string): HeliusParsedInstruction | null {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const changedAccounts = new Map<number, bigint>();
  for (const [sign, items] of [[-1n, tx.meta?.preTokenBalances ?? []], [1n, tx.meta?.postTokenBalances ?? []]] as const) {
    for (const item of items) {
      if (item.owner !== walletAddress) continue;
      if (!Number.isSafeInteger(item.accountIndex) || item.accountIndex! < 0
          || typeof item.uiTokenAmount?.amount !== 'string'
          || !/^(0|[1-9][0-9]{0,19})$/.test(item.uiTokenAmount.amount)) return null;
      const index = item.accountIndex!;
      changedAccounts.set(index, (changedAccounts.get(index) ?? 0n) + sign * BigInt(item.uiTokenAmount.amount));
    }
  }
  const ownedAccounts = [...changedAccounts].filter(([, delta]) => delta !== 0n)
    .map(([index]) => accountKeyPubkey(keys[index]));
  if (!ownedAccounts.length || ownedAccounts.some(account => !account)) return null;
  const instructions = [...tx.transaction?.message?.instructions ?? [],
    ...(tx.meta?.innerInstructions ?? []).flatMap(group => group.instructions ?? [])];
  for (const ix of instructions) {
    const names = SWAP_INSTRUCTIONS.get(ix.programId ?? '');
    if (!names || !ix.accounts?.includes(walletAddress)
        || !ownedAccounts.every(account => ix.accounts!.includes(account!))) continue;
    const bytes = instructionBytes(ix.data);
    if (!bytes) continue;
    if (names.length === 0) {
      if (bytes.length === 17 && (bytes[0] === 9 || bytes[0] === 11)) return ix;
    } else if (bytes.length > 8 && names.some(name =>
      bytes.subarray(0, 8).equals(createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)))) {
      return ix;
    }
  }
  return null;
}

function swapTokenFlowsMatch(tx: HeliusParsedTransaction, walletAddress: string, swap: HeliusParsedInstruction): boolean {
  const top = tx.transaction?.message?.instructions ?? [];
  const index = top.indexOf(swap);
  // Nested supported programs require a decoded invocation boundary, not all CPIs
  // from an unrelated outer instruction.
  if (index < 0) return false;
  const group = tx.meta?.innerInstructions?.find(item => item.index === index);
  if (!group?.instructions) return false;
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const expected = new Map<string, bigint>();
  for (const [sign, items] of [[-1n, tx.meta?.preTokenBalances ?? []], [1n, tx.meta?.postTokenBalances ?? []]] as const) {
    for (const item of items) {
      if (item.owner !== walletAddress || item.accountIndex === undefined) continue;
      const account = accountKeyPubkey(keys[item.accountIndex]);
      if (!account) return false;
      expected.set(account, (expected.get(account) ?? 0n) + sign * BigInt(item.uiTokenAmount!.amount!));
    }
  }
  const observed = new Map<string, bigint>();
  for (const ix of group.instructions) {
    if (!['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(ix.programId ?? '')
        && !(!ix.programId && ['spl-token', 'spl-token-2022'].includes(ix.program ?? ''))) continue;
    if (!['transfer', 'transferChecked'].includes(ix.parsed?.type ?? '')) continue;
    const info = ix.parsed?.info;
    const amount = info?.amount ?? info?.tokenAmount?.amount;
    if (!info?.source || !info.destination || typeof amount !== 'string'
        || !/^(0|[1-9][0-9]{0,19})$/.test(amount) || BigInt(amount) > 18446744073709551615n) return false;
    for (const [account, sign] of [[info.source, -1n], [info.destination, 1n]] as const) {
      if (expected.has(account)) observed.set(account, (observed.get(account) ?? 0n) + sign * BigInt(amount));
    }
  }
  return [...expected].every(([account, amount]) => (observed.get(account) ?? 0n) === amount);
}

function swapNativeFlowsMatch(tx: HeliusParsedTransaction, walletAddress: string, swap: HeliusParsedInstruction): boolean {
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const walletIndex = keys.findIndex(key => accountKeyPubkey(key) === walletAddress);
  const ownedIndices = new Set([walletIndex, ...[...tx.meta?.preTokenBalances ?? [], ...tx.meta?.postTokenBalances ?? []]
    .filter(item => item.owner === walletAddress).map(item => item.accountIndex!)]);
  const custody = new Set<string>();
  let expected = 0n;
  for (const index of ownedIndices) {
    const account = accountKeyPubkey(keys[index]);
    const pre = tx.meta?.preBalances?.[index];
    const post = tx.meta?.postBalances?.[index];
    if (!account || !Number.isSafeInteger(pre) || pre! < 0 || !Number.isSafeInteger(post) || post! < 0) return false;
    custody.add(account);
    expected += BigInt(post!) - BigInt(pre!);
  }
  if (!Number.isSafeInteger(tx.meta?.fee) || tx.meta!.fee! < 0) return false;
  if (walletIndex === 0) expected += BigInt(tx.meta!.fee!);
  const wrappedAccounts = new Set([...tx.meta?.preTokenBalances ?? [], ...tx.meta?.postTokenBalances ?? []]
    .filter(item => item.mint === SOL_MINT).map(item => accountKeyPubkey(keys[item.accountIndex!])));
  const index = (tx.transaction?.message?.instructions ?? []).indexOf(swap);
  const group = tx.meta?.innerInstructions?.find(item => item.index === index);
  if (index < 0 || !group?.instructions) return false;
  let observed = 0n;
  for (const ix of group.instructions) {
    const info = ix.parsed?.info;
    const system = ix.programId === SYSTEM_PROGRAM_ID || (!ix.programId && ix.program === 'system');
    const token = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(ix.programId ?? '')
      || (!ix.programId && ['spl-token', 'spl-token-2022'].includes(ix.program ?? ''));
    if (!info || (!custody.has(info.source ?? '') && !custody.has(info.destination ?? ''))) continue;
    const type = ix.parsed?.type;
    if (!(system && type === 'transfer') && !(token && ['transfer', 'transferChecked'].includes(type ?? '')
      && (wrappedAccounts.has(info.source) || wrappedAccounts.has(info.destination)))) continue;
    const raw = system ? info.lamports : info.amount ?? info.tokenAmount?.amount;
    const amount = typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw;
    if (!info.source || !info.destination || typeof amount !== 'string'
        || !/^(0|[1-9][0-9]{0,19})$/.test(amount) || BigInt(amount) > 18446744073709551615n) return false;
    if (custody.has(info.source)) observed -= BigInt(amount);
    if (custody.has(info.destination)) observed += BigInt(amount);
  }
  return observed === expected;
}

export function parseCanonicalSolanaSwapEvent(
  tx: HeliusParsedTransaction,
  walletAddress: string
): CanonicalSolanaSwapEvent | null {
  const instruction = findWalletSwapInstruction(tx, walletAddress);
  if (tx.meta?.err !== null || !instruction || !swapTokenFlowsMatch(tx, walletAddress, instruction)
      || !swapNativeFlowsMatch(tx, walletAddress, instruction)) return null;
  const keys = tx.transaction?.message?.accountKeys ?? [];
  const walletIndex = keys.findIndex(key => accountKeyPubkey(key) === walletAddress);
  if (walletIndex < 0 || !Number.isSafeInteger(tx.meta.fee) || tx.meta.fee! < 0
      || !Number.isSafeInteger(tx.meta.preBalances?.[walletIndex])
      || !Number.isSafeInteger(tx.meta.postBalances?.[walletIndex])) return null;
  const transactionIdentity = tx.transaction?.signatures?.[0];
  const blockTime = tx.blockTime;
  if (
    typeof transactionIdentity !== 'string'
    || transactionIdentity.length === 0
    || typeof blockTime !== 'number'
    || !Number.isSafeInteger(blockTime)
    || blockTime <= 0
    || !Number.isFinite(new Date(blockTime * 1000).getTime())
  ) {
    return null;
  }

  const swap = getWalletTokenDeltas(tx, walletAddress);
  if (!swap) return null;

  return {
    chain: 'solana',
    transactionIdentity,
    slot: Number.isInteger(tx.slot) && (tx.slot ?? -1) >= 0 ? tx.slot! : null,
    walletAddress,
    occurredAt: new Date(blockTime * 1000),
    ...swap
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
