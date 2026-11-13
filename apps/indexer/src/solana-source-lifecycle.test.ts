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

vi.mock('./polymarket-book-runtime.js', () => ({
  createPolymarketBookRuntimeOnRedis: vi.fn(() => ({
    start: vi.fn(), stop: vi.fn(), subscriber: { subscribe: vi.fn() }
  }))
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
      message: { accountKeys: [wallet, 'quote-account', 'target-account'], instructions: [{
        programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        accounts: [wallet, 'quote-account', 'target-account'], data: '63UCE4emmE3VCoXST22eKm9'
      }] }
    },
    meta: {
      err: null,
      innerInstructions: [{ index: 0, instructions: [
        { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'quote-account', destination: 'pool-quote', amount: '25000000' } } },
        { program: 'spl-token', parsed: { type: 'transfer', info: { source: 'pool-target', destination: 'target-account', amount: '5000000' } } }
      ] }],
      fee: 5_000,
      preBalances: [1_000_000, 0, 0],
      postBalances: [995_000, 0, 0],
      preTokenBalances: [
        { accountIndex: 1, owner: wallet, mint: USDC_MINT, uiTokenAmount: { amount: '25000000' } },
        { accountIndex: 2, owner: wallet, mint: token, uiTokenAmount: { amount: '0' } }
      ],
      postTokenBalances: [
        { accountIndex: 1, owner: wallet, mint: USDC_MINT, uiTokenAmount: { amount: '0' } },
        { accountIndex: 2, owner: wallet, mint: token, uiTokenAmount: { amount: '5000000' } }
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

  it.each(['solana-backfill', 'solana-webhook'] as const)('quarantines %s observations before accepted-trade writes and enrichment', async (source) => {
    await expect(processTransaction(confirmedBuy(), wallet, source)).resolves.toBe('skipped');
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      confirmationState: 'observed', quantity: '5000000'
    }));
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(upsertToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.fetchTokenPriceUsd).not.toHaveBeenCalled();
    expect(updateTokenLaunchTimestamp).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('reports quarantine without changing the public legacy result string', async () => {
    const outcome = vi.fn();
    await expect(processTransaction(confirmedBuy(), wallet, 'solana-backfill', outcome))
      .resolves.toBe('skipped');
    expect(outcome).toHaveBeenCalledExactlyOnceWith('quarantined');
    expect(upsertToken).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('converges webhook and backfill observations on one immutable BUY event', async () => {
    await expect(processTransaction(confirmedBuy(), wallet, 'solana-backfill'))
      .resolves.toBe('skipped');
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
      confirmationState: 'observed'
    });
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it.each(['failed', 'missing-result', 'unrelated-program', 'multiple-legs'])('persists and publishes nothing for %s observations', async (kind) => {
    const rejected = confirmedBuy();
    if (kind === 'failed') rejected.meta!.err = { InstructionError: [0, 'Custom'] };
    if (kind === 'missing-result') delete rejected.meta!.err;
    if (kind === 'unrelated-program') rejected.transaction!.message!.instructions = [];
    if (kind === 'multiple-legs') rejected.meta!.postTokenBalances!.push({
      accountIndex: 2, owner: wallet, mint: 'unrelated', uiTokenAmount: { amount: '100' }
    });
    await expect(processTransaction(rejected, wallet, 'solana-webhook')).resolves.toBe('skipped');
    expect(recordSourceTradeEvent).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(upsertToken).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
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

  it.each(['observation', 'null-transaction', 'capped'] as const)('reports %s backfill evidence without certifying history or finality', async (kind) => {
    vi.stubEnv('BACKFILL_SIGNATURE_LIMIT', kind === 'capped' ? '1' : '1000');
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result = request.method === 'getSignaturesForAddress'
        ? [{ signature, slot: 351_000_000, blockTime: 1_760_000_000 }]
        : kind === 'null-transaction' ? null : confirmedBuy();
      return new Response(JSON.stringify({ result }), { status: 200 });
    });
    const result = await backfillWallet(wallet);
    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 1, failed: 0,
      evidence: {
        observed: kind === 'null-transaction' ? 0 : 1,
        quarantined: kind === 'null-transaction' ? 0 : 1,
        accepted: 0, confirmation: 'withheld', scope: 'requested-window',
        completeness: kind === 'observation' ? 'unknown' : 'partial'
      }
    });
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
