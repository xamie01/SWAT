import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runPolymarketRedemptionSweep,
  type PolymarketPositionExitClaimed,
  type PolymarketPositionExitPorts,
  type PolymarketRedemptionClient
} from './polymarket-redemption.js';
import type { RedeemableMarket, RedeemablePosition } from '@swat/db';

/**
 * The sweep after the `S4-M37` inversion: it is driven by the positions **we**
 * hold, not by the master's observed trades, and every position it is about to
 * exit is claimed position-scoped first so the `S4-M19` race has exactly one
 * winner per position rather than one per trigger.
 *
 * These fixtures therefore carry real condition ids and real outcome token ids.
 * `parsePolymarketOutcomePosition` refuses anything ambiguous — a `0x…` where a
 * token id belongs, an unnamed outcome — so a market fixture that would not
 * survive the fan-out cannot pass here either, which is the point.
 */

const mocks = vi.hoisted(() => ({
  listRedeemablePolymarketMarkets: vi.fn(),
  claimPolymarketRedemption: vi.fn(),
  confirmPolymarketRedemption: vi.fn(),
  failPolymarketRedemption: vi.fn(),
  releaseStalePolymarketRedemptionClaims: vi.fn()
}));

vi.mock('@swat/db', () => mocks);

const CONDITION = `0x${'a'.repeat(64)}`;
const OTHER_CONDITION = `0x${'b'.repeat(64)}`;

function heldPosition(overrides: Partial<RedeemablePosition> = {}): RedeemablePosition {
  return {
    positionId: 'pos-1',
    conditionId: CONDITION,
    userId: null,
    targetAccount: 'polygon:0x1111111111111111111111111111111111111111',
    tokenMint: 'polygon:1001',
    tokenId: '1001',
    outcome: 'Yes',
    outcomeIndex: 0,
    heldShares: '40',
    reservedSellShares: '0',
    ...overrides
  };
}

function market(overrides: Partial<RedeemableMarket> = {}): RedeemableMarket {
  return {
    conditionId: CONDITION,
    winningTokenId: '1001',
    resolvedOutcome: 'Yes',
    negRisk: false,
    positions: [heldPosition()],
    ...overrides
  };
}

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

/**
 * Fakes for the three position-exit claim operations the sweep injects.
 *
 * Wired in every test that expects a redemption, because the sweep refuses to
 * redeem without them — see the fail-closed test below, which is the one place
 * they are deliberately left out.
 */
function exitPorts(
  overrides: Partial<PolymarketPositionExitPorts> = {}
): PolymarketPositionExitPorts & {
  claimPositionExit: ReturnType<typeof vi.fn>;
  confirmPositionExit: ReturnType<typeof vi.fn>;
  releasePositionExit: ReturnType<typeof vi.fn>;
} {
  let issued = 0;
  return {
    claimPositionExit: vi.fn(async (input: {
      positionKey: string;
      exitTrigger: PolymarketPositionExitClaimed['exitTrigger'];
    }) => {
      issued += 1;
      return {
        id: `exit-${issued}`,
        positionKey: input.positionKey,
        exitTrigger: input.exitTrigger
      };
    }),
    confirmPositionExit: vi.fn(async () => {}),
    releasePositionExit: vi.fn(async () => {}),
    ...overrides
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.releaseStalePolymarketRedemptionClaims.mockResolvedValue(0);
  mocks.listRedeemablePolymarketMarkets.mockResolvedValue([]);
  mocks.claimPolymarketRedemption.mockResolvedValue({
    id: 'claim-1',
    conditionId: CONDITION,
    userId: null
  });
  mocks.confirmPolymarketRedemption.mockResolvedValue(undefined);
  mocks.failPolymarketRedemption.mockResolvedValue(undefined);
});

