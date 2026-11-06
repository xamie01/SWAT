import { describe, expect, it, vi } from 'vitest';
import { aggregatePolymarketExposure, claimPolymarketExit, claimPolymarketManualExit, claimPolymarketMirroredSellExit, decidePolymarketExit, mapPolymarketRedemptionToPositions } from './polymarket-exit-race.js';
import { assertPolymarketPositionsDistinct } from './polymarket-representation.js';
/**
 * `S4-M19` — redemption as a first-class exit, raced against the mirrored sell.
 *
 * The decision functions here are pure. The claim-with-a-database tests are in
 * the sweep test (`polymarket-redemption.test.ts`) and the db test
 * (`polymarket-exit-queries.test.ts`), because this module owns the *decision* —
 * which trigger fires, and what the fan-out must not collapse — not the I/O.
 */
const CONDITION = `0x${'a'.repeat(64)}`;
function position(overrides = {}) {
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
        // Added when `S4-M45` made manual exit the third entrant. Required rather
        // than optional on `PolymarketExitRaceInput`, so every existing case has to
        // state that no manual exit was requested -- which is what keeps the
        // two-entrant behaviour below asserted as *itself* rather than as a default.
        manualExitRequested: false,
        existingClaim: null
    };
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
    const leg = (tokenId, shares, outcome) => ({
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
        const result = await claimPolymarketMirroredSellExit({ position: position(), userId: null }, { claimPositionExit });
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
        const result = await claimPolymarketMirroredSellExit({ position: position(), userId: null }, { claimPositionExit });
        expect(result).toMatchObject({ kind: 'lost' });
    });
});
describe('S4-M45 — manual exit as the third entrant in the same race', () => {
    const base = {
        position: position(),
        heldShares: 40,
        masterHoldsPosition: true,
        marketResolved: false,
        acceptingOrders: true,
        manualExitRequested: false,
        existingClaim: null
    };
    it('a manual request exits by the manual trigger while the book is open', () => {
        const decision = decidePolymarketExit({ ...base, manualExitRequested: true });
        expect(decision).toMatchObject({
            kind: 'exit',
            trigger: 'manual',
            code: 'polymarket-exit-by-manual-request'
        });
    });
    it('a manual exit racing a master sell in one observation produces exactly one exit', () => {
        // The ordinary case the item names: the user taps exit moments before the
        // master sells, and one sweep sees both. One call, one decision, one trigger —
        // there is no shape of the return type that carries two exits, which is the
        // structural half of "one race, not three paths".
        const decision = decidePolymarketExit({
            ...base,
            manualExitRequested: true,
            masterHoldsPosition: false
        });
        expect(decision.kind).toBe('exit');
        expect(decision).toMatchObject({ trigger: 'manual' });
    });
    it('manual outranks the mirrored sell, so the user\'s own instruction is what is recorded', () => {
        // Both are the same FAK sell of the whole position, so the winner does not
        // change what is sent to the venue — it changes `exit_trigger`, which
        // attribution reads. Recording the user's tap as the master's sell would show
        // the user an audit trail in which their tap did nothing.
        const decision = decidePolymarketExit({
            ...base,
            manualExitRequested: true,
            masterHoldsPosition: false
        });
        expect(decision).toMatchObject({ trigger: 'manual' });
    });
    it('resolution still outranks a manual request, and redeems rather than selling', () => {
        // The rung that makes "Polymarket redemption is just another sell" false. The
        // user's instruction is honoured — the position exits — but a sell into a
        // resolved book cannot fill at any price, so the mechanism is redemption.
        const decision = decidePolymarketExit({
            ...base,
            manualExitRequested: true,
            marketResolved: true
        });
        expect(decision).toMatchObject({
            kind: 'exit',
            trigger: 'redemption',
            code: 'polymarket-exit-by-redemption'
        });
        expect(decision.reason).toMatch(/manual request is honoured by redeeming/);
    });
    it('a manual exit does not need the master cross-reference to be readable', () => {
        // Without this the user's exit would be blocked by our own ignorance of a
        // wallet that has nothing to do with their instruction. The master-sell
        // entrant still holds on `null` — that assertion is above and unchanged.
        const decision = decidePolymarketExit({
            ...base,
            manualExitRequested: true,
            masterHoldsPosition: null
        });
        expect(decision).toMatchObject({ kind: 'exit', trigger: 'manual' });
    });
    it('a manual exit still holds when we hold no provable shares', () => {
        // Above every trigger, manual included: a user asking to exit a position we
        // cannot prove we hold must not send an order, because sizing has no honest
        // input.
        const decision = decidePolymarketExit({
            ...base,
            manualExitRequested: true,
            heldShares: 0
        });
        expect(decision).toMatchObject({
            kind: 'hold',
            code: 'polymarket-exit-hold-no-proven-shares'
        });
    });
    it('the single-shot guard covers a live manual claim, so the master sell stands down', () => {
        // The other direction of the guard, and the one that proves manual entered the
        // existing race rather than sitting beside it: a claim taken by `manual` blocks
        // the mirrored-sell entrant exactly as a redemption claim does.
        const decision = decidePolymarketExit({
            ...base,
            masterHoldsPosition: false,
            existingClaim: { trigger: 'manual', status: 'claimed' }
        });
        expect(decision).toMatchObject({
            kind: 'already-exiting',
            trigger: 'manual',
            code: 'polymarket-exit-already-claimed'
        });
    });
    it('the single-shot guard covers a live manual claim against redemption too', () => {
        const decision = decidePolymarketExit({
            ...base,
            marketResolved: true,
            existingClaim: { trigger: 'manual', status: 'confirmed' }
        });
        expect(decision).toMatchObject({ kind: 'already-exiting', trigger: 'manual' });
    });
    it('a live claim by another entrant makes the manual request stand down', () => {
        const decision = decidePolymarketExit({
            ...base,
            manualExitRequested: true,
            existingClaim: { trigger: 'redemption', status: 'claimed' }
        });
        expect(decision).toMatchObject({ kind: 'already-exiting', trigger: 'redemption' });
    });
    it('a failed manual claim is retryable, on the same rule as a failed redemption', () => {
        const decision = decidePolymarketExit({
            ...base,
            manualExitRequested: true,
            existingClaim: { trigger: 'manual', status: 'failed' }
        });
        expect(decision).toMatchObject({ kind: 'exit', trigger: 'manual' });
    });
    it('a failed manual claim does not by itself become a trigger', () => {
        // The half that would go unnoticed: releasing a failed manual claim must not
        // exit a position whose market is open, whose master still holds it, and whose
        // user is no longer asking. Retryable is not the same as due.
        const decision = decidePolymarketExit({
            ...base,
            manualExitRequested: false,
            existingClaim: { trigger: 'manual', status: 'failed' }
        });
        expect(decision).toMatchObject({
            kind: 'hold',
            code: 'polymarket-exit-hold-no-trigger-fired'
        });
    });
    it('every decision carries a stable code, not only a prose reason', () => {
        const codes = [
            decidePolymarketExit({ ...base, heldShares: 0 }),
            decidePolymarketExit({ ...base, existingClaim: { trigger: 'manual', status: 'claimed' } }),
            decidePolymarketExit({ ...base, marketResolved: true }),
            decidePolymarketExit({ ...base, manualExitRequested: true }),
            decidePolymarketExit({ ...base, masterHoldsPosition: false }),
            decidePolymarketExit({ ...base, masterHoldsPosition: null }),
            decidePolymarketExit(base)
        ].map((decision) => decision.code);
        expect(codes).toEqual([
            'polymarket-exit-hold-no-proven-shares',
            'polymarket-exit-already-claimed',
            'polymarket-exit-by-redemption',
            'polymarket-exit-by-manual-request',
            'polymarket-exit-by-mirrored-sell',
            'polymarket-exit-hold-master-holdings-unread',
            'polymarket-exit-hold-no-trigger-fired'
        ]);
        // Every reachable branch is covered above, so a new rung without a code fails
        // to compile and a new rung with a duplicate code fails here.
        expect(new Set(codes).size).toBe(codes.length);
    });
});
describe('S4-M45 — one claim ledger, three entrants', () => {
    /**
     * A fake standing in for the partial unique index on
     * `polymarket_position_exits (user_id, position_key) WHERE status IN
     * ('claimed','confirmed')`: the first insert for a key returns a row, every
     * later one returns null. That is the whole arbiter, and the point of these
     * tests is that all three entrants go through it.
     */
    function ledger() {
        const live = new Set();
        const triggers = [];
        return {
            triggers,
            claimPositionExit: async (input) => {
                if (live.has(input.positionKey))
                    return null;
                live.add(input.positionKey);
                triggers.push(input.exitTrigger);
                return { id: `claim-${triggers.length}` };
            }
        };
    }
    it('a manual exit and a mirrored sell against one position yield exactly one winner', async () => {
        const store = ledger();
        const manual = await claimPolymarketManualExit({ position: position(), userId: null }, { claimPositionExit: store.claimPositionExit });
        const mirrored = await claimPolymarketMirroredSellExit({ position: position(), userId: null }, { claimPositionExit: store.claimPositionExit });
        const won = [manual, mirrored].filter((result) => result.kind === 'won');
        expect(won).toHaveLength(1);
        expect(manual).toMatchObject({ kind: 'won' });
        expect(mirrored).toMatchObject({ kind: 'lost', code: 'polymarket-exit-already-claimed' });
        // And only one row was written, under the manual trigger.
        expect(store.triggers).toEqual(['manual']);
    });
    it('the mirrored sell arriving first makes the manual exit stand down', async () => {
        // The same assertion the other way round: the winner is whoever got there
        // first, not whichever trigger this module happens to prefer.
        const store = ledger();
        const mirrored = await claimPolymarketMirroredSellExit({ position: position(), userId: null }, { claimPositionExit: store.claimPositionExit });
        const manual = await claimPolymarketManualExit({ position: position(), userId: null }, { claimPositionExit: store.claimPositionExit });
        expect(mirrored).toMatchObject({ kind: 'won' });
        expect(manual).toMatchObject({ kind: 'lost' });
        expect(store.triggers).toEqual(['mirrored-sell']);
    });
    it('all three entrants against one position write exactly one row', async () => {
        const store = ledger();
        const results = [];
        for (const trigger of ['manual', 'mirrored-sell', 'redemption']) {
            results.push(await claimPolymarketExit({ position: position(), userId: null, trigger }, { claimPositionExit: store.claimPositionExit }));
        }
        expect(results.filter((result) => result.kind === 'won')).toHaveLength(1);
        expect(store.triggers).toHaveLength(1);
    });
    it('the manual entrant reaches the ledger through the same port and shape', async () => {
        // The single-path proof at the call level: identical argument object, one
        // field different. If a manual exit ever grows its own claim, this diverges.
        const calls = [];
        const claimPositionExit = vi.fn(async (input) => {
            calls.push(input);
            return { id: `claim-${calls.length}` };
        });
        await claimPolymarketMirroredSellExit({ position: position(), userId: 'user-1' }, { claimPositionExit });
        await claimPolymarketManualExit({ position: position(), userId: 'user-1' }, { claimPositionExit });
        expect(calls[0]).toEqual({
            positionKey: 'polygon:1001',
            conditionId: CONDITION,
            outcomeTokenId: '1001',
            exitTrigger: 'mirrored-sell',
            userId: 'user-1'
        });
        expect(calls[1]).toEqual({ ...calls[0], exitTrigger: 'manual' });
    });
    it('two outcomes of one condition each get their own manual exit', async () => {
        // A manual exit of YES must not suppress the exit of NO. The claim is keyed on
        // the outcome token, so this holds for the manual entrant exactly as `S4-M19`
        // established it for the other two.
        const store = ledger();
        const yes = await claimPolymarketManualExit({ position: position({ tokenId: '1001', outcome: 'Yes' }), userId: null }, { claimPositionExit: store.claimPositionExit });
        const no = await claimPolymarketManualExit({ position: position({ tokenId: '1002', outcome: 'No' }), userId: null }, { claimPositionExit: store.claimPositionExit });
        expect(yes).toMatchObject({ kind: 'won' });
        expect(no).toMatchObject({ kind: 'won' });
        expect(store.triggers).toEqual(['manual', 'manual']);
    });
});
//# sourceMappingURL=polymarket-exit-race.test.js.map