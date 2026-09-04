import { UnrecoverableError } from 'bullmq';
import type { Chain } from '@swat/shared';
import {
  decidePolymarketExit,
  type PolymarketExitClaimState,
  type PolymarketExitRaceDecision,
  type PolymarketExitTrigger
} from './polymarket-exit-race.js';
import {
  polymarketPositionKey,
  type PolymarketOutcomePosition
} from './polymarket-representation.js';

/**
 * Manual exit as the third entrant in the existing exit race (checklist
 * `S4-M45`), plus the per-chain catalogue that says which entrants a chain even
 * has.
 *
 * ## What was decided, and what this file is not
 *
 * All open positions exit when **any** of three things happens: the master sells,
 * the market resolves, or the user exits manually. A subscription lapsing does not
 * close positions — it moves the subscription to `winding_down`, where sells still
 * mirror.
 *
 * **This is one race with three entrants, not three paths.** `S4-M19` built a
 * single-winner-per-position claim for the master-sell / resolution pair;
 * `decidePolymarketExit` is that race and `claimPolymarketExit` is that claim.
 * This file adds **no** decision of its own for Polymarket: `decideManualExit`
 * validates the request, then *delegates* to `decidePolymarketExit` and forwards
 * whatever it says. A separate manual path would reintroduce exactly the
 * double-exit the claim exists to prevent, and a user tapping "exit" moments
 * before the master sells is the ordinary case, not the edge.
 *
 * ## The per-chain asymmetry, stated rather than smoothed over
 *
 * The three chains do not have the same three triggers, and pretending they do is
 * worse than three explicit paths. What is actually true:
 *
 * | chain | mirrored sell | manual exit | resolution |
 * |---|---|---|---|
 * | `solana` | Jupiter swap to base | Jupiter swap to base | **does not exist** |
 * | `robinhood-chain` | Uniswap V3 router swap to base | same router swap | **does not exist** |
 * | `polygon` | CLOB FAK sell into the book | same CLOB sell | CTF `redeemPositions` |
 *
 * Two facts fall out of that table and both are load-bearing:
 *
 *   1. **On every chain, the mirrored sell and the manual exit share one
 *      mechanism.** They are the same venue call with the same size; only the
 *      recorded trigger differs. That is why they can be two entrants in one race
 *      rather than two subsystems.
 *   2. **Resolution exists on one chain and shares its mechanism with nothing.**
 *      It is not "another sell": `redeemPositions({conditionId})` takes no amount,
 *      no price, and no side, redeems *both* outcomes of the condition at once, and
 *      only works because the market has stopped accepting orders. A design that
 *      called it a sell would have to invent a price for a thing with no book.
 *
 * So `resolution` is `null` in the catalogue for Solana and Robinhood Chain —
 * *absent*, not "false" — and `ExitTriggerObservation` makes `marketResolved`
 * `?: never` on those chains, so `{ chain: 'solana', marketResolved: false }` is a
 * **compile error** rather than a field nobody reads. `assertExitObservationHonest`
 * repeats the check at runtime for observations that arrived as JSON.
 *
 * ## Why a manual exit on Solana / Robinhood Chain currently fails closed
 *
 * The single-shot guard is a table, and today that table is `polymarket_position_exits`
 * (migration `055`) whose `exit_trigger` CHECK admits only `mirrored-sell` and
 * `redemption`. There is no equivalent for Solana or Robinhood Chain:
 * `signal_stop_losses` (`034`) is stop-loss-shaped — `threshold_pct` and
 * `drawdown_pct` are `NOT NULL` — so it cannot carry a manual exit, and
 * `copy_positions` is a quantity ledger with no claim semantics.
 *
 * Without a claim there is no way to make a manual exit single-shot, so
 * `decideManualExit` returns `unavailable` with its own code rather than an `exit`
 * the caller would act on. That is the same choice `unwiredPositionExitPort`
 * already makes one file over: refusing costs a stranded position and a loud log,
 * not refusing costs a double exit. The two codes are deliberately distinct from
 * every refusal, so an operator seeing `manual-exit-claim-ledger-absent` is sent to
 * a migration and not to a position.
 *
 * ## Deliberately not an input: the subscription's state
 *
 * `active`, `winding_down` and `ended` do not appear anywhere below. A manual exit
 * is the user's instruction about a position they hold, and gating it on
 * subscription state is how a lapsed user's position gets stranded with no exit —
 * the precise failure `S4-M45` exists to prevent. Subscription state decides
 * whether the *master's* trades are mirrored (`mirrorEligibilityForState`); it has
 * no business deciding whether a user may leave.
 *
 * Pure: no clock, no client, no database, no environment.
 */

/** Every exit trigger in the system. Superset; no chain has all of them by right. */
export type ExitTriggerName = PolymarketExitTrigger;

/**
 * How an exit is actually performed. Named per venue on purpose: the whole point
 * of the catalogue is that these are not interchangeable.
 */
