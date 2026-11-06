import { UnrecoverableError } from 'bullmq';
import { decidePolymarketExit } from './polymarket-exit-race.js';
import { polymarketPositionKey } from './polymarket-representation.js';
export const CHAIN_EXIT_TRIGGERS = Object.freeze({
    solana: Object.freeze({
        chain: 'solana',
        mirroredSell: 'solana-jupiter-swap-to-base',
        manual: 'solana-jupiter-swap-to-base',
        resolution: null,
        claimLedger: null,
        positionKeyKind: 'chain-prefixed-token-mint'
    }),
    'robinhood-chain': Object.freeze({
        chain: 'robinhood-chain',
        mirroredSell: 'robinhood-univ3-swap-to-base',
        manual: 'robinhood-univ3-swap-to-base',
        resolution: null,
        claimLedger: null,
        positionKeyKind: 'chain-prefixed-token-mint'
    }),
    polygon: Object.freeze({
        chain: 'polygon',
        mirroredSell: 'polymarket-clob-sell-into-book',
        manual: 'polymarket-clob-sell-into-book',
        resolution: 'polymarket-ctf-redeem-positions',
        claimLedger: 'polymarket_position_exits',
        positionKeyKind: 'polymarket-outcome-token'
    })
});
/**
 * Whether a chain has a given exit trigger at all, and by what mechanism.
 *
 * `absent` is a real answer and not an error: asking whether Solana has a
 * resolution trigger is a reasonable question with the answer "no, there is
 * nothing to resolve". What would be an error is answering "yes, and it is
 * currently false".
 */
export function exitTriggerSupport(chain, trigger) {
    const catalogue = CHAIN_EXIT_TRIGGERS[chain];
    const mechanism = trigger === 'redemption'
        ? catalogue.resolution
        : trigger === 'manual'
            ? catalogue.manual
            : catalogue.mirroredSell;
    if (!mechanism) {
        return {
            kind: 'absent',
            code: 'exit-trigger-absent-on-chain',
            reason: `chain ${chain} has no ${trigger} exit trigger: a token position has no `
                + 'settlement event, so there is nothing to resolve and nothing to redeem'
        };
    }
    return { kind: 'supported', mechanism };
}
/** The triggers a chain actually has, in race order. */
export function exitTriggersForChain(chain) {
    const order = ['redemption', 'manual', 'mirrored-sell'];
    return order.filter((trigger) => exitTriggerSupport(chain, trigger).kind === 'supported');
}
/**
 * The runtime half of the `?: never` guarantee.
 *
 * The compile-time union only protects code written against these types. An
 * observation assembled from a job payload or a database row arrives as `unknown`
 * and can carry a `marketResolved` for Solana, which would mean somebody built a
 * resolution axis for a chain that has none. Thrown rather than refused: it is a
 * defect in the caller, not a state of the position, and the same
 * `UnrecoverableError` shape `mapPolymarketRedemptionToPositions` uses.
 */
export function assertExitObservationHonest(observation) {
    if (observation.chain === 'polygon')
        return;
    const carried = ['marketResolved', 'acceptingOrders'].filter((field) => observation[field] !== undefined);
    if (carried.length > 0) {
        throw new UnrecoverableError(`exit observation for ${observation.chain} carries ${carried.join(', ')}, but `
            + `${observation.chain} has no resolution trigger — a token position has no `
            + 'settlement event, so there is nothing to resolve');
    }
}
/**
 * Decide what a user's manual exit request does to one position.
 *
 * **Delegation, not decision.** For Polymarket every outcome below that involves
 * an exit comes out of `decidePolymarketExit` — the same function the mirrored
 * sell and the redemption sweep consult, with the same single-shot guard above
 * every rung. What this function adds is only the part the race has no opinion on:
 * does this chain have a manual mechanism, does it have a claim ledger to make the
 * exit single-shot, and do we know what we hold.
 *
 * Read the code list, not the prose: `refuse` means we answered "no" about this
 * request, `unavailable` means we could not answer at all, and the two must not be
 * collapsed — an operator debugging a stranded position needs to know whether the
 * position is fine and the request was rejected, or whether the machinery could
 * not run.
 */
