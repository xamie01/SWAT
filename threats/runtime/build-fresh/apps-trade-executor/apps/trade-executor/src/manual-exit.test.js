import { describe, expect, it } from 'vitest';
import { CHAIN_EXIT_TRIGGERS, assertExitObservationHonest, decideManualExit, exitTriggerSupport, exitTriggersForChain } from './manual-exit.js';
/**
 * `S4-M45` — manual exit as the third entrant, and the per-chain catalogue that
 * says which entrants a chain has at all.
 *
 * Pure throughout: no database, no venue, no clock. The Polymarket race decisions
 * are asserted in `polymarket-exit-race.test.ts` — what is asserted here is that
 * this module *delegates* to that race rather than deciding anything itself, and
 * that the chain asymmetry is expressed rather than smoothed over.
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
function polygonObservation(overrides = {}) {
    return {
        chain: 'polygon',
        masterHoldsPosition: true,
        manualExitRequested: true,
        marketResolved: false,
        acceptingOrders: true,
        ...overrides
    };
}
function polygonInput(overrides = {}) {
    return {
        positionKey: 'polygon:1001',
        heldShares: 40,
        observation: polygonObservation(),
        existingClaim: null,
        polymarketPosition: position(),
        ...overrides
    };
}
describe('the per-chain trigger catalogue', () => {
    it('Solana has no resolution trigger — absent, not false', () => {
        // The asymmetry the item insists on. A token position has no settlement event,
        // so `resolution` is null rather than a boolean nobody sets.
        expect(CHAIN_EXIT_TRIGGERS.solana.resolution).toBeNull();
        expect(exitTriggerSupport('solana', 'redemption')).toMatchObject({
            kind: 'absent',
            code: 'exit-trigger-absent-on-chain'
        });
        expect(exitTriggersForChain('solana')).toEqual(['manual', 'mirrored-sell']);
    });
    it('Robinhood Chain has the same two triggers as Solana, by a different router', () => {
        expect(CHAIN_EXIT_TRIGGERS['robinhood-chain'].resolution).toBeNull();
        expect(exitTriggersForChain('robinhood-chain')).toEqual(['manual', 'mirrored-sell']);
        expect(CHAIN_EXIT_TRIGGERS['robinhood-chain'].manual).toBe('robinhood-univ3-swap-to-base');
        expect(CHAIN_EXIT_TRIGGERS.solana.manual).toBe('solana-jupiter-swap-to-base');
    });
    it('Polymarket has all three, and redemption shares its mechanism with nothing', () => {
        expect(exitTriggersForChain('polygon')).toEqual(['redemption', 'manual', 'mirrored-sell']);
        const polygon = CHAIN_EXIT_TRIGGERS.polygon;
        expect(polygon.resolution).toBe('polymarket-ctf-redeem-positions');
        // Redemption is not "another sell": no amount, no price, no side, no book.
        expect(polygon.resolution).not.toBe(polygon.manual);
        expect(polygon.resolution).not.toBe(polygon.mirroredSell);
    });
    it('on every chain the mirrored sell and the manual exit share one mechanism', () => {
        // This is why they can be two entrants in one race rather than two subsystems:
        // the same venue call with the same size, differing only in what is recorded.
        for (const catalogue of Object.values(CHAIN_EXIT_TRIGGERS)) {
            expect(catalogue.manual).toBe(catalogue.mirroredSell);
        }
    });
    it('the position key kind differs per chain and is stated rather than assumed', () => {
        expect(CHAIN_EXIT_TRIGGERS.polygon.positionKeyKind).toBe('polymarket-outcome-token');
        expect(CHAIN_EXIT_TRIGGERS.solana.positionKeyKind).toBe('chain-prefixed-token-mint');
    });
    it('only Polymarket has a claim ledger today', () => {
        expect(CHAIN_EXIT_TRIGGERS.polygon.claimLedger).toBe('polymarket_position_exits');
        expect(CHAIN_EXIT_TRIGGERS.solana.claimLedger).toBeNull();
        expect(CHAIN_EXIT_TRIGGERS['robinhood-chain'].claimLedger).toBeNull();
    });
});
describe('assertExitObservationHonest', () => {
    it('throws when a non-Polymarket observation carries a resolution axis', () => {
        // The compile-time `?: never` only protects code written against the types. An
        // observation built from a job payload arrives as data, and a `marketResolved`
        // on Solana means somebody invented a resolution axis for a chain with none.
        const smuggled = {
            chain: 'solana',
            masterHoldsPosition: true,
            manualExitRequested: true,
            marketResolved: true
        };
        expect(() => assertExitObservationHonest(smuggled)).toThrow(/has no resolution trigger/);
    });
    it('accepts an honest Solana observation and an honest Polymarket one', () => {
        expect(() => assertExitObservationHonest({
            chain: 'solana',
            masterHoldsPosition: true,
            manualExitRequested: true
        })).not.toThrow();
        expect(() => assertExitObservationHonest(polygonObservation())).not.toThrow();
    });
});
describe('decideManualExit — Polymarket, delegating to the one race', () => {
    it('enters the race and exits by the manual trigger on an open book', () => {
        expect(decideManualExit(polygonInput())).toMatchObject({
            kind: 'exit',
            trigger: 'manual',
            mechanism: 'polymarket-clob-sell-into-book',
            claimLedger: 'polymarket_position_exits',
            code: 'manual-exit-by-venue-sell'
        });
    });
    it('a manual exit racing a master sell resolves to exactly one exit', () => {
        // The decided design, at this layer: one call, one decision, one trigger. The
        // claim-level half of the same assertion is in `polymarket-exit-race.test.ts`.
        const decision = decideManualExit(polygonInput({
            observation: polygonObservation({ masterHoldsPosition: false })
        }));
        expect(decision).toMatchObject({ kind: 'exit', trigger: 'manual' });
    });
    it('stands down when another entrant already holds the claim', () => {
        const decision = decideManualExit(polygonInput({
            existingClaim: { trigger: 'redemption', status: 'claimed' }
        }));
        expect(decision).toMatchObject({
            kind: 'refuse',
            code: 'manual-exit-position-already-exiting'
        });
        // The forwarded reason is the race's own, not a second sentence written here.
        expect(decision.reason).toMatch(/one winner per position/);
    });
    it('honours a manual request on a resolved market by redeeming, not selling', () => {
        const decision = decideManualExit(polygonInput({
            observation: polygonObservation({ marketResolved: true })
        }));
        expect(decision).toMatchObject({
            kind: 'exit',
            trigger: 'redemption',
            mechanism: 'polymarket-ctf-redeem-positions',
            code: 'manual-exit-by-redemption'
        });
    });
    it('refuses a request for a position we hold nothing of', () => {
        expect(decideManualExit(polygonInput({ heldShares: 0 }))).toMatchObject({
            kind: 'refuse',
            code: 'manual-exit-nothing-held'
        });
    });
    it('separates an unread held quantity from a zero one', () => {
        // Unknown is not zero. A refusal says the position is fine and the request was
        // rejected; `unavailable` says the machinery could not answer, and sending an
        // operator to the wrong one of those is the cost of collapsing them.
        expect(decideManualExit(polygonInput({ heldShares: null }))).toMatchObject({
            kind: 'unavailable',
            code: 'manual-exit-held-shares-unread'
        });
    });
    it('refuses when no manual exit was actually requested', () => {
        expect(decideManualExit(polygonInput({
            observation: polygonObservation({ manualExitRequested: false })
        }))).toMatchObject({ kind: 'refuse', code: 'manual-exit-not-requested' });
    });
    it('refuses a position key that is not the key the outcome token hashes to', () => {
        // The `S4-M20` collapse, caught before a claim is taken: a condition id where an
        // outcome token belongs would exit the wrong side of the market.
        expect(decideManualExit(polygonInput({ positionKey: `polygon:${CONDITION}` }))).toMatchObject({
            kind: 'refuse',
            code: 'manual-exit-position-key-mismatch'
        });
    });
    it('reports the missing outcome position rather than guessing one', () => {
        expect(decideManualExit(polygonInput({ polymarketPosition: undefined }))).toMatchObject({
            kind: 'unavailable',
            code: 'manual-exit-polymarket-position-missing'
        });
    });
    it('does not need the master cross-reference to be readable', () => {
        expect(decideManualExit(polygonInput({
            observation: polygonObservation({ masterHoldsPosition: null })
        }))).toMatchObject({ kind: 'exit', trigger: 'manual' });
    });
    it('forwards a race hold rather than overriding it', () => {
        // There is no reachable hold with a manual request live today — rung 0 is
        // caught above as `manual-exit-nothing-held` — so this pins the contract: if
        // the race ever declines, its reason is forwarded and not reinterpreted here.
        const decision = decideManualExit(polygonInput({ heldShares: Number.NaN }));
        expect(decision.kind).toBe('refuse');
    });
});
describe('decideManualExit — chains with no claim ledger fail closed', () => {
    const solana = {
        chain: 'solana',
        masterHoldsPosition: true,
        manualExitRequested: true
    };
    it('refuses a Solana manual exit as unavailable, naming the missing ledger', () => {
        // Fail closed, the same choice `unwiredPositionExitPort` makes for redemption:
        // without a position-scoped claim two entrants can both exit one position, and
        // a position sold twice is worse than an exit refused once. `unavailable`
        // rather than `refuse` because the position is fine — the machinery is missing.
        const decision = decideManualExit({
            positionKey: 'solana:So11111111111111111111111111111111111111112',
            heldShares: 12,
            observation: solana,
            existingClaim: null
        });
        expect(decision).toMatchObject({
            kind: 'unavailable',
            code: 'manual-exit-claim-ledger-absent'
        });
        expect(decision.reason).toMatch(/single-shot/);
    });
    it('refuses a Robinhood Chain manual exit for the same reason', () => {
        expect(decideManualExit({
            positionKey: 'robinhood-chain:0xabc',
            heldShares: 12,
            observation: {
                chain: 'robinhood-chain',
                masterHoldsPosition: false,
                manualExitRequested: true
            },
            existingClaim: null
        })).toMatchObject({ kind: 'unavailable', code: 'manual-exit-claim-ledger-absent' });
    });
    it('still checks the cheap request-level refusals before the ledger gap', () => {
        // Order matters for the operator reading the code: "you hold nothing" is a
        // fact about this request and is worth saying even on a chain whose ledger is
        // missing, because it is not the migration that would fix it.
        expect(decideManualExit({
            positionKey: 'solana:So11111111111111111111111111111111111111112',
            heldShares: 0,
            observation: solana,
            existingClaim: null
        })).toMatchObject({ kind: 'refuse', code: 'manual-exit-nothing-held' });
    });
    it('throws on a Solana observation that smuggled in a resolution axis', () => {
        expect(() => decideManualExit({
            positionKey: 'solana:So11111111111111111111111111111111111111112',
            heldShares: 12,
            observation: {
                chain: 'solana',
                masterHoldsPosition: true,
                manualExitRequested: true,
                acceptingOrders: false
            },
            existingClaim: null
        })).toThrow(/has no resolution trigger/);
    });
});
describe('stable outcome codes', () => {
    it('every code this module can return is distinct', () => {
        const solana = {
            chain: 'solana',
            masterHoldsPosition: true,
            manualExitRequested: true
        };
        const codes = [
            decideManualExit(polygonInput()),
            decideManualExit(polygonInput({ observation: polygonObservation({ marketResolved: true }) })),
            decideManualExit(polygonInput({ heldShares: 0 })),
            decideManualExit(polygonInput({ heldShares: null })),
            decideManualExit(polygonInput({ observation: polygonObservation({ manualExitRequested: false }) })),
            decideManualExit(polygonInput({ existingClaim: { trigger: 'manual', status: 'claimed' } })),
            decideManualExit(polygonInput({ positionKey: 'polygon:9999' })),
            decideManualExit(polygonInput({ polymarketPosition: undefined })),
            decideManualExit({
                positionKey: 'solana:mint',
                heldShares: 5,
                observation: solana,
                existingClaim: null
            })
        ].map((decision) => decision.code);
        expect(codes).toEqual([
            'manual-exit-by-venue-sell',
            'manual-exit-by-redemption',
            'manual-exit-nothing-held',
            'manual-exit-held-shares-unread',
            'manual-exit-not-requested',
            'manual-exit-position-already-exiting',
            'manual-exit-position-key-mismatch',
            'manual-exit-polymarket-position-missing',
            'manual-exit-claim-ledger-absent'
        ]);
        expect(new Set(codes).size).toBe(codes.length);
    });
});
//# sourceMappingURL=manual-exit.test.js.map