export type ExitMechanism =
  /** `solana` — swap the position back to the base asset through Jupiter. */
  | 'solana-jupiter-swap-to-base'
  /** `robinhood-chain` — the same shape, through the Uniswap V3 router. */
  | 'robinhood-univ3-swap-to-base'
  /** `polygon` — a FAK sell of the outcome token into the CLOB book. */
  | 'polymarket-clob-sell-into-book'
  /** `polygon` — CTF `redeemPositions`. No amount, no price, no side, no book. */
  | 'polymarket-ctf-redeem-positions';

/** Where a chain's single-shot exit claim lives, or `null` when it has none. */
export type ExitClaimLedger = 'polymarket_position_exits';

export interface ChainExitTriggers {
  readonly chain: Chain;
  /** The master closed and we follow. Always present — it is the copy contract. */
  readonly mirroredSell: ExitMechanism;
  /** The user asked to leave. Always present; the mechanism differs per chain. */
  readonly manual: ExitMechanism;
  /**
   * `null` means the chain has **nothing to resolve** — not "resolution is
   * currently false". A token has no settlement date; a prediction market does.
   */
  readonly resolution: ExitMechanism | null;
  /** `null` means no position-scoped claim table exists for this chain yet. */
  readonly claimLedger: ExitClaimLedger | null;
  /**
   * What one row of the claim ledger is keyed by, so nobody assumes the keys are
   * interchangeable. Polymarket's position is an ERC-1155 outcome token
   * (`polygon:<tokenId>`, never the condition id — `S4-M20`); a token position on
   * the other two chains is keyed by the chain-prefixed mint in `copy_positions`.
   */
  readonly positionKeyKind: 'polymarket-outcome-token' | 'chain-prefixed-token-mint';
}

export const CHAIN_EXIT_TRIGGERS: Readonly<Record<Chain, ChainExitTriggers>> = Object.freeze({
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
} as const) as Readonly<Record<Chain, ChainExitTriggers>>;

export type ExitTriggerSupport =
  | { readonly kind: 'supported'; readonly mechanism: ExitMechanism }
  | {
    readonly kind: 'absent';
    readonly code: 'exit-trigger-absent-on-chain';
    readonly reason: string;
  };

/**
 * Whether a chain has a given exit trigger at all, and by what mechanism.
 *
 * `absent` is a real answer and not an error: asking whether Solana has a
 * resolution trigger is a reasonable question with the answer "no, there is
 * nothing to resolve". What would be an error is answering "yes, and it is
 * currently false".
 */
export function exitTriggerSupport(chain: Chain, trigger: ExitTriggerName): ExitTriggerSupport {
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
      reason:
        `chain ${chain} has no ${trigger} exit trigger: a token position has no `
        + 'settlement event, so there is nothing to resolve and nothing to redeem'
    };
  }
  return { kind: 'supported', mechanism };
}

/** The triggers a chain actually has, in race order. */
export function exitTriggersForChain(chain: Chain): readonly ExitTriggerName[] {
  const order: readonly ExitTriggerName[] = ['redemption', 'manual', 'mirrored-sell'];
  return order.filter((trigger) => exitTriggerSupport(chain, trigger).kind === 'supported');
}

/**
 * What we observed about each trigger that exists on this chain.
 *
 * The `?: never` members are the honesty guarantee. On Solana and Robinhood Chain
 * `marketResolved` is not merely always false — there is no such observation to
 * make — so writing it is a type error rather than a field the decision quietly
 * ignores.
 */
export type ExitTriggerObservation =
  | {
    readonly chain: 'solana' | 'robinhood-chain';
    readonly masterHoldsPosition: boolean | null;
    readonly manualExitRequested: boolean;
    readonly marketResolved?: never;
    readonly acceptingOrders?: never;
  }
  | {
    readonly chain: 'polygon';
    readonly masterHoldsPosition: boolean | null;
    readonly manualExitRequested: boolean;
    readonly marketResolved: boolean;
    readonly acceptingOrders: boolean;
  };

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
export function assertExitObservationHonest(observation: ExitTriggerObservation): void {
  if (observation.chain === 'polygon') return;
  const carried = ['marketResolved', 'acceptingOrders'].filter(
    (field) => (observation as Record<string, unknown>)[field] !== undefined
  );
  if (carried.length > 0) {
    throw new UnrecoverableError(
      `exit observation for ${observation.chain} carries ${carried.join(', ')}, but `
      + `${observation.chain} has no resolution trigger — a token position has no `
      + 'settlement event, so there is nothing to resolve'
    );
  }
}