export function decideManualExit(input) {
    const { observation } = input;
    assertExitObservationHonest(observation);
    const catalogue = CHAIN_EXIT_TRIGGERS[observation.chain];
    if (!observation.manualExitRequested) {
        return {
            kind: 'refuse',
            code: 'manual-exit-not-requested',
            reason: `no manual exit was requested for ${input.positionKey}; the master-sell and `
                + 'resolution entrants reach the race through their own callers'
        };
    }
    if (input.heldShares === null) {
        return {
            kind: 'unavailable',
            code: 'manual-exit-held-shares-unread',
            reason: `held quantity for ${input.positionKey} is unread, and an unknown quantity is `
                + 'not a quantity to sell — unknown is not zero and it is not a licence'
        };
    }
    if (!Number.isFinite(input.heldShares) || input.heldShares <= 0) {
        return {
            kind: 'refuse',
            code: 'manual-exit-nothing-held',
            reason: `position ${input.positionKey} holds ${input.heldShares} provable units, so a `
                + 'manual exit has nothing to sell'
        };
    }
    if (!catalogue.claimLedger) {
        // Fail closed. Same choice as `unwiredPositionExitPort`: without a
        // position-scoped claim two entrants can both exit one position, and a user's
        // position sold twice is worse than a user's exit refused once.
        return {
            kind: 'unavailable',
            code: 'manual-exit-claim-ledger-absent',
            reason: `chain ${observation.chain} has no position-scoped exit claim table, so a manual `
                + `exit of ${input.positionKey} cannot be made single-shot; refusing rather than `
                + 'racing an unguarded exit against the master sell mirror'
        };
    }
    if (observation.chain !== 'polygon') {
        // Unreachable today: `polygon` is the only chain with a claim ledger, so the
        // guard above already returned. Kept as a typed dead end rather than a cast,
        // so adding a ledger for another chain surfaces here instead of falling into
        // the Polymarket branch with no outcome token.
        return {
            kind: 'unavailable',
            code: 'manual-exit-claim-ledger-absent',
            reason: `chain ${observation.chain} has a claim ledger but no Polymarket race to enter; `
                + 'a chain-generic race has not been built'
        };
    }
    const position = input.polymarketPosition;
    if (!position) {
        return {
            kind: 'unavailable',
            code: 'manual-exit-polymarket-position-missing',
            reason: `manual exit of ${input.positionKey} on polygon arrived without its outcome `
                + 'position, and the race is keyed on the outcome token rather than the key string'
        };
    }
    const derivedKey = polymarketPositionKey(position);
    if (derivedKey !== input.positionKey) {
        // The `S4-M20` collapse, caught before a claim is taken. A condition id where
        // an outcome token belongs would exit the wrong side of the market.
        return {
            kind: 'refuse',
            code: 'manual-exit-position-key-mismatch',
            reason: `manual exit was requested for ${input.positionKey} but its outcome token keys `
                + `to ${derivedKey}; a condition holds two outcomes and they are two positions`
        };
    }
    const race = decidePolymarketExit({
        position,
        heldShares: input.heldShares,
        masterHoldsPosition: observation.masterHoldsPosition,
        marketResolved: observation.marketResolved,
        acceptingOrders: observation.acceptingOrders,
        manualExitRequested: true,
        existingClaim: input.existingClaim
    });
    if (race.kind === 'already-exiting') {
        return {
            kind: 'refuse',
            code: 'manual-exit-position-already-exiting',
            reason: race.reason
        };
    }
    if (race.kind === 'hold') {
        // Forwarded rather than reinterpreted. The race is the authority on whether an
        // exit is due, and overriding it here would be the second decision function
        // this module exists not to be.
        return {
            kind: 'refuse',
            code: 'manual-exit-race-declined',
            reason: race.reason
        };
    }
    const mechanism = race.trigger === 'redemption'
        ? catalogue.resolution
        : catalogue.manual;
    if (!mechanism) {
        throw new UnrecoverableError(`the exit race chose ${race.trigger} for ${input.positionKey}, but chain `
            + `${observation.chain} has no mechanism for it`);
    }
    return {
        kind: 'exit',
        trigger: race.trigger,
        mechanism,
        claimLedger: catalogue.claimLedger,
        code: race.trigger === 'redemption'
            ? 'manual-exit-by-redemption'
            : 'manual-exit-by-venue-sell',
        reason: race.reason
    };
}
//# sourceMappingURL=manual-exit.js.map