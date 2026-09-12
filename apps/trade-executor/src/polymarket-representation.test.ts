import { describe, expect, it } from 'vitest';
import {
  assertPolymarketPositionsDistinct,
  describePolymarketComplement,
  isSamePolymarketPosition,
  parsePolymarketOutcomePosition,
  polymarketPositionKey,
  type PolymarketOutcomePosition
} from './polymarket-representation.js';

const CONDITION_A = `0x${'a'.repeat(64)}`;
const CONDITION_B = `0x${'b'.repeat(64)}`;
const CONDITION_C = `0x${'c'.repeat(64)}`;

// Real-shaped uint256 outcome token ids, as the CLOB reports `asset_id`.
const YES_TOKEN = '107505882767731489358349912513945399560393482969656700824895970500493757150417';
const NO_TOKEN = '7305630249804085635496399869905769372294302716159034447326228509068694952392';

function position(overrides: Partial<{
  conditionId: string;
  tokenId: string;
  outcomeIndex: number;
  outcome: string;
  negRisk: boolean;
}> = {}): PolymarketOutcomePosition {
  return parsePolymarketOutcomePosition({
    conditionId: CONDITION_A,
    tokenId: YES_TOKEN,
    outcomeIndex: 0,
    outcome: 'Yes',
    negRisk: false,
    ...overrides
  });
}