export interface ManualExitInput {
  /**
   * The position's key in the chain's own key space. Checked against the
   * Polymarket position when one is supplied, so a condition id cannot be
   * smuggled in where an outcome token belongs.
   */
  readonly positionKey: string;
  /**
   * Shares we can prove we hold, or `null` when we have not read it.
   *
   * `null` is *unknown* and never zero — the distinction `resolveKnownBalanceUsd`
   * and `assessFunderIndependence` already make in this repo. Unknown fails
   * closed with its own code, because sizing a full exit off an unread balance is
   * how a sell gets sent for a quantity nobody verified.
   */
  readonly heldShares: number | null;
  readonly observation: ExitTriggerObservation;
  /** An exit already claimed for this position, if any. */
  readonly existingClaim: PolymarketExitClaimState | null;
  /**
   * Required on `polygon`: the race is keyed on the outcome token and the claim
   * needs the condition id alongside it. Ignored on the other two chains, which
   * have no outcome tokens.
   */
  readonly polymarketPosition?: PolymarketOutcomePosition;
}

/** A definite, request-specific "no". Nothing has been sent to any venue. */
export type ManualExitRefusalCode =
  /** Held quantity is known and is zero or negative. There is nothing to exit. */
  | 'manual-exit-nothing-held'
  /** `decideManualExit` was called without a manual request. A caller bug. */
  | 'manual-exit-not-requested'
  /** Another entrant already owns this position's exit. The race resolving. */
  | 'manual-exit-position-already-exiting'
  /** The supplied position key is not the key the outcome token hashes to. */
  | 'manual-exit-position-key-mismatch'
  /** The race declined to exit, and its own reason is forwarded rather than overridden. */
  | 'manual-exit-race-declined';

/** We could not answer. Says nothing about whether the position should exit. */
export type ManualExitUnavailableCode =
  /** Held quantity unread. Unknown is not zero, and it is not a licence to sell. */
  | 'manual-exit-held-shares-unread'
  /**
   * The chain has no position-scoped exit claim table, so the exit cannot be made
   * single-shot. Fails closed; the fix is a migration, not a retry.
   */
  | 'manual-exit-claim-ledger-absent'
  /** `polygon` request arrived without the outcome position the race is keyed on. */
  | 'manual-exit-polymarket-position-missing';

/** The exit is due. Which entrant won comes from the race, not from here. */
export type ManualExitProceedCode =
  /** The manual entrant won. The position sells into the open book. */
  | 'manual-exit-by-venue-sell'
  /**
   * Resolution outranked the manual request. The user's instruction is honoured,
   * but by redeeming — a sell into a resolved book cannot fill at any price.
   */
  | 'manual-exit-by-redemption';

export type ManualExitDecision =
  | {
    readonly kind: 'exit';
    /** Whichever entrant the race picked. `manual` or, on a resolved market, `redemption`. */
    readonly trigger: ExitTriggerName;
    readonly mechanism: ExitMechanism;
    readonly claimLedger: ExitClaimLedger;
    readonly code: ManualExitProceedCode;
    readonly reason: string;
  }
  | {
    readonly kind: 'refuse';
    readonly code: ManualExitRefusalCode;
    readonly reason: string;
  }
  | {
    readonly kind: 'unavailable';
    readonly code: ManualExitUnavailableCode;
    readonly reason: string;
  };

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
export function decideManualExit(input: ManualExitInput): ManualExitDecision {
  const { observation } = input;
  assertExitObservationHonest(observation);
  const catalogue = CHAIN_EXIT_TRIGGERS[observation.chain];

  if (!observation.manualExitRequested) {
    return {
      kind: 'refuse',
      code: 'manual-exit-not-requested',
      reason:
        `no manual exit was requested for ${input.positionKey}; the master-sell and `
        + 'resolution entrants reach the race through their own callers'
    };
  }

  if (input.heldShares === null) {
    return {
      kind: 'unavailable',
      code: 'manual-exit-held-shares-unread',
      reason:
        `held quantity for ${input.positionKey} is unread, and an unknown quantity is `
        + 'not a quantity to sell — unknown is not zero and it is not a licence'
    };
  }

  if (!Number.isFinite(input.heldShares) || input.heldShares <= 0) {
    return {
      kind: 'refuse',
      code: 'manual-exit-nothing-held',
      reason:
        `position ${input.positionKey} holds ${input.heldShares} provable units, so a `
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
      reason:
        `chain ${observation.chain} has no position-scoped exit claim table, so a manual `
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
      reason:
        `chain ${observation.chain} has a claim ledger but no Polymarket race to enter; `
        + 'a chain-generic race has not been built'
    };
  }

  const position = input.polymarketPosition;
  if (!position) {
    return {
      kind: 'unavailable',
      code: 'manual-exit-polymarket-position-missing',
      reason:
        `manual exit of ${input.positionKey} on polygon arrived without its outcome `
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
      reason:
        `manual exit was requested for ${input.positionKey} but its outcome token keys `
        + `to ${derivedKey}; a condition holds two outcomes and they are two positions`
    };
  }

  const race: PolymarketExitRaceDecision = decidePolymarketExit({
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
    throw new UnrecoverableError(
      `the exit race chose ${race.trigger} for ${input.positionKey}, but chain `
      + `${observation.chain} has no mechanism for it`
    );
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
