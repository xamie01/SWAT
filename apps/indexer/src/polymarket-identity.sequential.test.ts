import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPolymarketOutcomeContext,
  insertParsedTransaction,
  recordConfirmedPolymarketTrade,
  recordSourceTradeEvent,
  refreshWalletActivity,
  type SourceTradeEventInput
} from '@swat/db';
import { backfillPolymarketWallet } from './polymarket.js';
import { buildPolymarketSourceTradeInput } from './source-trade-lifecycle.js';
import { parseConfirmedPolymarketTrade } from './polymarket-helpers.js';

vi.mock('@swat/db', async (importOriginal) => ({
  multiplyDecimalText: (await importOriginal<typeof import('@swat/db')>()).multiplyDecimalText,
  getPolymarketMarket: vi.fn(), getPolymarketOutcomeContext: vi.fn(),
  insertParsedTransaction: vi.fn(), query: vi.fn(), recordSourceTradeEvent: vi.fn(),
  recordConfirmedPolymarketTrade: vi.fn(), refreshWalletActivity: vi.fn(),
  upsertPolymarketContext: vi.fn(), upsertToken: vi.fn(), upsertWallet: vi.fn()
}));

const wallet = `0x${'2'.repeat(40)}`;
const transactionHash = `0x${'b'.repeat(64)}`;
const conditionId = `0x${'a'.repeat(64)}`;
const asset = '1234567890123456789012345678901234567890';
const otherAsset = '9876543210987654321098765432109876543210';
const rawTrade = {
  proxyWallet: wallet, transactionHash, conditionId, asset, timestamp: 1767268800,
  size: '12.5', price: '0.64', side: 'BUY', outcome: 'Yes', title: 'Fixture'
};
const context = {
  tokenId: `polygon:${asset}`, conditionId, outcome: 'Yes', outcomeIndex: 0,
  question: 'Fixture', slug: null, endDate: new Date('2027-08-01T00:00:00Z'),
  marketStatus: 'active', tickSize: '0.01', negRisk: false, acceptingOrders: true,
  resolutionStatus: 'unresolved', contextComplete: true
};
const market = {
  conditionId, question: 'Fixture', endDate: '2027-08-01T00:00:00Z',
  outcomes: ['Yes', 'No'], clobTokenIds: [asset, otherAsset],
  active: true, closed: false, acceptingOrders: true, negRisk: false,
  orderPriceMinTickSize: 0.01, umaResolutionStatus: 'unresolved'
};
function transport(trades: unknown[]) {
  return vi.fn(async (input: string | URL | Request) => new Response(
    JSON.stringify(String(input).includes('/v2/trades') ? trades : [market]),
    { headers: { 'content-type': 'application/json' } }
  )) as typeof fetch;
}

// Fake only the external persistence boundary; no DB implementation/SQL is
// reproduced or queried. Its immutable-conflict outcome is the public contract.
function storedResult(input: SourceTradeEventInput, confirmationState: 'observed' | 'confirmed' | 'finalized' | 'reversed') {
  return {
    event: { ...input, id: 'retained-source', confirmationState },
    inserted: false, position: null, eligibleForCopy: false
  } as Awaited<ReturnType<typeof recordSourceTradeEvent>>;
}

