import { describe, expect, it, vi } from 'vitest';
import {
  aggregatePolymarketExposure,
  claimPolymarketMirroredSellExit,
  decidePolymarketExit,
  mapPolymarketRedemptionToPositions,
  type PolymarketExposureLeg
} from './polymarket-exit-race.js';
import {
  assertPolymarketPositionsDistinct,
  type PolymarketOutcomePosition
} from './polymarket-representation.js';

/**
 * `S4-M19` — redemption as a first-class exit, raced against the mirrored sell.
 *
 * The decision functions here are pure. The claim-with-a-database tests are in
 * the sweep test (`polymarket-redemption.test.ts`) and the db test
 * (`polymarket-exit-queries.test.ts`), because this module owns the *decision* —
 * which trigger fires, and what the fan-out must not collapse — not the I/O.
 */

const CONDITION = `0x${'a'.repeat(64)}`;

function position(
  overrides: Partial<PolymarketOutcomePosition> = {}
): PolymarketOutcomePosition {
  return {
    conditionId: CONDITION,
    tokenId: '1001',
    outcomeIndex: 0,
    outcome: 'Yes',
    negRisk: false,
    ...overrides
  };
}

describe('decidePolymarketExit', () => {
  const base = {
    position: position(),
    heldShares: 40,
    masterHoldsPosition: true,
    marketResolved: false,
    acceptingOrders: true,
    existingClaim: null
  } as const;

  it('holds when neither trigger has fired', () => {
    expect(decidePolymarketExit(base).kind).toBe('hold');
  });

  it('holds on zero held shares, whatever the trigger state', () => {
    expect(decidePolymarketExit({ ...base, heldShares: 0 }).kind).toBe('hold');
    expect(decidePolymarketExit({ ...base, heldShares: 0, marketResolved: true }).kind).toBe('hold');
  });

  it('exits by redemption once the market resolves', () => {
    const decision = decidePolymarketExit({ ...base, marketResolved: true });
    expect(decision).toMatchObject({ kind: 'exit', trigger: 'redemption' });
  });

  it('exits by redemption when the market stops accepting orders', () => {
    const decision = decidePolymarketExit({ ...base, acceptingOrders: false });
    expect(decision).toMatchObject({ kind: 'exit', trigger: 'redemption' });
  });

  it('resolution outranks a mirrored sell when both look true', () => {
    // A resolved market stops accepting orders, so a sell into it cannot fill at
    // any price. Redemption is then the only exit.
    const decision = decidePolymarketExit({
      ...base,
      marketResolved: true,
      masterHoldsPosition: false
    });
    expect(decision).toMatchObject({ kind: 'exit', trigger: 'redemption' });
  });

  it('exits by mirrored sell when the master has closed and the market is open', () => {
    const decision = decidePolymarketExit({ ...base, masterHoldsPosition: false });
    expect(decision).toMatchObject({ kind: 'exit', trigger: 'mirrored-sell' });
  });

  it('does not treat an unread master cross-reference as a close', () => {
    // Ignorance is not a trigger. `null` means we have not read the master's
    // holdings; treating that as "they closed" would exit on missing data.
    const decision = decidePolymarketExit({ ...base, masterHoldsPosition: null });
    expect(decision.kind).toBe('hold');
  });

  it('the single-shot guard makes the second trigger stand down', () => {
    const decision = decidePolymarketExit({
      ...base,
      marketResolved: true,
      existingClaim: { trigger: 'mirrored-sell', status: 'claimed' }
    });
    expect(decision).toMatchObject({ kind: 'already-exiting', trigger: 'mirrored-sell' });
  });

  it('a failed claim is NOT a winner — the race must be retryable', () => {
    // A failed claim must not hold the position hostage: redemption has no
    // deadline, so a market that failed today is still exitable tomorrow. The
    // trigger still has to be live, though — a failed claim is the *absence* of a
    // winner, not a trigger of its own, which is why the market is resolved here.
    const decision = decidePolymarketExit({
      ...base,
      marketResolved: true,
      existingClaim: { trigger: 'redemption', status: 'failed' }
    });
    expect(decision).toMatchObject({ kind: 'exit', trigger: 'redemption' });
  });

  it('a failed claim does not by itself become a trigger', () => {
    // The other half of the previous test, and the one that would go unnoticed:
    // clearing the claim must not exit a position whose market is open and whose
    // master still holds it. Retryable is not the same as due.
    const decision = decidePolymarketExit({
      ...base,
      existingClaim: { trigger: 'redemption', status: 'failed' }
    });
    expect(decision.kind).toBe('hold');
  });

  it('two outcomes of one condition are two positions, not one', () => {
    const yes = decidePolymarketExit({ ...base, position: position({ tokenId: '1001', outcome: 'Yes' }), marketResolved: true });
    const no = decidePolymarketExit({ ...base, position: position({ tokenId: '1002', outcome: 'No' }), marketResolved: true });
    // Each gets its own exit; neither is suppressed by the other's claim. Asserted
    // through the discriminant rather than by reading `.trigger` off the union: a
    // 'hold' has no trigger, so `decision.trigger` does not typecheck and would
    // read `undefined === 'redemption'` if it did.
    expect(yes).toMatchObject({ kind: 'exit', trigger: 'redemption' });
    expect(no).toMatchObject({ kind: 'exit', trigger: 'redemption' });
  });
});

