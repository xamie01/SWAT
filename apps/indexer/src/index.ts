import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { insertParsedTransaction, refreshWalletActivity, upsertToken, upsertWallet } from '@swat/db';
import { REDIS_CHANNELS, walletInputSchema } from '@swat/shared';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SWAP_PROGRAM_IDS = new Set([
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo' // Meteora DLMM
]);
const heliusApiKey = process.env.HELIUS_API_KEY;
const heliusRpcUrl = heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}` : null;

const backfillQueue = new Queue('swat:backfill-wallet', { connection: redis });

export async function ingestWallets(input: Array<{ address: string; source?: 'shiller' | 'manual' | 'discovered'; nickname?: string }>) {
  const parsed = input.map((wallet) => walletInputSchema.safeParse(wallet));
  const valid = parsed.filter((p): p is { success: true; data: { address: string; source: 'shiller' | 'manual' | 'discovered'; nickname?: string } } => p.success).map((p) => p.data);

  for (const wallet of valid) {
    await upsertWallet(wallet);
    await backfillQueue.add('backfill-wallet', { address: wallet.address }, { jobId: `backfill:${wallet.address}`, removeOnComplete: true, removeOnFail: 1000 });
  }

  return { accepted: valid.length, rejected: parsed.length - valid.length };
}

type HeliusSignature = {
  signature: string;
  slot: number;
  blockTime?: number;
};

type HeliusTokenBalance = {
  owner?: string;
  mint: string;
  uiTokenAmount?: {
    amount?: string;
  };
};

type HeliusParsedTransaction = {
  slot?: number;
  blockTime?: number;
  transaction?: {
    signatures?: string[];
    message?: {
      instructions?: Array<{
        programId?: string;
      }>;
    };
  };
  meta?: {
    preTokenBalances?: HeliusTokenBalance[];
    postTokenBalances?: HeliusTokenBalance[];
  };
};

function extractProgramId(tx: HeliusParsedTransaction): string | null {
  const instructions = tx.transaction?.message?.instructions ?? [];
  const ids = instructions
    .map((instruction) => instruction.programId)
    .filter((programId): programId is string => typeof programId === 'string');

  const matchedSwapProgram = ids.find((programId) => SWAP_PROGRAM_IDS.has(programId));
  return matchedSwapProgram ?? ids[0] ?? null;
}

async function heliusRpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!heliusRpcUrl) {
    throw new Error('HELIUS_API_KEY is not set');
  }

  const response = await fetch(heliusRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`Helius RPC failed: ${response.status}`);
  }

  const json = (await response.json()) as { result?: T; error?: { message?: string } };
  if (json.error) {
    throw new Error(`Helius RPC error (${method}): ${json.error.message ?? 'unknown error'}`);
  }

  return json.result as T;
}

function getWalletTokenDeltas(tx: HeliusParsedTransaction, walletAddress: string) {
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
    .filter((entry) => entry.delta !== 0n);

  if (deltas.length < 2) return null;

  const negatives = deltas.filter((entry) => entry.delta < 0n);
  const positives = deltas.filter((entry) => entry.delta > 0n);
  if (negatives.length === 0 || positives.length === 0) return null;

  const tokenIn = negatives.reduce((min, current) => (current.delta < min.delta ? current : min));
  const tokenOut = positives.reduce((max, current) => (current.delta > max.delta ? current : max));

  if (!tokenIn || !tokenOut) return null;

  const direction: 'buy' | 'sell' = tokenIn.mint === SOL_MINT ? 'buy' : tokenOut.mint === SOL_MINT ? 'sell' : 'buy';
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

async function backfillWallet(address: string) {
  if (!heliusRpcUrl) {
    console.warn('[indexer] skipping backfill: HELIUS_API_KEY is not set');
    return { fetched: 0, inserted: 0, skipped: 0 };
  }

  const signatures = await heliusRpc<HeliusSignature[]>('getSignaturesForAddress', [address, { limit: 1000 }]);
  if (signatures.length === 0) {
    await refreshWalletActivity(address, null, 0);
    return { fetched: 0, inserted: 0, skipped: 0 };
  }

  const signatureList = signatures.map((item) => item.signature);
  const txs = await heliusRpc<Array<HeliusParsedTransaction | null>>('getParsedTransactions', [
    signatureList,
    { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }
  ]);

  let inserted = 0;
  let skipped = 0;
  let latestBlockTime: number | null = null;

  for (const tx of txs) {
    if (!tx) continue;
    const parsed = getWalletTokenDeltas(tx, address);
    if (!parsed) {
      skipped += 1;
      continue;
    }

    const signature = tx.transaction?.signatures?.[0];
    if (!signature) {
      skipped += 1;
      continue;
    }

    if (!tx.blockTime) {
      skipped += 1;
      continue;
    }

    await Promise.all([upsertToken(parsed.tokenIn), upsertToken(parsed.tokenOut)]);

    const blockTime = tx.blockTime;
    const timestamp = new Date(blockTime * 1000);
    const persisted = await insertParsedTransaction({
      signature,
      walletAddress: address,
      tokenIn: parsed.tokenIn,
      tokenOut: parsed.tokenOut,
      amountIn: parsed.amountIn,
      amountOut: parsed.amountOut,
      direction: parsed.direction,
      targetToken: parsed.targetToken,
      programId: extractProgramId(tx),
      slot: tx.slot ?? null,
      timestamp,
      blockTime
    });

    if (!persisted) continue;

    inserted += 1;
    if (!latestBlockTime || blockTime > latestBlockTime) {
      latestBlockTime = blockTime;
    }

    await redis.publish(
      REDIS_CHANNELS.walletSwap,
      JSON.stringify({
        walletAddress: address,
        signature,
        direction: parsed.direction,
        targetToken: parsed.targetToken,
        timestamp: timestamp.toISOString()
      })
    );
  }

  await refreshWalletActivity(address, latestBlockTime ? new Date(latestBlockTime * 1000) : null, inserted);
  return { fetched: signatureList.length, inserted, skipped };
}

new Worker(
  'swat:backfill-wallet',
  async (job) => {
    const address = (job.data as { address: string }).address;
    console.log(`[indexer] backfill started for ${address}`);
    const result = await backfillWallet(address);
    return { address, ...result };
  },
  { connection: redis }
);

const fromEnv = (process.env.WALLET_ADDRESSES ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((address) => ({ address, source: 'manual' as const }));

if (fromEnv.length > 0) {
  ingestWallets(fromEnv)
    .then((result) => console.log(`[indexer] ingestion result`, result))
    .catch((error) => {
      console.error('[indexer] ingestion failed', error);
      process.exit(1);
    });
}

console.log('[indexer] service running');
