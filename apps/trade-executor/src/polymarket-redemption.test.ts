import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runPolymarketRedemptionSweep,
  type PolymarketRedemptionClient
} from './polymarket-redemption.js';

const mocks = vi.hoisted(() => ({
  listRedeemablePolymarketMarkets: vi.fn(),
  claimPolymarketRedemption: vi.fn(),
  confirmPolymarketRedemption: vi.fn(),
  failPolymarketRedemption: vi.fn(),
  releaseStalePolymarketRedemptionClaims: vi.fn()
}));

vi.mock('@swat/db', () => mocks);

function client(
  overrides?: Partial<PolymarketRedemptionClient>
): PolymarketRedemptionClient {
  return {
    redeemPositions: vi.fn().mockResolvedValue({
      wait: vi.fn().mockResolvedValue({ transactionHash: '0xabc', transactionId: 'tx-1' })
    }),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.releaseStalePolymarketRedemptionClaims.mockResolvedValue(0);
  mocks.listRedeemablePolymarketMarkets.mockResolvedValue([]);
  mocks.claimPolymarketRedemption.mockResolvedValue({ id: 'claim-1', conditionId: 'c1', userId: null });
  mocks.confirmPolymarketRedemption.mockResolvedValue(undefined);
  mocks.failPolymarketRedemption.mockResolvedValue(undefined);
});

describe('polymarket redemption sweep', () => {
  it('redeems a resolved market and records its transaction hash', async () => {
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      { conditionId: 'c1', winningTokenId: 'token-yes', resolvedOutcome: 'Yes' }
    ]);
    const sdk = client();

    const result = await runPolymarketRedemptionSweep({ client: sdk });

    expect(sdk.redeemPositions).toHaveBeenCalledWith({ conditionId: 'c1' });
    expect(mocks.confirmPolymarketRedemption).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claim-1', transactionHash: '0xabc', winningTokenId: 'token-yes' })
    );
    expect(result).toMatchObject({ scanned: 1, redeemed: 1, failed: 0, skipped: 0 });
  });

  it('never passes an amount — redemption covers both outcomes', async () => {
    // Per the docs, `redeemPositions` takes only a conditionId and redeems the
    // wallet's whole balance for both outcomes. Sending an amount would be a
    // contract violation, not merely redundant.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      { conditionId: 'c1', winningTokenId: null, resolvedOutcome: 'No' }
    ]);
    const sdk = client();

    await runPolymarketRedemptionSweep({ client: sdk });

    const call = vi.mocked(sdk.redeemPositions).mock.calls[0]![0];
    expect(Object.keys(call)).toEqual(['conditionId']);
  });

  it('does not branch on negRisk — the SDK selects the adapter', async () => {
    // Duplicating the CtfCollateralAdapter / NegRiskCtfCollateralAdapter choice
    // here would silently diverge if Polymarket changed the mapping.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      { conditionId: 'c-neg', winningTokenId: 'token-yes', resolvedOutcome: 'Yes' }
    ]);
    const sdk = client();

    await runPolymarketRedemptionSweep({ client: sdk });

    const call = vi.mocked(sdk.redeemPositions).mock.calls[0]![0] as Record<string, unknown>;
    expect(call.negRisk).toBeUndefined();
    expect(call.adapter).toBeUndefined();
  });

  it('skips a market another sweep already claimed, without calling the venue', async () => {
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      { conditionId: 'c1', winningTokenId: null, resolvedOutcome: 'Yes' }
    ]);
    mocks.claimPolymarketRedemption.mockResolvedValue(null);
    const sdk = client();

    const result = await runPolymarketRedemptionSweep({ client: sdk });

    // The exactly-once guard is the whole point: a lost claim must not redeem.
    expect(sdk.redeemPositions).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, redeemed: 0 });
  });

  it('fails rather than confirms when the venue returns no transaction hash', async () => {
    // Confirming without evidence would put unverifiable money in the ledger.
    // Retrying is safe: redemption has no deadline and a second call on an
    // already-redeemed market moves no tokens.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      { conditionId: 'c1', winningTokenId: null, resolvedOutcome: 'Yes' }
    ]);
    const sdk = client({
      redeemPositions: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue({ transactionHash: '', transactionId: null })
      })
    });

    const result = await runPolymarketRedemptionSweep({ client: sdk });

    expect(mocks.confirmPolymarketRedemption).not.toHaveBeenCalled();
    expect(mocks.failPolymarketRedemption).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claim-1' })
    );
    expect(result).toMatchObject({ redeemed: 0, failed: 1 });
  });

  it('releases the claim when the venue throws, so the market can be retried', async () => {
    // A missing collateral-adapter approval surfaces here. It must not wedge the
    // market permanently.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      { conditionId: 'c1', winningTokenId: null, resolvedOutcome: 'Yes' }
    ]);
    const sdk = client({
      redeemPositions: vi.fn().mockRejectedValue(new Error('ERC1155 not approved'))
    });

    const result = await runPolymarketRedemptionSweep({ client: sdk });

    expect(mocks.failPolymarketRedemption).toHaveBeenCalledWith({
      id: 'claim-1',
      reason: 'ERC1155 not approved'
    });
    expect(result).toMatchObject({ redeemed: 0, failed: 1 });
  });

  it('releases stale claims before scanning, so a wedged market is eligible this pass', async () => {
    mocks.releaseStalePolymarketRedemptionClaims.mockResolvedValue(2);

    const result = await runPolymarketRedemptionSweep({ client: client() });

    expect(mocks.releaseStalePolymarketRedemptionClaims).toHaveBeenCalled();
    // Ordering matters: releasing after the scan would defer recovery a cycle.
    const releaseOrder = mocks.releaseStalePolymarketRedemptionClaims.mock.invocationCallOrder[0]!;
    const listOrder = mocks.listRedeemablePolymarketMarkets.mock.invocationCallOrder[0]!;
    expect(releaseOrder).toBeLessThan(listOrder);
    expect(result.staleReleased).toBe(2);
  });

  it('continues past a failed market rather than abandoning the sweep', async () => {
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      { conditionId: 'c1', winningTokenId: null, resolvedOutcome: 'Yes' },
      { conditionId: 'c2', winningTokenId: null, resolvedOutcome: 'Yes' }
    ]);
    mocks.claimPolymarketRedemption
      .mockResolvedValueOnce({ id: 'claim-1', conditionId: 'c1', userId: null })
      .mockResolvedValueOnce({ id: 'claim-2', conditionId: 'c2', userId: null });
    const sdk = client({
      redeemPositions: vi
        .fn()
        .mockRejectedValueOnce(new Error('venue 500'))
        .mockResolvedValueOnce({
          wait: vi.fn().mockResolvedValue({ transactionHash: '0xdef' })
        })
    });

    const result = await runPolymarketRedemptionSweep({ client: sdk });

    // One bad market must not strand every other resolved position.
    expect(result).toMatchObject({ scanned: 2, redeemed: 1, failed: 1 });
  });

  it('does nothing when no market is redeemable', async () => {
    const sdk = client();
    const result = await runPolymarketRedemptionSweep({ client: sdk });
    expect(sdk.redeemPositions).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 0, redeemed: 0 });
  });
});