describe('mapPolymarketRedemptionToPositions', () => {
  it('parses each outcome row and returns one position per outcome token', () => {
    const mapped = mapPolymarketRedemptionToPositions(CONDITION, [
      { conditionId: CONDITION, tokenId: '1001', outcome: 'Yes', outcomeIndex: 0 },
      { conditionId: CONDITION, tokenId: '1002', outcome: 'No', outcomeIndex: 1 }
    ]);
    expect(mapped.map((m) => m.positionKey)).toEqual(['polygon:1001', 'polygon:1002']);
  });

  it('refuses an empty fan-out — a redemption with no position cannot be attributed', () => {
    expect(() => mapPolymarketRedemptionToPositions(CONDITION, [])).toThrow(/maps to no held position/);
  });

  it('refuses a position from a different condition', () => {
    expect(() => mapPolymarketRedemptionToPositions(CONDITION, [
      { conditionId: `0x${'b'.repeat(64)}`, tokenId: '1001', outcome: 'Yes', outcomeIndex: 0 }
    ])).toThrow(/handed a position on condition/);
  });

  it('holding both outcomes of one condition is legitimate and fans out to two', () => {
    // The distinction `S4-M20` turns on, and the one that makes the guard easy to
    // misuse: a condition-scoped redemption legitimately covers YES *and* NO, so
    // the fan-out must not throw on that set. What it must not do is return one
    // row for it.
    const mapped = mapPolymarketRedemptionToPositions(CONDITION, [
      { conditionId: CONDITION, tokenId: '1001', outcome: 'Yes', outcomeIndex: 0 },
      { conditionId: CONDITION, tokenId: '1002', outcome: 'No', outcomeIndex: 1 }
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped.map((m) => m.position.outcome)).toEqual(['Yes', 'No']);
  });

  it('the guard itself refuses the collapsed set the fan-out must never build', () => {
    // The previous test proves the ordinary case is allowed through; this one
    // proves the guard is not decoration. `mapPolymarketRedemptionToPositions`
    // applies it to each group that is about to become *one* position, so the only
    // way YES and NO reach it together is a position key re-derived from the
    // condition id — the mistake the item names. Asserted against the guard
    // directly, because inside `map` that group cannot be constructed without
    // changing `polymarketPositionKey`, and a test that only calls `map` would
    // therefore pass with the guard deleted. Verified by mutation the other way
    // round: keying `polymarketPositionKey` on `conditionId` makes the fan-out
    // throw this message instead of silently returning one row.
    //
    // The guard's reach, stated so it is not over-read: `isSamePolymarketPosition`
    // compares token ids only, so two rows carrying the *same* token id with
    // different outcome labels read as one position seen twice and pass. That is
    // its documented contract — contradictory labels for one token id are an
    // upstream data fault, not the condition-level collapse this refuses.
    expect(() => assertPolymarketPositionsDistinct([
      { conditionId: CONDITION, tokenId: '1001', outcomeIndex: 0, outcome: 'Yes', negRisk: false },
      { conditionId: CONDITION, tokenId: '1002', outcomeIndex: 1, outcome: 'No', negRisk: false }
    ])).toThrow(/distinct outcomes are distinct positions/);
  });
});

describe('aggregatePolymarketExposure', () => {
  const leg = (tokenId: string, shares: number, outcome: string): PolymarketExposureLeg => ({
    position: position({ tokenId, outcome }),
    positionKey: `polygon:${tokenId}`,
    shares
  });

  it('keeps YES and NO of one condition as separate legs', () => {
    const aggregate = aggregatePolymarketExposure([
      leg('1001', 10, 'Yes'),
      leg('1002', 10, 'No')
    ]);
    expect(aggregate.legs.map((l) => l.positionKey)).toEqual(['polygon:1001', 'polygon:1002']);
    expect(aggregate.totalShares).toBe(20);
  });

  it('never nets a YES against a NO', () => {
    // Netting them would report 0 exposure. It is not 0: reaching collateral
    // from the pair needs mergePositions, an on-chain call this executor makes
    // never. Nothing is subtracted.
    const aggregate = aggregatePolymarketExposure([
      leg('1001', 10, 'Yes'),
      leg('1002', 10, 'No')
    ]);
    expect(aggregate.totalShares).toBe(20);
  });

  it('sums duplicate views of the same outcome token', () => {
    const aggregate = aggregatePolymarketExposure([
      leg('1001', 10, 'Yes'),
      leg('1001', 5, 'Yes')
    ]);
    expect(aggregate.legs).toHaveLength(1);
    expect(aggregate.totalShares).toBe(15);
  });

  it('refuses a negative share count', () => {
    expect(() => aggregatePolymarketExposure([leg('1001', -1, 'Yes')])).toThrow();
  });
});

describe('claimPolymarketMirroredSellExit', () => {
  it('claims the race for the mirrored sell', async () => {
    const claimPositionExit = vi.fn(async () => ({ id: 'claim-1' }));
    const result = await claimPolymarketMirroredSellExit(
      { position: position(), userId: null },
      { claimPositionExit }
    );
    expect(result).toEqual({ kind: 'won', claimId: 'claim-1' });
    expect(claimPositionExit).toHaveBeenCalledWith({
      positionKey: 'polygon:1001',
      conditionId: CONDITION,
      outcomeTokenId: '1001',
      exitTrigger: 'mirrored-sell',
      userId: null
    });
  });

  it('stands down when redemption already won the position', async () => {
    const claimPositionExit = vi.fn(async () => null);
    const result = await claimPolymarketMirroredSellExit(
      { position: position(), userId: null },
      { claimPositionExit }
    );
    expect(result).toMatchObject({ kind: 'lost' });
  });
});