describe('ambiguous Polymarket identity through public ingestion seams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPolymarketOutcomeContext).mockResolvedValue(context);
  });

  it.each(['observed', 'confirmed', 'finalized', 'reversed'] as const)(
    'keeps identical potentially-independent reports quarantined even when storage returns %s', async (state) => {
      vi.mocked(recordSourceTradeEvent).mockImplementation(async (input) => storedResult(input, state));
      const publish = vi.fn();
      const result = await backfillPolymarketWallet(wallet, {
        fetchImpl: transport([rawTrade, {
          ...rawTrade, id: 'unreviewed-second-fill', logIndex: 42,
          confirmationState: 'finalized', confirmationEvidenceId: 'untrusted-provider-claim'
        }]), publish
      });
      expect(result).toMatchObject({ fetched: 2, inserted: 0, skipped: 2, failed: 0 });
      const calls = vi.mocked(recordSourceTradeEvent).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]![0]).toEqual(calls[1]![0]);
      expect(calls[0]![0]).toMatchObject({
        sourceEventId: transactionHash, sourceEventIndex: `ambiguous-data-api-wallet-v1:${wallet}`,
        quantity: '12500000', amountUsd: '8', priceUsd: '0.64', confirmationState: 'observed'
      });
      expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
      expect(insertParsedTransaction).not.toHaveBeenCalled();
      expect(refreshWalletActivity).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    }
  );

  it('retains original numeric decimal lexemes and exact BigInt economics in the ambiguous observation', async () => {
    vi.mocked(recordSourceTradeEvent).mockImplementation(async (input) => storedResult(input, 'observed'));
    const body = JSON.stringify([{ ...rawTrade, size: '9007199254.740993', price: '0.640000000000000001' }])
      .replace('"size":"9007199254.740993"', '"size":9007199254.740993')
      .replace('"price":"0.640000000000000001"', '"price":0.640000000000000001');
    const fetchImpl = vi.fn(async (input: string | URL | Request) => new Response(
      String(input).includes('/v2/trades') ? body : JSON.stringify([market]),
      { headers: { 'content-type': 'application/json' } }
    )) as typeof fetch;
    const publish = vi.fn();
    const result = await backfillPolymarketWallet(wallet, { fetchImpl, publish });
    expect(result).toMatchObject({ fetched: 1, inserted: 0, skipped: 1, failed: 0 });
    expect(recordSourceTradeEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventIndex: `ambiguous-data-api-wallet-v1:${wallet}`,
      quantity: '9007199254740993', amountUsd: '5764607523.034235529007199254740993',
      priceUsd: '0.640000000000000001', confirmationState: 'observed'
    }));
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('propagates a changed report conflict without replacement, demotion or accepted publication', async () => {
    vi.mocked(recordSourceTradeEvent)
      .mockImplementationOnce(async (input) => storedResult(input, 'observed'))
      .mockRejectedValueOnce(new Error('Source event identity collision with a different immutable payload'));
    const publish = vi.fn();
    await expect(backfillPolymarketWallet(wallet, {
      fetchImpl: transport([rawTrade, { ...rawTrade, size: '5', price: '0.7', timestamp: 1767268801 }]), publish
    })).rejects.toMatchObject({
      name: 'IngestionBatchError', result: { fetched: 2, inserted: 0, skipped: 1, failed: 1 },
      cause: { name: 'SourceTradePersistenceError' }
    });
    const calls = vi.mocked(recordSourceTradeEvent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0].sourceEventIndex).toBe(calls[0]![0].sourceEventIndex);
    expect(calls[1]![0]).toMatchObject({ quantity: '5000000', amountUsd: '3.5', priceUsd: '0.7', confirmationState: 'observed' });
    expect(recordConfirmedPolymarketTrade).not.toHaveBeenCalled();
    expect(insertParsedTransaction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('keeps changed token and direction ambiguous, but separates actual wallet/transaction namespaces', () => {
    const build = (override: Record<string, unknown>) => buildPolymarketSourceTradeInput({
      trade: parseConfirmedPolymarketTrade({ ...rawTrade, ...override }), quantity: '12500000', amountUsd: '8'
    });
    const first = build({});
    expect(build({ asset: otherAsset, side: 'SELL' }).sourceEventIndex).toBe(first.sourceEventIndex);
    expect(build({ proxyWallet: `0x${'3'.repeat(40)}` }).sourceEventIndex).not.toBe(first.sourceEventIndex);
    const differentTransaction = build({ transactionHash: `0x${'c'.repeat(64)}` });
    expect(differentTransaction.sourceEventId).not.toBe(first.sourceEventId);
    expect(differentTransaction.sourceEventIndex).toBe(first.sourceEventIndex);
  });
});