describe('polymarket redemption sweep', () => {
  it('redeems a resolved market and records its transaction hash', async () => {
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([market()]);
    const sdk = client();
    const ports = exitPorts();

    const result = await runPolymarketRedemptionSweep({ client: sdk, ...ports });

    expect(sdk.redeemPositions).toHaveBeenCalledWith({ conditionId: CONDITION });
    expect(mocks.confirmPolymarketRedemption).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claim-1', transactionHash: '0xabc', winningTokenId: '1001' })
    );
    // The position-scoped exit is confirmed too: the redemption transaction is the
    // evidence for the position, not merely for the condition.
    expect(ports.confirmPositionExit).toHaveBeenCalledWith({
      id: 'exit-1',
      transactionHash: '0xabc'
    });
    expect(result).toMatchObject({ scanned: 1, redeemed: 1, failed: 0, skipped: 0 });
  });

  it('claims the position before calling the venue, keyed on the outcome token', async () => {
    // `S4-M19`: one winner per position. The claim is position-keyed
    // (`polygon:<outcomeTokenId>`) and must be taken before the on-chain call,
    // because after it there is nothing left to stand down from.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([market()]);
    const sdk = client();
    const ports = exitPorts();

    await runPolymarketRedemptionSweep({ client: sdk, ...ports });

    expect(ports.claimPositionExit).toHaveBeenCalledWith({
      positionKey: 'polygon:1001',
      conditionId: CONDITION,
      outcomeTokenId: '1001',
      exitTrigger: 'redemption',
      userId: null
    });
    const claimOrder = ports.claimPositionExit.mock.invocationCallOrder[0]!;
    const redeemOrder = vi.mocked(sdk.redeemPositions).mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(redeemOrder);
  });

  it('never passes an amount — redemption covers both outcomes', async () => {
    // Per the docs, `redeemPositions` takes only a conditionId and redeems the
    // wallet's whole balance for both outcomes. Sending an amount would be a
    // contract violation, not merely redundant.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      market({ winningTokenId: null, resolvedOutcome: 'No' })
    ]);
    const sdk = client();

    await runPolymarketRedemptionSweep({ client: sdk, ...exitPorts() });

    const call = vi.mocked(sdk.redeemPositions).mock.calls[0]![0];
    expect(Object.keys(call)).toEqual(['conditionId']);
  });

  it('does not branch on negRisk — the SDK selects the adapter', async () => {
    // Duplicating the CtfCollateralAdapter / NegRiskCtfCollateralAdapter choice
    // here would silently diverge if Polymarket changed the mapping. The market
    // is flagged neg-risk precisely so a branch would have somewhere to go.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      market({ negRisk: true, positions: [heldPosition({ negRisk: true } as never)] })
    ]);
    const sdk = client();

    await runPolymarketRedemptionSweep({ client: sdk, ...exitPorts() });

    const call = vi.mocked(sdk.redeemPositions).mock.calls[0]![0] as Record<string, unknown>;
    expect(call.negRisk).toBeUndefined();
    expect(call.adapter).toBeUndefined();
  });

  it('redeems a condition we hold both outcomes of exactly once, without collapsing them', async () => {
    // `S4-M20`: holding YES and NO of one condition is a legitimate state, so the
    // fan-out must not throw — but the two rows must stay two positions. One
    // condition-scoped on-chain call, two position-scoped exits.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      market({
        positions: [
          heldPosition({ tokenId: '1001', tokenMint: 'polygon:1001', outcome: 'Yes', outcomeIndex: 0 }),
          heldPosition({
            positionId: 'pos-2',
            tokenId: '1002',
            tokenMint: 'polygon:1002',
            outcome: 'No',
            outcomeIndex: 1
          })
        ]
      })
    ]);
    const sdk = client();
    const ports = exitPorts();

    const result = await runPolymarketRedemptionSweep({ client: sdk, ...ports });

    expect(sdk.redeemPositions).toHaveBeenCalledTimes(1);
    expect(ports.claimPositionExit).toHaveBeenCalledTimes(2);
    expect(ports.claimPositionExit.mock.calls.map((c) => c[0].positionKey))
      .toEqual(['polygon:1001', 'polygon:1002']);
    expect(ports.confirmPositionExit).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ scanned: 1, redeemed: 1, failed: 0 });
  });

  it('refuses a market we hold no position in, without calling the venue', async () => {
    // `S4-M37`: redeem only what we hold. A market that reached the sweep with no
    // position of ours attached is a redemption that could not be attributed, so
    // it is refused before anything is claimed rather than redeemed on spec.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([market({ positions: [] })]);
    const sdk = client();
    const ports = exitPorts();

    const result = await runPolymarketRedemptionSweep({ client: sdk, ...ports });

    expect(sdk.redeemPositions).not.toHaveBeenCalled();
    expect(ports.claimPositionExit).not.toHaveBeenCalled();
    expect(mocks.claimPolymarketRedemption).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 1, redeemed: 0, failed: 1 });
  });

  it('refuses to redeem at all when the position-exit port is unwired', async () => {
    // Fail closed. Without a position-scoped claim both triggers can exit the same
    // position — a master selling moments before resolution is the ordinary case —
    // so an unwired sweep must strand the position rather than double-exit it.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([market()]);
    const sdk = client();

    // The cast is the point of this test, not a shortcut: since 2026-09-01 the
    // ports are REQUIRED, so omitting them is a compile error and a caller can no
    // longer arrive here by accident. This deliberately reaches past the type to
    // prove the runtime fallback still fails closed for a caller that bypasses it
    // -- a hand-rolled dependency object, or JS with no types at all.
    const result = await runPolymarketRedemptionSweep(
      { client: sdk } as unknown as Parameters<typeof runPolymarketRedemptionSweep>[0]
    );

    expect(sdk.redeemPositions).not.toHaveBeenCalled();
    expect(mocks.claimPolymarketRedemption).not.toHaveBeenCalled();
    expect(result).toMatchObject({ redeemed: 0, failed: 1 });
  });

  it('stands down on a position the mirrored sell already claimed', async () => {
    // Losing the race is the design, not an error: whichever trigger got there
    // first exits the position and the other one does nothing.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([market()]);
    const sdk = client();
    const ports = exitPorts({ claimPositionExit: vi.fn(async () => null) });

    const result = await runPolymarketRedemptionSweep({ client: sdk, ...ports });

    expect(sdk.redeemPositions).not.toHaveBeenCalled();
    expect(mocks.claimPolymarketRedemption).not.toHaveBeenCalled();
    expect(result).toMatchObject({ redeemed: 0, failed: 0, skipped: 1, lostRaces: 1 });
  });

  it('skips a market another sweep already claimed, without calling the venue', async () => {
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      market({ winningTokenId: null })
    ]);
    mocks.claimPolymarketRedemption.mockResolvedValue(null);
    const sdk = client();
    const ports = exitPorts();

    const result = await runPolymarketRedemptionSweep({ client: sdk, ...ports });

    // The exactly-once guard is the whole point: a lost claim must not redeem.
    expect(sdk.redeemPositions).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 1, redeemed: 0 });
    // And the position claim we took on the way in is handed back, or the position
    // would be wedged by a claim for an exit that never happened.
    expect(ports.releasePositionExit).toHaveBeenCalledWith({
      id: 'exit-1',
      reason: 'another sweep holds the condition claim'
    });
  });

  it('fails rather than confirms when the venue returns no transaction hash', async () => {
    // Confirming without evidence would put unverifiable money in the ledger.
    // Retrying is safe: redemption has no deadline and a second call on an
    // already-redeemed market moves no tokens.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      market({ winningTokenId: null })
    ]);
    const sdk = client({
      redeemPositions: vi.fn().mockResolvedValue({
        wait: vi.fn().mockResolvedValue({ transactionHash: '', transactionId: null })
      })
    });
    const ports = exitPorts();

    const result = await runPolymarketRedemptionSweep({ client: sdk, ...ports });

    expect(mocks.confirmPolymarketRedemption).not.toHaveBeenCalled();
    expect(mocks.failPolymarketRedemption).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claim-1' })
    );
    expect(ports.confirmPositionExit).not.toHaveBeenCalled();
    expect(ports.releasePositionExit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'exit-1' })
    );
    expect(result).toMatchObject({ redeemed: 0, failed: 1 });
  });

  it('releases the claim when the venue throws, so the market can be retried', async () => {
    // A missing collateral-adapter approval surfaces here. It must not wedge the
    // market permanently — nor the position, whose exit claim is released too.
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      market({ winningTokenId: null })
    ]);
    const sdk = client({
      redeemPositions: vi.fn().mockRejectedValue(new Error('ERC1155 not approved'))
    });
    const ports = exitPorts();

    const result = await runPolymarketRedemptionSweep({ client: sdk, ...ports });

    expect(mocks.failPolymarketRedemption).toHaveBeenCalledWith({
      id: 'claim-1',
      reason: 'ERC1155 not approved'
    });
    expect(ports.releasePositionExit).toHaveBeenCalledWith({
      id: 'exit-1',
      reason: 'ERC1155 not approved'
    });
    expect(result).toMatchObject({ redeemed: 0, failed: 1 });
  });

  it('releases stale claims before scanning, so a wedged market is eligible this pass', async () => {
    mocks.releaseStalePolymarketRedemptionClaims.mockResolvedValue(2);
    const releaseStalePositionExits = vi.fn(async () => 1);

    const result = await runPolymarketRedemptionSweep({
      client: client(),
      ...exitPorts(),
      releaseStalePositionExits
    });

    expect(mocks.releaseStalePolymarketRedemptionClaims).toHaveBeenCalled();
    // Both ledgers are recovered: a stuck position-exit claim would block the race
    // even after the condition-level redemption claim was released.
    expect(releaseStalePositionExits).toHaveBeenCalled();
    // Ordering matters: releasing after the scan would defer recovery a cycle.
    const releaseOrder = mocks.releaseStalePolymarketRedemptionClaims.mock.invocationCallOrder[0]!;
    const listOrder = mocks.listRedeemablePolymarketMarkets.mock.invocationCallOrder[0]!;
    expect(releaseOrder).toBeLessThan(listOrder);
    expect(result.staleReleased).toBe(2);
  });

  it('continues past a failed market rather than abandoning the sweep', async () => {
    mocks.listRedeemablePolymarketMarkets.mockResolvedValue([
      market({ winningTokenId: null }),
      market({
        conditionId: OTHER_CONDITION,
        winningTokenId: null,
        positions: [heldPosition({
          positionId: 'pos-2',
          conditionId: OTHER_CONDITION,
          tokenId: '2001',
          tokenMint: 'polygon:2001'
        })]
      })
    ]);
    mocks.claimPolymarketRedemption
      .mockResolvedValueOnce({ id: 'claim-1', conditionId: CONDITION, userId: null })
      .mockResolvedValueOnce({ id: 'claim-2', conditionId: OTHER_CONDITION, userId: null });
    const sdk = client({
      redeemPositions: vi
        .fn()
        .mockRejectedValueOnce(new Error('venue 500'))
        .mockResolvedValueOnce({
          wait: vi.fn().mockResolvedValue({ transactionHash: '0xdef' })
        })
    });

    const result = await runPolymarketRedemptionSweep({ client: sdk, ...exitPorts() });

    // One bad market must not strand every other resolved position.
    expect(result).toMatchObject({ scanned: 2, redeemed: 1, failed: 1 });
  });

  it('does nothing when no market is redeemable', async () => {
    const sdk = client();
    const result = await runPolymarketRedemptionSweep({ client: sdk, ...exitPorts() });
    expect(sdk.redeemPositions).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 0, redeemed: 0 });
  });
});
