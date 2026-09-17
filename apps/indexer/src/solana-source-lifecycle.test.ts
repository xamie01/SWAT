import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  insertParsedTransaction,
  recordSourceTradeEvent,
  updateTokenLaunchTimestamp,
  upsertToken
} from '@swat/db';
import { USDC_MINT, type HeliusParsedTransaction } from './parse.js';

const mocks = vi.hoisted(() => ({
  fetchTokenPriceUsd: vi.fn(),
  publish: vi.fn(),
  redisGet: vi.fn(),
  redisSetex: vi.fn()
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = vi.fn();
  },
  Worker: class {
    on() {
      return this;
    }
  }
}));

vi.mock('ioredis', () => ({
  Redis: class {
    get(key: string) {
      return mocks.redisGet(key);
    }

    setex(key: string, ttl: number, value: string) {
      return mocks.redisSetex(key, ttl, value);
    }

    publish(channel: string, message: string) {
      return mocks.publish(channel, message);
    }
  }
}));

vi.mock('@swat/db', () => ({
  getTokenDecimals: vi.fn(),
  insertParsedTransaction: vi.fn(),
  logDiscoveryRun: vi.fn(),
  recordFundingEdge: vi.fn(),
  recordIngestionBatch: vi.fn(),
  recordSourceTradeEvent: vi.fn(),
  refreshWalletActivity: vi.fn(),
  updateTokenLaunchTimestamp: vi.fn(),
  upsertToken: vi.fn(),
  upsertWallet: vi.fn(),
  // Booting `index.ts` starts the Polymarket book feed, which seeds its
  // subscription set from here. A missing export does not read as `undefined` --
  // it THROWS, and the throw lands in the seed's own `.catch`, so the feed would
  // silently run its failure branch while this suite still went green.
  loadPolymarketBookSubscriptionSet: vi.fn(async () => ({
    tokenIds: [],
    evicted: 0,
    counts: { recentTrade: 0, openPosition: 0 }
  }))
}));

vi.mock('@swat/shared', async (importOriginal) => ({
  ...await importOriginal<typeof import('@swat/shared')>(),
  fetchTokenPriceUsd: mocks.fetchTokenPriceUsd,
  initLogger: vi.fn()
}));

vi.mock('./evm.js', () => ({
  backfillEvmWallet: vi.fn()
}));

vi.mock('./polymarket.js', () => ({
  backfillPolymarketWallet: vi.fn(),
  pollPolymarketResolutions: vi.fn(async () => undefined)
}));

const wallet = '11111111111111111111111111111111';
const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const signature = 'solana-lifecycle-signature';

function confirmedBuy(): HeliusParsedTransaction {
  return {
    slot: 351_000_000,
    blockTime: 1_760_000_000,
    transaction: {
      signatures: [signature],
      message: { accountKeys: [wallet], instructions: [] }
    },
    meta: {
      fee: 5_000,
      preBalances: [1_000_000],
      postBalances: [995_000],
      preTokenBalances: [
        { owner: wallet, mint: USDC_MINT, uiTokenAmount: { amount: '25000000' } },
        { owner: wallet, mint: token, uiTokenAmount: { amount: '0' } }
      ],
      postTokenBalances: [
        { owner: wallet, mint: USDC_MINT, uiTokenAmount: { amount: '0' } },
        { owner: wallet, mint: token, uiTokenAmount: { amount: '5000000' } }
      ]
    }
  };
}

let processTransaction: typeof import('./index.js').processTransaction;
let backfillWallet: typeof import('./index.js').backfillWallet;
let intervalSpy: ReturnType<typeof vi.spyOn>;

describe('Solana source lifecycle ingestion', () => {
  beforeAll(async () => {
    vi.stubEnv('HELIUS_API_KEY', 'test-helius-key');
    vi.stubEnv('WALLET_ADDRESSES', '');
    intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as never);
    ({ backfillWallet, processTransaction } = await import('./index.js'));
  });

  afterAll(() => {
    intervalSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(upsertToken).mockResolvedValue();
    vi.mocked(insertParsedTransaction).mockResolvedValue(true);
    vi.mocked(updateTokenLaunchTimestamp).mockResolvedValue();
    vi.mocked(recordSourceTradeEvent).mockResolvedValue({
      event: { id: 'source-solana-1' }
    } as Awaited<ReturnType<typeof recordSourceTradeEvent>>);
    mocks.redisGet.mockResolvedValue(null);
    mocks.redisSetex.mockResolvedValue('OK');
    mocks.fetchTokenPriceUsd.mockResolvedValue(null);
    mocks.publish.mockResolvedValue(1);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      result: { value: null }
    }), { status: 200 })));
  });

  it('converges webhook and backfill observations on one immutable BUY event', async () => {
    await expect(processTransaction(confirmedBuy(), wallet, 'solana-backfill'))
      .resolves.toBe('inserted');
    vi.mocked(insertParsedTransaction).mockResolvedValueOnce(false);
    await expect(processTransaction(confirmedBuy(), wallet, 'solana-webhook'))
      .resolves.toBe('skipped');

    expect(recordSourceTradeEvent).toHaveBeenCalledTimes(2);
    const [backfillInput] = vi.mocked(recordSourceTradeEvent).mock.calls[0]!;
    const [webhookInput] = vi.mocked(recordSourceTradeEvent).mock.calls[1]!;
    const {
      confirmationEvidenceId: _backfillEvidence,
      ...backfillPayload
    } = backfillInput;
    const {
      confirmationEvidenceId: _webhookEvidence,
      ...webhookPayload
    } = webhookInput;
    expect(webhookPayload).toEqual(backfillPayload);
    expect(backfillPayload).toMatchObject({
      chain: 'solana',
      sourceEventId: signature,
      walletAddress: wallet,
      tokenMint: token,
      side: 'buy',
      quantity: '5000000',
      amountUsd: '25',
      confirmationState: 'confirmed'
    });
  });

  it('creates no lifecycle event for a rejected Solana row', async () => {
    const rejected = confirmedBuy();
    rejected.transaction!.signatures = [];

    await expect(processTransaction(rejected, wallet, 'solana-webhook'))
      .resolves.toBe('skipped');

    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
  });

  it('propagates lifecycle failure before downstream publication and enrichment', async () => {
    vi.mocked(recordSourceTradeEvent).mockRejectedValueOnce(
      new Error('canonical lifecycle unavailable')
    );

    await expect(processTransaction(confirmedBuy(), wallet, 'solana-backfill'))
      .rejects.toThrow('canonical lifecycle unavailable');

    expect(mocks.publish).not.toHaveBeenCalled();
    expect(updateTokenLaunchTimestamp).not.toHaveBeenCalled();
  });

  it('fails a backfill batch when canonical lifecycle persistence fails', async () => {
    vi.mocked(recordSourceTradeEvent).mockRejectedValueOnce(
      new Error('canonical lifecycle unavailable')
    );
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result = request.method === 'getSignaturesForAddress'
        ? [{ signature, slot: 351_000_000, blockTime: 1_760_000_000 }]
        : request.method === 'getTransaction'
          ? confirmedBuy()
          : { value: null };
      return new Response(JSON.stringify({ result }), { status: 200 });
    });

    await expect(backfillWallet(wallet)).rejects.toMatchObject({
      name: 'IngestionBatchError',
      result: { fetched: 1, inserted: 0, skipped: 0, failed: 1 }
    });

    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
