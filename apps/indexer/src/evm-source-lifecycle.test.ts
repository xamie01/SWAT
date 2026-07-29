import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  type Hex
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  insertParsedTransaction,
  query,
  recordSourceTradeEvent,
  refreshWalletActivity,
  updateTokenLaunchTimestamp,
  upsertToken
} from '@swat/db';
import { backfillEvmWallet } from './evm.js';

const mocks = vi.hoisted(() => ({
  fetchTokenPriceUsd: vi.fn(),
  publish: vi.fn()
}));

vi.mock('@swat/db', () => ({
  insertParsedTransaction: vi.fn(),
  query: vi.fn(),
  recordSourceTradeEvent: vi.fn(),
  refreshWalletActivity: vi.fn(),
  updateTokenLaunchTimestamp: vi.fn(),
  upsertToken: vi.fn()
}));

vi.mock('@swat/shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('@swat/shared')>(),
  fetchTokenPriceUsd: mocks.fetchTokenPriceUsd
}));

vi.mock('ioredis', () => ({
  Redis: class {
    publish(channel: string, message: string) {
      return mocks.publish(channel, message);
    }
  }
}));

const wallet = '0x1000000000000000000000000000000000000001';
const router = '0x2000000000000000000000000000000000000002';
const pool = '0x3000000000000000000000000000000000000003';
const base = '0x4000000000000000000000000000000000000004';
const token = '0x5000000000000000000000000000000000000005';
const transactionHash = `0x${'a'.repeat(64)}` as Hex;
const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);
const swapEvent = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'
);

function receiptTransfer(from: string, to: string, value: bigint, logIndex: number) {
  return {
    address: token,
    topics: encodeEventTopics({
      abi: [transferEvent],
      eventName: 'Transfer',
      args: { from, to }
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    logIndex,
    transactionHash
  };
}

function receiptSwap(amount0: bigint, amount1: bigint) {
  return {
    address: pool,
    topics: encodeEventTopics({
      abi: [swapEvent],
      eventName: 'Swap',
      args: { sender: router, recipient: wallet }
    }),
    data: encodeAbiParameters([
      { type: 'int256' },
      { type: 'int256' },
      { type: 'uint160' },
      { type: 'uint128' },
      { type: 'int24' }
    ], [amount0, amount1, 1n, 1n, 0]),
    logIndex: 1,
    transactionHash
  };
}

function parsedTransfer(from: string, to: string, value: bigint) {
  return {
    address: token,
    transactionHash,
    logIndex: 2,
    blockNumber: 10n,
    transactionIndex: 0,
    args: { from, to, value }
  };
}

function clientFor(
  direction: 'buy' | 'sell' | 'rejected',
  walletTargetQuantity?: bigint
) {
  const targetQuantity = walletTargetQuantity ?? (direction === 'sell' ? 4_000n : 5_000n);
  const transfer = direction === 'buy'
    ? parsedTransfer(pool, wallet, targetQuantity)
    : parsedTransfer(wallet, pool, targetQuantity);
  const receiptLogs = direction === 'buy'
    ? [receiptSwap(1_000n, -5_000n), receiptTransfer(pool, wallet, targetQuantity, 2)]
    : direction === 'sell'
      ? [receiptSwap(-800n, 4_000n), receiptTransfer(wallet, pool, targetQuantity, 2)]
      : [receiptTransfer(pool, wallet, targetQuantity, 2)];

  return {
    getBlockNumber: vi.fn(async () => 10n),
    getLogs: vi.fn(async (input: { args?: { from?: string; to?: string } }) => {
      if (direction === 'buy') return input.args?.to ? [transfer] : [];
      return input.args?.from ? [transfer] : [];
    }),
    getBlock: vi.fn(async () => ({ timestamp: 1_760_000_000n })),
    getTransactionReceipt: vi.fn(async () => ({
      status: 'success' as const,
      from: wallet,
      to: router,
      logs: receiptLogs
    })),
    readContract: vi.fn(async (input: { functionName: string }) => {
      if (input.functionName === 'decimals') return 6;
      if (input.functionName === 'symbol') return 'TOKEN';
      return 'Fixture Token';
    })
  };
}

describe('Robinhood backfill source lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('EVM_BACKFILL_BLOCKS', '0');
    vi.stubEnv('EVM_LOG_CHUNK_SIZE', '2000');
    vi.stubEnv('ROBINHOOD_INGESTION_ROUTERS', router);
    vi.stubEnv('ROBINHOOD_BASE_ASSET', base);
    vi.stubEnv('ROBINHOOD_REVIEWED_POOLS_JSON', JSON.stringify([
      { address: pool, token0: base, token1: token }
    ]));
    vi.mocked(query).mockResolvedValue([]);
    vi.mocked(upsertToken).mockResolvedValue();
    vi.mocked(insertParsedTransaction).mockResolvedValue(true);
    vi.mocked(updateTokenLaunchTimestamp).mockResolvedValue();
    vi.mocked(refreshWalletActivity).mockResolvedValue();
    vi.mocked(recordSourceTradeEvent).mockResolvedValue({
      event: { id: 'source-robinhood-1' }
    } as Awaited<ReturnType<typeof recordSourceTradeEvent>>);
    mocks.fetchTokenPriceUsd.mockResolvedValue(null);
    mocks.publish.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['buy', '5000'],
    ['sell', '4000']
  ] as const)('persists a reviewed confirmed %s with exact target quantity', async (direction, quantity) => {
    const result = await backfillEvmWallet(wallet, 'robinhood-chain', {
      client: clientFor(direction) as never
    });

    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      chain: 'robinhood-chain',
      sourceEventType: 'transaction',
      sourceEventId: transactionHash,
      walletAddress: wallet,
      tokenMint: token,
      side: direction,
      quantity,
      confirmationState: 'confirmed'
    }));
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('source-robinhood-1')
    );
    expect(result).toMatchObject({ fetched: 1, inserted: 1, skipped: 0, failed: 0 });
  });

  it('uses the wallet target-token transfer when it differs from the pool delta', async () => {
    const result = await backfillEvmWallet(wallet, 'robinhood-chain', {
      client: clientFor('buy', 4_900n) as never
    });

    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      side: 'buy',
      quantity: '4900'
    }));
    expect(result).toMatchObject({ fetched: 1, inserted: 1, skipped: 0, failed: 0 });
  });

  it('creates no source event for a rejected receipt', async () => {
    const result = await backfillEvmWallet(wallet, 'robinhood-chain', {
      client: clientFor('rejected') as never
    });

    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 1, failed: 0 });
  });

  it('repairs lifecycle persistence when the legacy transaction is already present', async () => {
    vi.mocked(insertParsedTransaction).mockResolvedValueOnce(false);

    const result = await backfillEvmWallet(wallet, 'robinhood-chain', {
      client: clientFor('buy') as never
    });

    expect(recordSourceTradeEvent).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 1, failed: 0 });
  });

  it('fails the batch when lifecycle persistence fails without publishing the swap', async () => {
    vi.mocked(recordSourceTradeEvent).mockRejectedValueOnce(
      new Error('canonical lifecycle unavailable')
    );

    await expect(backfillEvmWallet(wallet, 'robinhood-chain', {
      client: clientFor('buy') as never
    })).rejects.toMatchObject({
      name: 'IngestionBatchError',
      result: { fetched: 1, inserted: 0, skipped: 0, failed: 1 }
    });

    expect(recordSourceTradeEvent).toHaveBeenCalledOnce();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