describe('Polymarket outcome representation is preserved, not normalised (S4-M20)', () => {
  describe('identity is the outcome token', () => {
    it('keys a position on the token id, never the condition id', () => {
      // A condition holds two outcomes. Keying on it would merge YES and NO into
      // one position row, which is the normalisation this item forbids.
      const yes = position({ tokenId: YES_TOKEN, outcomeIndex: 0, outcome: 'Yes' });
      const no = position({ tokenId: NO_TOKEN, outcomeIndex: 1, outcome: 'No' });

      expect(polymarketPositionKey(yes)).toBe(`polygon:${YES_TOKEN}`);
      expect(polymarketPositionKey(no)).toBe(`polygon:${NO_TOKEN}`);
      expect(polymarketPositionKey(yes)).not.toBe(polymarketPositionKey(no));
      expect(yes.conditionId).toBe(no.conditionId);
    });

    it('does not let negRisk enter the key, so no adapter branch is re-introduced', () => {
      // `negRisk` is context for reasoning about a position. The client still
      // picks the collateral adapter from the condition id, and
      // polymarket-negrisk.test.ts still asserts we send no negRisk/adapter key.
      expect(polymarketPositionKey(position({ negRisk: false })))
        .toBe(polymarketPositionKey(position({ negRisk: true })));
    });

    it('treats NO on one outcome as a different position from YES on the same market', () => {
      const no = position({ tokenId: NO_TOKEN, outcomeIndex: 1, outcome: 'No' });
      expect(isSamePolymarketPosition(position(), no)).toBe(false);
      // ...and the same outcome seen twice is one position, not two.
      expect(isSamePolymarketPosition(position(), position())).toBe(true);
    });

    it('refuses a condition id where a token id belongs', () => {
      // The concrete failure this rejection prevents: a condition id used as a
      // position key silently collapses both outcomes into one row.
      expect(() => position({ tokenId: CONDITION_A })).toThrow('is not a uint256');
      expect(() => position({ tokenId: '0' })).toThrow('is not a uint256');
    });

    it('accepts a token id in either the bare or the polygon-prefixed form', () => {
      // Bare from the venue (`trade.asset`, order books), prefixed from our own
      // `token_mint` columns. Both must land on one identity.
      expect(polymarketPositionKey(position({ tokenId: `polygon:${YES_TOKEN}` })))
        .toBe(polymarketPositionKey(position({ tokenId: YES_TOKEN })));
    });

    it('will not infer an outcome label from the index', () => {
      // A named neg-risk outcome carries a candidate name, not a polarity, so
      // index 1 does not mean 'No' and must never be filled in for the user.
      expect(() => parsePolymarketOutcomePosition({
        conditionId: CONDITION_A, tokenId: NO_TOKEN, outcomeIndex: 1, outcome: ''
      })).toThrow('outcome label');
    });
  });

  describe('the netting guard', () => {
    it('refuses to merge two outcomes of one condition', () => {
      // The shape that means a caller reached the condition level and lost the
      // outcome — the S4-M19 redemption fan-out and exposure aggregation are the
      // two places this is about to be tempted.
      expect(() => assertPolymarketPositionsDistinct([
        position({ tokenId: YES_TOKEN, outcomeIndex: 0, outcome: 'Yes' }),
        position({ tokenId: NO_TOKEN, outcomeIndex: 1, outcome: 'No' })
      ])).toThrow('distinct outcomes are distinct positions');
    });

    it('allows the same outcome twice, and outcomes across different conditions', () => {
      expect(() => assertPolymarketPositionsDistinct([position(), position()])).not.toThrow();
      expect(() => assertPolymarketPositionsDistinct([
        position({ conditionId: CONDITION_A }),
        position({ conditionId: CONDITION_B })
      ])).not.toThrow();
    });

    it('names both outcomes in the refusal so an operator can see what collapsed', () => {
      expect(() => assertPolymarketPositionsDistinct([
        position({ tokenId: YES_TOKEN, outcomeIndex: 0, outcome: 'Yes' }),
        position({ tokenId: NO_TOKEN, outcomeIndex: 1, outcome: 'No' })
      ])).toThrow(/Yes.*index 0.*No.*index 1/);
    });
  });

  describe('the complement is a set, described but never substituted', () => {
    it('is the other outcome of the same condition on a binary market, via merge', () => {
      // `/trading/positions/manage` → Merge Positions: 1 YES + 1 NO returns 1 pUSD,
      // and only through `mergePositions` with equal balances and a prior adapter
      // approval. Holding one is not holding the other.
      const complement = describePolymarketComplement(
        position({ tokenId: NO_TOKEN, outcomeIndex: 1, outcome: 'No' })
      );

      expect(complement).toEqual({
        kind: 'known',
        mechanism: 'merge-positions',
        legs: [{ conditionId: CONDITION_A, outcomeIndex: 0 }],
        interchangeableWithoutAction: false,
        outcomeSetStable: true
      });
    });

    it('is one YES per OTHER market of a neg-risk event, spanning other conditions', () => {
      // `/concepts/negative-risk` → Conversion Mechanics: 1 NO for Outcome A
      // converts to 1 YES for every other outcome in the event. So the complement
      // is N-1 legs in N-1 distinct conditions — it cannot be one position row
      // under any keying, and merging it would touch conditions never traded.
      const complement = describePolymarketComplement(
        position({ tokenId: NO_TOKEN, outcomeIndex: 1, outcome: 'No', negRisk: true }),
        { siblingConditionIds: [CONDITION_B, CONDITION_C] }
      );

      expect(complement).toMatchObject({ kind: 'known', mechanism: 'neg-risk-convert' });
      expect(complement.kind === 'known' && complement.legs).toEqual([
        { conditionId: CONDITION_B, outcomeIndex: 0 },
        { conditionId: CONDITION_C, outcomeIndex: 0 }
      ]);
      // More than one leg, and none of them in this position's own condition.
      expect(complement.kind === 'known' && complement.legs.length).toBe(2);
      expect(complement.kind === 'known'
        && complement.legs.every((leg) => leg.conditionId !== CONDITION_A)).toBe(true);
    });

    it('never reports the complement as interchangeable without an on-chain call', () => {
      // The docs call the neg-risk relationship "economically equivalent", which is
      // exactly the reasoning this item forbids acting on. The equivalence is
      // realised by an adapter call this executor does not make.
      for (const complement of [
        describePolymarketComplement(position()),
        describePolymarketComplement(
          position({ negRisk: true }), { siblingConditionIds: [CONDITION_B] }
        )
      ]) {
        expect(complement.kind === 'known' && complement.interchangeableWithoutAction).toBe(false);
      }
    });

    it('reports an unstable outcome set under augmented neg risk', () => {
      // `/concepts/negative-risk` → Augmented Negative Risk: placeholders are
      // clarified after trading begins and the 'Other' definition narrows. A
      // complement computed now can be incomplete by resolution, so a
      // normalisation would be wrong even if it were legitimate.
      const complement = describePolymarketComplement(
        position({ negRisk: true }),
        { siblingConditionIds: [CONDITION_B, CONDITION_C], augmented: true }
      );

      expect(complement).toMatchObject({ kind: 'known', outcomeSetStable: false });
    });

    it('is undeterminable when the neg-risk event has not been read', () => {
      // Not "no complement" — an unread event. An empty set would read as
      // "nothing on the other side", which is the more dangerous of the two.
      expect(describePolymarketComplement(position({ negRisk: true })))
        .toMatchObject({ kind: 'undeterminable' });
      expect(describePolymarketComplement(
        position({ negRisk: true }), { siblingConditionIds: [] }
      )).toMatchObject({ kind: 'undeterminable' });
      // A group that lists only this position's own condition is also no set.
      expect(describePolymarketComplement(
        position({ negRisk: true }), { siblingConditionIds: [CONDITION_A] }
      )).toMatchObject({ kind: 'undeterminable' });
    });

    it('is undeterminable for an out-of-range outcome on a standard market', () => {
      // `/concepts/positions-tokens`: each market has exactly two outcome tokens.
      expect(describePolymarketComplement(position({ outcomeIndex: 2 })))
        .toMatchObject({ kind: 'undeterminable' });
    });
  });
});
