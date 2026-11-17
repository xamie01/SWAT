import type { PoolClient, QueryResultRow } from 'pg';
import type { Chain } from '@swat/shared';
import { DEFAULT_SLIPPAGE_BPS } from '@swat/shared';
import { query } from './client.js';
import type { QuoteCurrency } from './quote-valuation.js';

/**
 * Per-master capacity cap, denominated in **price impact** (`S4-M6`, migration
 * `053`).
 *
 * ── The harm ──────────────────────────────────────────────────────────────
 *
 * Our own cohort is the adverse selection. When one master's trade fans out to
 * hundreds of followers, the copies land as one directional order on the same
 * pair inside a few minutes. User #900 buys at a price users #1-899 created.
 * A master who notices can farm it deliberately: buy small, wait for the copy
 * flow to lift the price, sell into their own followers.
 *
 * ── Why not follower count ────────────────────────────────────────────────
 *
 * Follower count is the wrong unit. 500 followers buying a deep pair move it by
 * basis points; 50 buying a fresh memecoin move it by tens of percent. The
 * quantity that actually describes the harm is **aggregate copy notional as a
 * fraction of usable liquidity**, which is what this module caps.
 *
 * A follower soft-cap survives as a **crude secondary** (`followerSoftCap`) so
 * that no single master becomes an operational concentration risk regardless of
 * what they trade. It is crude on purpose and labelled as such: it knows nothing
 * about the venue. Both layers bind independently — neither is a fallback for
 * the other, and the secondary is the only layer left standing when liquidity is
 * unknown, which is exactly when it earns its keep.
 *
 * ── Uniform skip: an encoding, not a promise ──────────────────────────────
 *
 * When capacity binds, **everyone is skipped uniformly** (ADR-0005 4.2-4.4, and
 * `S4-M7`). There is no tier priority, no first-come admission, no per-user
 * ordering. That is enforced structurally rather than by review:
 *
 *   * `MasterCapacityInput` contains **no per-user field whatsoever** — no user
 *     id, no tier, no plan, no target account, no per-user requested notional.
 *     The decision is a property of the (master, token, window) triple.
 *   * `assertNoPerUserCapacityInput` re-checks that at runtime by key name and
 *     throws, so a future field called `userTier` cannot be threaded in quietly.
 *   * The impact cap is derived from the **chain default** slippage tolerance,
 *     never from any user's own tolerance, so a looser user cannot buy a bigger
 *     cohort allowance.
 *
 * A function that cannot see a tier cannot prioritise by one.
 *
 * ── Two messages, one decision ────────────────────────────────────────────
 *
 * Every decision carries both `user.message` (generic, digit-free, drawn from a
 * frozen constant) and `internal.code` + `internal.detail` (specific, with
 * figures). They are returned together so a caller cannot reach for the wrong
 * one, and `internal` is nested under a name that makes rendering it to a user
 * obvious in review. Nothing under `internal` is ever user-visible.
 *
 * Follower counts are **never displayed** (`S4-M9`), and a capacity figure must
 * not become a way to infer one: the follower count appears only under
 * `internal`, and the user string carries no digits at all.
 *
 * ── Pure / DB split ───────────────────────────────────────────────────────
 *
 * Everything above `--- DB ---` is pure: no clock, no database, no network.
 * `assessMasterCapacity` takes liquidity, the accounted notional and the
 * follower count as **injected inputs**. Below `--- DB ---` are three thin
 * readers/writers over `053`'s tables and nothing else.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Liquidity: what actually exists, and what does not
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Where a usable-liquidity figure came from — because on two of three venues,
 * at fan-out decision time, the honest answer is "nowhere".
 *
 * This enum is the most important type in the module. A capacity cap that
 * silently substitutes a fabricated liquidity number is worse than no cap: it
 * would block everything or permit everything while looking like a control.
 *
 * **What this repo actually has, verified rather than assumed:**
 *
 *   * `fetchDexScreenerLiquidity(mint, chain)` (`packages/shared/src/prices.ts`)
 *     returns DexScreener's `liquidity.usd` for the **deepest single pair** on
 *     the chain. It is already called at decision time by
 *     `apps/signal-engine/src/safety.ts` for the low-liquidity flag, so the call
 *     is proven to work on this path. It is a **pool TVL**, both sides summed —
 *     not depth, not a quote, and not persisted in any table (no column in
 *     `packages/db/sql/` holds a liquidity figure; only the `min_liquidity_usd`
 *     threshold in `config`). It returns `null` when no pair matches.
 *   * Jupiter's quote carries a real per-trade `priceImpactPct`
 *     (`packages/shared/src/jupiter.ts`, persisted to `trades.price_impact_pct`
 *     by `007`). It is Solana-only, it is per order, and it is obtained inside
 *     the executor at simulation time — after fan-out has already been decided.
 *   * Polymarket's order book gives genuine depth, and the executor already
 *     walks it against a bps bound (`apps/trade-executor/src/polymarket.ts`).
 *     Also at submission time, also per order. Polymarket outcome tokens trade
 *     on Polymarket's own CLOB rather than on a DEX pair, so the DexScreener
 *     route is not expected to cover them — that is a property of the venue and
 *     is NOT something this repo verifies, so treat it as reasoning to confirm
 *     rather than a measured fact. Either way the AMM route returning `null` is
 *     handled: it becomes `basis: 'unknown'`, not a zero.
 *
 * So: a *pool-TVL* figure exists for AMM pairs and nothing exists before
 * fan-out for Polymarket. Both are injected here with the basis attached.
 */
export type UsableLiquidityBasis =
  /**
   * DexScreener pool TVL for the deepest pair, converted to a one-sided
   * quote reserve by `usableLiquidityFromPoolTvlUsd`. Approximate: it is one
   * pair rather than all routes, it is a reported TVL rather than a quote, and
   * for a concentrated-liquidity pool the constant-product model below is only
   * a rough guide.
   */
  | 'amm-pool-tvl'
  /**
   * Resting size within a price bound, summed from an order book. This is the
   * *right* number for Polymarket and **nothing in this repo supplies it before
   * fan-out** — the book is read inside the executor at submission. Accepted
   * here so that wiring a pre-fan-out book read later needs no change to this
   * module.
   */
  | 'order-book-depth'
  /**
   * No figure. Not zero, not "thin" — unknown. Routed to the unassessable path,
   * never treated as a number.
   */
  | 'unknown';

export interface UsableLiquidity {
  readonly chain: Chain;
  readonly tokenMint: string;
  /**
   * USD notional that can be absorbed on **one side** of the market — the quote
   * reserve for an AMM, resting size within the bound for a book. `null`
   * whenever the basis is `unknown`, and `null` is never coerced to 0.
   */
  readonly usableLiquidityUsd: number | null;
  readonly basis: UsableLiquidityBasis;
  /** True when the figure stands in for something more precise. */
  readonly approximate: boolean;
  /** Where it came from, for the operator reading a skip they doubt. */
  readonly note: string;
}

/**
 * A liquidity input for a token nobody can price. The only honest constructor
 * when the fetch failed or the venue has no pre-trade depth feed.
 */
export function unknownLiquidity(
  chain: Chain,
  tokenMint: string,
  note: string
): UsableLiquidity {
  return Object.freeze({
    chain,
    tokenMint,
    usableLiquidityUsd: null,
    basis: 'unknown' as const,
    approximate: false,
    note
  });
}

/**
 * Converts a both-sided pool TVL into the one-sided reserve the impact model
 * needs, i.e. halves it.
 *
 * DexScreener's `liquidity.usd` values both legs of the pair. For a balanced
 * constant-product pool the quote reserve is half of it. For a pool that is not
 * balanced this is wrong in whichever direction the imbalance runs, which is
 * one of the reasons the result is marked `approximate`.
 */
export function usableLiquidityFromPoolTvlUsd(
  chain: Chain,
  tokenMint: string,
  poolTvlUsd: number | null
): UsableLiquidity {
  if (poolTvlUsd === null || !Number.isFinite(poolTvlUsd) || poolTvlUsd <= 0) {
    return unknownLiquidity(
      chain,
      tokenMint,
      'DexScreener returned no usable pool TVL for this token (fetchDexScreenerLiquidity '
        + 'gave null, zero or a non-finite value). Treated as unknown, not as zero.'
    );
  }
  return Object.freeze({
    chain,
    tokenMint,
    usableLiquidityUsd: poolTvlUsd / 2,
    basis: 'amm-pool-tvl' as const,
    approximate: true,
    note:
      'Half of DexScreener liquidity.usd for the deepest pair on this chain '
      + '(fetchDexScreenerLiquidity in packages/shared/src/prices.ts). A reported '
      + 'both-sided TVL for one pair, not a quote and not summed across routes; the '
      + 'one-sided reserve is approximated as TVL/2.'
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// The impact model
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execution price impact, in basis points, of pushing `notionalUsd` of one-way
 * flow through a pool whose one-sided quote reserve is `usableLiquidityUsd`.
 *
 * **Constant product, derived rather than guessed.** For x*y = k with quote
 * reserve x, swapping in dx returns dy = y*dx/(x+dx). The average execution
 * price is dx/dy = (x+dx)/y, and the spot price is x/y, so the ratio is exactly
 * 1 + dx/x. Execution impact is therefore `notional / reserve`, with no
 * approximation in the algebra itself. (The *marginal* post-trade price moves by
 * (1+dx/x)^2 - 1, roughly twice as much; the average is the right one to cap,
 * because it is what the cohort actually pays.)
 *
 * **What the model does not capture**, stated so nobody reads the output as
 * measured: concentrated liquidity (Uniswap V3, which is what Robinhood Chain
 * routes through) can be far thinner or far deeper than a constant-product pool
 * of the same TVL depending on where the range sits; Jupiter splits across
 * routes, so the deepest pair understates real depth; and an order book is not a
 * curve at all, so this formula is only appropriate for `amm-pool-tvl`. When the
 * basis is `order-book-depth` the injected figure is already a depth-within-bound
 * and the same ratio is a reasonable reading of "fraction of the book consumed".
 */
export function priceImpactBps(notionalUsd: number, usableLiquidityUsd: number): number {
  if (!Number.isFinite(notionalUsd) || notionalUsd < 0) {
    throw new MasterCapacityInputError(
      `notionalUsd must be a non-negative finite number, got ${notionalUsd}`
    );
  }
  if (!Number.isFinite(usableLiquidityUsd) || usableLiquidityUsd <= 0) {
    throw new MasterCapacityInputError(
      `usableLiquidityUsd must be a positive finite number, got ${usableLiquidityUsd}`
    );
  }
  return (notionalUsd / usableLiquidityUsd) * 10_000;
}

/** The inverse: the notional that exactly reaches `capBps` of impact. */
export function capacityNotionalUsd(usableLiquidityUsd: number, capBps: number): number {
  if (!Number.isFinite(usableLiquidityUsd) || usableLiquidityUsd <= 0) {
    throw new MasterCapacityInputError(
      `usableLiquidityUsd must be a positive finite number, got ${usableLiquidityUsd}`
    );
  }
  if (!Number.isFinite(capBps) || capBps <= 0) {
    throw new MasterCapacityInputError(`capBps must be a positive finite number, got ${capBps}`);
  }
  return (usableLiquidityUsd * capBps) / 10_000;
}

// ═══════════════════════════════════════════════════════════════════════════
// Platform limits
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The share of a chain's **default** slippage tolerance that the cohort's own
 * self-inflicted impact is allowed to consume.
 *
 * **The shape of the argument is real; the fraction is a judgement.** Stated
 * plainly so nobody reads 1/3 as measured.
 *
 * The argument: a copier's slippage tolerance is the budget protecting them from
 * an unfavourable fill. Impact the cohort *creates* is spent out of that same
 * budget. If the cohort moves the pair by the full tolerance, the last copiers
 * fail their own slippage check and the fan-out ends in a burst of failures
 * instead of a skip — which is precisely the degradation `S4-P15` says to avoid.
 * So the cohort must leave most of the tolerance for the market's own movement
 * and the venue spread, and the cap is a fraction of it rather than all of it.
 *
 * Deliberately the **chain default** (`DEFAULT_SLIPPAGE_BPS`, `S4-P4`) and never
 * a user's own value: a per-user input would make the cohort allowance depend on
 * who happens to be in the cohort, which is the uniform-skip rule broken at the
 * root.
 */
export const AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE = 1 / 3;

/**
 * Platform ceiling on aggregate cohort price impact per (master, token, window),
 * in bps, per chain.
 *
 * Derived from `DEFAULT_SLIPPAGE_BPS` so that retuning `S4-P4` moves this in
 * step instead of leaving a stale literal behind. Typed `Record<Chain, number>`
 * so adding a chain to the union fails to compile until somebody decides its
 * ceiling — a silent `undefined` here would disable the cap for the new chain.
 *
 * At the time of writing that yields 500 bps on Solana (1500 default), 100 on
 * polygon and 100 on robinhood-chain (300 each).
 */
export const PLATFORM_MAX_AGGREGATE_IMPACT_BPS: Readonly<Record<Chain, number>> = Object.freeze({
  solana: Math.floor(DEFAULT_SLIPPAGE_BPS.solana * AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE),
  polygon: Math.floor(DEFAULT_SLIPPAGE_BPS.polygon * AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE),
  'robinhood-chain': Math.floor(
    DEFAULT_SLIPPAGE_BPS['robinhood-chain'] * AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE
  ),
  base: Math.floor(DEFAULT_SLIPPAGE_BPS.base * AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE),
  ethereum: Math.floor(DEFAULT_SLIPPAGE_BPS.ethereum * AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE),
  bsc: Math.floor(DEFAULT_SLIPPAGE_BPS.bsc * AGGREGATE_IMPACT_SHARE_OF_SLIPPAGE)
});

/**
 * The crude secondary: how many followers one master may fan out to on one
 * chain before the *operational* concentration risk binds, whatever they trade.
 *
 * **Crude by construction.** It knows nothing about the venue or the size of the
 * trade, which is the whole reason the primary cap exists. It is here because
 * the primary cap cannot see the queue: 500 tiny copies of a deep pair pass the
 * impact test and still put 500 orders behind one worker.
 *
 * 50 is the same drain arithmetic as `PLATFORM_MAX_CONCURRENT_POSITIONS` in
 * `position-cap.ts`, reused deliberately so there is one estimate rather than
 * two: each chain's trade queue is served by exactly one concurrency-1 worker
 * (`TRADE_QUEUES_BY_CHAIN`), a conservative 6 seconds per order drains about 50
 * per 5-minute mark-to-market window, and a fan-out wider than that cannot
 * clear one window. **The 6-second figure is an estimate, not a measurement** —
 * nothing in this repo records observed submission latency — so this inherits
 * that caveat exactly, and it is a *soft* cap for that reason.
 */
export const DEFAULT_FOLLOWER_SOFT_CAP = 50;

/**
 * Named windows, with their derivations. `windowMs` is a **required** input, not
 * a defaulted one, so a caller has to choose knowingly.
 *
 * Neither is measured; both are anchored to something real in this repo.
 */
export const MASTER_CAPACITY_WINDOWS = Object.freeze({
  /**
   * One master event's fan-out, start to finish. Anchored to the same drain
   * arithmetic as the follower soft-cap: about 50 orders through one
   * concurrency-1 worker, which is also the scorer's mark-to-market cadence.
   * Use this to cap the impact of a **single** copied trade.
   */
  fanoutDrainMs: 5 * 60 * 1000,
  /**
   * Repeated buys that still ride the same displaced price. Wider, to catch the
   * farming pattern the item describes — buy small, let the copy flow lift the
   * price, sell into it — which plays out over more than one fan-out.
   * A judgement: nothing here measures how fast a pair's price recovers.
   */
  selfImpactDecayMs: 60 * 60 * 1000
});

// ═══════════════════════════════════════════════════════════════════════════
// Inputs
// ═══════════════════════════════════════════════════════════════════════════

/** An input is incoherent, or carries per-user data it must not. Fails loud. */
export class MasterCapacityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterCapacityInputError';
  }
}

/**
 * How trustworthy the accounted copy notional is.
 *
 * Needed because there is **no USD notional column on `copy_executions`**:
 * `028` gives base/quote quantities in token units, and `source_trades.amount_usd`
 * is nullable and absent on two chains by design (`robinhood-chain` never records
 * one, Solana omits it off USDC/USDT routes). `053` therefore keeps its own
 * ledger of priced cohort notional, and this field says what the sum is worth.
 */
export type CopyNotionalCoverage =
  /** Every leg in the window carried a USD notional. The sum is complete. */
  | 'accounted'
  /**
   * Some legs had no USD notional. The sum is a **lower bound**, so the impact
   * figure is too, and a pass may be a false pass. Carried through to the
   * decision rather than smoothed away.
   */
  | 'partial-unpriced-legs'
  /** No accounting available at all. Routed to the unassessable path. */
  | 'unavailable';

export interface MasterCapacityObservation {
  /**
   * Copy notional already committed for this (master, token) inside the window,
   * in USD. `null` only with coverage `unavailable`.
   */
  readonly committedNotionalUsd: number | null;
  /**
   * The cohort total this fan-out would add, in USD. **Cohort-level, never
   * per-user** — a per-user figure here would make the answer depend on which
   * user asked, which is the uniform-skip rule broken.
   */
  readonly projectedNotionalUsd: number;
  readonly coverage: CopyNotionalCoverage;
  /** How many legs in the window had no USD notional. For `internal` only. */
  readonly unpricedLegCount?: number;
}

export interface MasterCapacityPolicy {
  /** Per-chain ceiling override. Defaults to `PLATFORM_MAX_AGGREGATE_IMPACT_BPS`. */
  readonly maxAggregateImpactBps?: number;
  /** Crude secondary. Defaults to `DEFAULT_FOLLOWER_SOFT_CAP`. */
  readonly followerSoftCap?: number;
  /**
   * What to do when the **primary** cap cannot be evaluated — unknown liquidity,
   * or no notional accounting.
   *
   * **Required, with no default, on purpose.** Both answers are dangerous and
   * the danger is asymmetric, so the choice must appear in the caller's diff:
   *
   *   * `'skip'` fails closed. Correct for a token nobody can price — but for
   *     Polymarket, where no pre-fan-out depth feed exists at all, it is an
   *     undeclared kill switch that presents as "copying quietly stopped".
   *   * `'admit'` fails open on the primary layer only. The follower soft-cap
   *     still binds, so "admit" is never "uncapped".
   */
  readonly unassessablePolicy: 'skip' | 'admit';
}

export interface MasterCapacityInput {
  /**
   * The master wallet, chain-prefixed (`solana:ABC...`), and its chain. No user
   * identity of any kind appears in this type; see the uniform-skip note above.
   */
  readonly masterWalletAddress: string;
  readonly chain: Chain;
  readonly tokenMint: string;
  /** Window length. A parameter, not a magic number; see `MASTER_CAPACITY_WINDOWS`. */
  readonly windowMs: number;
  /** End of the window. Injected — this module never reads a clock. */
  readonly windowEndsAt: Date;
  readonly observation: MasterCapacityObservation;
  readonly liquidity: UsableLiquidity;
  /**
   * Active followers of this master on this chain. A master-level aggregate, so
   * it carries no user identity. `null` when unknown, which is its own
   * unassessed reason and never read as zero.
   *
   * Never surfaced to a user (`S4-M9`): it appears only under `internal`.
   */
  readonly activeFollowerCount: number | null;
  readonly policy: MasterCapacityPolicy;
}

// ═══════════════════════════════════════════════════════════════════════════
// Outputs
// ═══════════════════════════════════════════════════════════════════════════

export type MasterCapacityOutcome = 'admit' | 'skip';

/** Which layer bound. Both layers are evaluated; more than one can appear. */
export type MasterCapacityConstraint =
  | 'aggregate-price-impact'
  | 'follower-soft-cap'
  | 'unassessable-primary';

/**
 * The stable internal reason code. **Ops-facing only.** These strings are
 * contracts: telemetry, the admin capacity surface (`S6-43`) and the skip-reason
 * breakdown all key on them, so they are appended to rather than renamed.
 */
export type MasterCapacityReasonCode =
  | 'capacity-within-limits'
  /** The primary cap bound: cohort impact would exceed the chain ceiling. */
  | 'capacity-price-impact-cap-reached'
  /** The crude secondary bound. Can co-occur with the primary. */
  | 'capacity-follower-soft-cap-reached'
  /** Primary unevaluable and policy says fail closed. */
  | 'capacity-not-assessable'
  /**
   * Primary unevaluable, policy says fail open, and the secondary passed. An
   * admit that is **not** a clean pass, and a distinct code so a dashboard can
   * never show it as one.
   */
  | 'capacity-admitted-unassessed';

/** Why the primary cap could not be evaluated. Never conflated with "passed". */
export type MasterCapacityUnassessedReason =
  /** No liquidity figure at all (`basis: 'unknown'` or a null value). */
  | 'liquidity-unknown'
  /**
   * A basis exists but no pre-fan-out feed supplies it in this repo. Distinct
   * from `liquidity-unknown` because the fix is different: build the feed.
   */
  | 'liquidity-feed-missing'
  /** No copy-notional accounting for the window. */
  | 'copy-notional-unaccounted'
  /**
   * The notional sum is a lower bound because some legs were unpriced. Recorded
   * even when the cap passes, so a pass is never mistaken for a complete check.
   */
  | 'copy-notional-partial'
  /** Follower count unknown, so the crude secondary could not be evaluated. */
  | 'follower-count-unknown';

export interface MasterCapacityUnassessed {
  readonly reason: MasterCapacityUnassessedReason;
  /** What must supply the missing input. Written for whoever has to fix it. */
  readonly detail: string;
}

export interface PriceImpactAssessment {
  readonly usableLiquidityUsd: number;
  readonly basis: UsableLiquidityBasis;
  readonly approximate: boolean;
  readonly capBps: number;
  readonly committedImpactBps: number;
  readonly projectedImpactBps: number;
  /** Committed + projected, i.e. what the cap is compared against. */
  readonly totalImpactBps: number;
  /** USD still available under the cap. Negative is clamped to 0. */
  readonly headroomUsd: number;
  /** True when the sum is a lower bound (`partial-unpriced-legs`). */
  readonly lowerBound: boolean;
}

export interface FollowerSoftCapAssessment {
  readonly activeFollowerCount: number;
  readonly softCap: number;
  /** Always true here — the layer is crude by construction. */
  readonly crude: true;
}

export interface MasterCapacityDecision {
  readonly outcome: MasterCapacityOutcome;
  /** Ops-facing. Mirrored in `internal.code` so a log line carries both halves. */
  readonly reasonCode: MasterCapacityReasonCode;
  readonly binding: readonly MasterCapacityConstraint[];
  /**
   * What this decision says **nothing** about. Present so an empty list is the
   * only thing that means "fully checked" — an admit with entries here is an
   * admit under partial information.
   */
  readonly unassessed: readonly MasterCapacityUnassessed[];
  /**
   * The only user-visible half. Generic by policy: it names no quota, no
   * liquidity figure, no follower count, and contains no digits. `null` on an
   * admit, because there is nothing to tell the user.
   */
  readonly user: { readonly message: string | null };
  /**
   * Ops-only. **Never render any of this to a user** — it names the real
   * constraint and carries the follower count, which `S4-M9` forbids showing.
   */
  readonly internal: {
    readonly code: MasterCapacityReasonCode;
    readonly detail: string;
    readonly masterWalletAddress: string;
    readonly chain: Chain;
    readonly tokenMint: string;
    readonly windowMs: number;
    readonly windowStartsAt: Date;
    readonly windowEndsAt: Date;
    readonly priceImpact: PriceImpactAssessment | null;
    readonly followerSoftCap: FollowerSoftCapAssessment | null;
  };
}

/**
 * The one string a user ever sees when capacity binds, for every cause.
 *
 * One string for every cause on purpose. Distinct wording per cause would let a
 * user distinguish "impact cap" from "follower soft cap", and the second is a
 * headcount signal (`S4-M9`) — the difference between two messages is itself an
 * information leak. It carries no digits for the same reason: a headroom number
 * plus a known trade size reconstructs the cohort.
 *
 * Wording per ADR-0005 4.2-4.4: generic, and nothing in it is false. We are
 * genuinely capacity-limited and genuinely scaling; the constraint is simply not
 * itemised to users.
 */
export const CAPACITY_USER_MESSAGE =
  'This strategy is at capacity while we scale infrastructure. Your account is fine '
  + 'and nothing was charged; copying resumes automatically when capacity frees up.';

// ═══════════════════════════════════════════════════════════════════════════
// The uniform-skip structural guard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Key fragments that must never appear anywhere in a capacity input.
 *
 * This is the runtime half of the uniform-skip guarantee. The type already has
 * no per-user field; this catches the case where somebody widens the type, or
 * passes an object with extra properties through a structurally-typed boundary.
 * `account` is included because `target_account` is this schema's per-user key
 * on the copy tables.
 */
const FORBIDDEN_INPUT_KEY_FRAGMENTS = Object.freeze([
  'user',
  'tier',
  'subscriber',
  'entitlement',
  'priority',
  'account',
  'rank'
]);

/** Depth bound, purely to make a malformed or cyclic input fail rather than hang. */
const MAX_INPUT_SCAN_DEPTH = 8;

/**
 * Throws if the input carries anything that looks like per-user or per-tier data.
 *
 * `masterWalletAddress` is deliberately not caught: it identifies the master
 * being capped, not a follower, and the decision must obviously be keyed on it.
 */
export function assertNoPerUserCapacityInput(input: unknown, path = 'input', depth = 0): void {
  if (depth > MAX_INPUT_SCAN_DEPTH) {
    throw new MasterCapacityInputError(
      `capacity input nests deeper than ${MAX_INPUT_SCAN_DEPTH} levels at ${path}; `
        + 'refusing to assess an input this module cannot fully inspect'
    );
  }
  if (input === null || typeof input !== 'object' || input instanceof Date) return;

  if (Array.isArray(input)) {
    input.forEach((item, index) =>
      assertNoPerUserCapacityInput(item, `${path}[${index}]`, depth + 1)
    );
    return;
  }

  for (const [key, value] of Object.entries(input)) {
    const lowered = key.toLowerCase();
    const hit = FORBIDDEN_INPUT_KEY_FRAGMENTS.find((fragment) => lowered.includes(fragment));
    if (hit !== undefined) {
      throw new MasterCapacityInputError(
        `capacity input carries per-user data at ${path}.${key} (matched "${hit}"). `
          + 'Capacity binds uniformly on every user (S4-M7): the decision is a property '
          + 'of (master, token, window) and must not be able to see who is asking.'
      );
    }
    assertNoPerUserCapacityInput(value, `${path}.${key}`, depth + 1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// The decision
// ═══════════════════════════════════════════════════════════════════════════

function assertFiniteNonNegative(label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new MasterCapacityInputError(
      `${label} must be a non-negative finite number, got ${value}`
    );
  }
}

/**
 * Assesses per-master capacity for one (master, token, window).
 *
 * Pure: no clock, no database, no network. The same inputs always give the same
 * decision, and the decision is identical for every user by construction — there
 * is no per-user input to differ on.
 *
 * Fails **loud** on an incoherent input (`MasterCapacityInputError`) and routes a
 * *missing* one to `unassessed` plus the caller's declared
 * `unassessablePolicy`, so nothing missing is ever silently read as a pass.
 */
export function assessMasterCapacity(input: MasterCapacityInput): MasterCapacityDecision {
  assertNoPerUserCapacityInput(input);

  if (!Number.isFinite(input.windowMs) || input.windowMs <= 0) {
    throw new MasterCapacityInputError(
      `windowMs must be a positive finite number, got ${input.windowMs}`
    );
  }
  const windowEndMs = input.windowEndsAt.getTime();
  if (!Number.isFinite(windowEndMs)) {
    throw new MasterCapacityInputError('windowEndsAt must be a valid Date');
  }
  assertFiniteNonNegative('projectedNotionalUsd', input.observation.projectedNotionalUsd);

  const capBps = input.policy.maxAggregateImpactBps ?? PLATFORM_MAX_AGGREGATE_IMPACT_BPS[input.chain];
  if (!Number.isFinite(capBps) || capBps <= 0) {
    throw new MasterCapacityInputError(
      `maxAggregateImpactBps must be a positive finite number, got ${capBps}`
    );
  }
  const softCap = input.policy.followerSoftCap ?? DEFAULT_FOLLOWER_SOFT_CAP;
  if (!Number.isInteger(softCap) || softCap < 1) {
    throw new MasterCapacityInputError(`followerSoftCap must be an integer >= 1, got ${softCap}`);
  }

  const unassessed: MasterCapacityUnassessed[] = [];
  const binding: MasterCapacityConstraint[] = [];

  // ── Layer 1 (primary): aggregate price impact ──────────────────────────
  const liquidityUsd = input.liquidity.usableLiquidityUsd;
  const liquidityUsable =
    input.liquidity.basis !== 'unknown'
    && liquidityUsd !== null
    && Number.isFinite(liquidityUsd)
    && liquidityUsd > 0;

  if (!liquidityUsable) {
    unassessed.push({
      reason: input.liquidity.basis === 'order-book-depth' ? 'liquidity-feed-missing' : 'liquidity-unknown',
      detail:
        `No usable liquidity for ${input.tokenMint} on ${input.chain}: ${input.liquidity.note} `
        + 'The primary cap needs a one-sided USD depth figure at fan-out time. Today the only '
        + 'pre-fan-out source in this repo is fetchDexScreenerLiquidity (pool TVL for the '
        + 'deepest pair, packages/shared/src/prices.ts); Polymarket depth and Jupiter route '
        + 'impact are both read inside the executor at submission and neither is available here.'
    });
  }

  const notionalKnown =
    input.observation.coverage !== 'unavailable'
    && input.observation.committedNotionalUsd !== null
    && Number.isFinite(input.observation.committedNotionalUsd)
    && input.observation.committedNotionalUsd >= 0;

  if (!notionalKnown) {
    unassessed.push({
      reason: 'copy-notional-unaccounted',
      detail:
        'No accounted copy notional for this window. It must come from '
        + 'master_capacity_ledger (053), written by the fan-out path when a cohort order '
        + 'is committed. copy_executions cannot supply it: 028 stores base/quote token '
        + 'quantities and no USD notional, and source_trades.amount_usd is NULL on '
        + 'robinhood-chain and on non-stablecoin Solana routes.'
    });
  } else if (input.observation.coverage === 'partial-unpriced-legs') {
    unassessed.push({
      reason: 'copy-notional-partial',
      detail:
        `${input.observation.unpricedLegCount ?? 'Some'} leg(s) in this window carried no USD `
        + 'notional, so the accounted sum and every impact figure derived from it are LOWER '
        + 'BOUNDS. A pass here may be a false pass.'
    });
  }

  let priceImpact: PriceImpactAssessment | null = null;
  if (liquidityUsable && notionalKnown) {
    const committedUsd = input.observation.committedNotionalUsd as number;
    const reserveUsd = liquidityUsd as number;
    const committedImpactBps = priceImpactBps(committedUsd, reserveUsd);
    const projectedImpactBps = priceImpactBps(input.observation.projectedNotionalUsd, reserveUsd);
    const totalImpactBps = committedImpactBps + projectedImpactBps;
    priceImpact = {
      usableLiquidityUsd: reserveUsd,
      basis: input.liquidity.basis,
      approximate: input.liquidity.approximate,
      capBps,
      committedImpactBps,
      projectedImpactBps,
      totalImpactBps,
      headroomUsd: Math.max(0, capacityNotionalUsd(reserveUsd, capBps) - committedUsd),
      lowerBound: input.observation.coverage === 'partial-unpriced-legs'
    };
    if (totalImpactBps > capBps) binding.push('aggregate-price-impact');
  }

  // ── Layer 2 (crude secondary): follower soft-cap ───────────────────────
  //
  // Evaluated unconditionally, so it binds independently of layer 1 and remains
  // the only live cap when layer 1 is unassessable.
  let followerSoftCap: FollowerSoftCapAssessment | null = null;
  if (
    input.activeFollowerCount === null
    || !Number.isInteger(input.activeFollowerCount)
    || input.activeFollowerCount < 0
  ) {
    if (input.activeFollowerCount !== null && input.activeFollowerCount !== undefined) {
      throw new MasterCapacityInputError(
        `activeFollowerCount must be a non-negative integer or null, got ${input.activeFollowerCount}`
      );
    }
    unassessed.push({
      reason: 'follower-count-unknown',
      detail:
        'Active follower count unknown, so the crude secondary cap was not evaluated. It '
        + 'must come from countActiveFollowers over user_wallet_subscriptions where '
        + "state <> 'ended' (051)."
    });
  } else {
    followerSoftCap = {
      activeFollowerCount: input.activeFollowerCount,
      softCap,
      crude: true
    };
    if (input.activeFollowerCount > softCap) binding.push('follower-soft-cap');
  }

  const primaryUnassessable = priceImpact === null || input.observation.coverage !== 'accounted';
  const capacityUnassessable = primaryUnassessable || followerSoftCap === null;
  if (primaryUnassessable) binding.push('unassessable-primary');

  // ── Resolve ───────────────────────────────────────────────────────────
  //
  // Fixed precedence so the code is stable for telemetry: a real breach outranks
  // an unevaluable check, and the primary outranks the crude secondary.
  let outcome: MasterCapacityOutcome;
  let code: MasterCapacityReasonCode;
  let detail: string;

  if (binding.includes('aggregate-price-impact')) {
    outcome = 'skip';
    code = 'capacity-price-impact-cap-reached';
    const pi = priceImpact as PriceImpactAssessment;
    detail =
      `Aggregate copy flow would reach ${pi.totalImpactBps.toFixed(1)} bps of execution impact `
      + `against a ${pi.capBps} bps ceiling on ${input.chain} `
      + `(committed ${pi.committedImpactBps.toFixed(1)} bps + projected `
      + `${pi.projectedImpactBps.toFixed(1)} bps; usable liquidity `
      + `$${pi.usableLiquidityUsd.toFixed(2)}, basis ${pi.basis}`
      + `${pi.approximate ? ', approximate' : ''}${pi.lowerBound ? ', lower bound' : ''}). `
      + `Window ${input.windowMs} ms ending ${input.windowEndsAt.toISOString()}.`;
  } else if (binding.includes('follower-soft-cap')) {
    outcome = 'skip';
    code = 'capacity-follower-soft-cap-reached';
    const fs = followerSoftCap as FollowerSoftCapAssessment;
    detail =
      `Crude secondary bound: ${fs.activeFollowerCount} active followers on ${input.chain} `
      + `exceeds the ${fs.softCap} soft cap. This layer is venue-blind by construction; the `
      + 'price-impact cap is the primary control.'
      + (priceImpact === null ? ' The primary cap could not be evaluated (see unassessed).' : '');
  } else if (capacityUnassessable) {
    outcome = 'skip';
    code = 'capacity-not-assessable';
    detail = 'Capacity is not fully assessable; unknown or partially priced obligations '
      + 'cannot create free headroom. The cohort is skipped. Reasons: '
      + unassessed.map((entry) => entry.reason).join(', ') + '.';
  } else {
    outcome = 'admit';
    code = 'capacity-within-limits';
    const pi = priceImpact as PriceImpactAssessment;
    detail =
      `Within capacity: ${pi.totalImpactBps.toFixed(1)} bps of ${pi.capBps} bps on `
      + `${input.chain}, $${pi.headroomUsd.toFixed(2)} of notional headroom remaining`
      + `${pi.lowerBound ? ' (lower bound: some legs were unpriced)' : ''}.`;
  }

  return {
    outcome,
    reasonCode: code,
    binding: Object.freeze([...binding]),
    unassessed: Object.freeze(unassessed),
    user: { message: outcome === 'skip' ? CAPACITY_USER_MESSAGE : null },
    internal: {
      code,
      detail,
      masterWalletAddress: input.masterWalletAddress,
      chain: input.chain,
      tokenMint: input.tokenMint,
      windowMs: input.windowMs,
      windowStartsAt: new Date(windowEndMs - input.windowMs),
      windowEndsAt: input.windowEndsAt,
      priceImpact,
      followerSoftCap
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Per-master budget allocation (the seam `S4-P15` consumes)
// ═══════════════════════════════════════════════════════════════════════════

export interface MasterBudgetAllocationInput {
  /** The platform's remaining relayer/venue operations for the day. A config value. */
  readonly dailyBudgetOperations: number;
  /** How many masters are being copied today. */
  readonly activeMasterCount: number;
  /**
   * Explicit shares in bps, by chain-prefixed master address, from
   * `master_capacity_policy.daily_budget_share_bps`. Masters absent here split
   * what is left equally.
   */
  readonly explicitSharesBps?: Readonly<Record<string, number>>;
}

export interface MasterBudgetAllocation {
  /** Operations one master with no explicit share may consume today. */
  readonly equalShareOperations: number;
  /** Operations reserved by explicit shares. */
  readonly explicitOperations: number;
  /** Masters left to split the remainder. */
  readonly equalShareMasterCount: number;
  /** True when explicit shares already exceed the whole budget. */
  readonly oversubscribed: boolean;
}

/**
 * Splits a daily operations budget across masters, so one master's followers
 * cannot blank the venue for everyone else's (`S4-P15`).
 *
 * Equal share by default, because there is no defensible basis for giving one
 * master more of a shared quota, and any basis we invented would be a priority
 * rule — the thing the uniform-skip decision exists to avoid. `oversubscribed`
 * is reported rather than clamped away: shares summing past 100% is an operator
 * error to surface, not an arithmetic problem to hide.
 *
 * Pure. `S4-P15` owns the consumption counter; this only says how much each
 * master may have.
 */
export function allocateMasterBudget(
  input: MasterBudgetAllocationInput
): MasterBudgetAllocation {
  assertFiniteNonNegative('dailyBudgetOperations', input.dailyBudgetOperations);
  if (!Number.isInteger(input.activeMasterCount) || input.activeMasterCount < 0) {
    throw new MasterCapacityInputError(
      `activeMasterCount must be a non-negative integer, got ${input.activeMasterCount}`
    );
  }

  const shares = Object.values(input.explicitSharesBps ?? {});
  for (const share of shares) {
    if (!Number.isFinite(share) || share < 0 || share > 10_000) {
      throw new MasterCapacityInputError(
        `explicit budget share must be between 0 and 10000 bps, got ${share}`
      );
    }
  }
  const totalExplicitBps = shares.reduce((sum, share) => sum + share, 0);
  const explicitOperations = Math.floor((input.dailyBudgetOperations * totalExplicitBps) / 10_000);
  const remaining = Math.max(0, input.dailyBudgetOperations - explicitOperations);
  const equalShareMasterCount = Math.max(0, input.activeMasterCount - shares.length);

  return {
    equalShareOperations:
      equalShareMasterCount === 0 ? 0 : Math.floor(remaining / equalShareMasterCount),
    explicitOperations,
    equalShareMasterCount,
    oversubscribed: totalExplicitBps > 10_000
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// --- DB --- thin readers and one writer over `053`
// ═══════════════════════════════════════════════════════════════════════════
//
// None of the following has ever been executed: no database was available when
// this landed, and `053` has not been applied. They are deliberately thin so
// that all the behaviour worth testing sits above this line.

export interface MasterWindowNotionalRow {
  committed_notional_usd: string | null;
  priced_leg_count: string;
  unpriced_leg_count: string;
}

/**
 * Sums accounted cohort notional for one (master, token) inside a window.
 *
 * Reads `master_capacity_ledger` (`053`) rather than `copy_executions`, because
 * `028` has no USD notional column and `source_trades.amount_usd` is NULL on two
 * of three chains. The ledger row is written per fan-out event, cohort-level, and
 * carries **no user id at all** — a per-user ledger would make a headcount
 * derivable from capacity data, which `S4-M9` forbids.
 *
 * An empty window yields `coverage: 'accounted'` with `0`, which is correct only
 * if the writer is wired. It is not wired yet — see the report — so a caller
 * must not treat a zero from this function as proof that no copy flow occurred.
 */
export async function fetchMasterWindowNotional(params: {
  masterWalletAddress: string;
  chain: Chain;
  tokenMint: string;
  windowStartsAt: Date;
  windowEndsAt: Date;
  /**
   * Which execution modes count as market-moving flow. **Required, with no
   * default:** paper and shadow copies never reach a venue, so counting them
   * would skip live users over volume that never existed, and defaulting the
   * other way would silently exclude a mode somebody meant to include. Almost
   * always `['live']`.
   */
  executionModes: ReadonlyArray<'paper' | 'live' | 'shadow'>;
}): Promise<MasterCapacityObservation & { projectedNotionalUsd: 0 }> {
  if (params.executionModes.length === 0) {
    throw new MasterCapacityInputError(
      'executionModes must name at least one mode; an empty list would sum nothing and '
        + 'report it as accounted zero flow'
    );
  }
  const rows = await query<MasterWindowNotionalRow>(
    `SELECT COALESCE(SUM(notional_usd), 0)::text AS committed_notional_usd,
            COUNT(notional_usd)::text            AS priced_leg_count,
            COUNT(*) FILTER (WHERE notional_usd IS NULL OR unassessed_fill_count > 0)::text AS unpriced_leg_count
       FROM master_capacity_ledger
      WHERE master_wallet_address = $1
        AND chain = $2
        AND token_mint = $3
        AND committed_at >= $4
        AND committed_at < $5
        AND execution_mode = ANY($6)`,
    [
      params.masterWalletAddress,
      params.chain,
      params.tokenMint,
      params.windowStartsAt,
      params.windowEndsAt,
      [...params.executionModes]
    ]
  );

  const row = rows[0];
  if (!row) {
    return {
      committedNotionalUsd: null,
      projectedNotionalUsd: 0,
      coverage: 'unavailable'
    };
  }

  const unpricedLegCount = Number(row.unpriced_leg_count);
  return {
    committedNotionalUsd: Number(row.committed_notional_usd ?? 0),
    projectedNotionalUsd: 0,
    coverage: unpricedLegCount > 0 ? 'partial-unpriced-legs' : 'accounted',
    unpricedLegCount
  };
}

/**
 * Records the cohort notional of one fan-out event.
 *
 * Idempotent on `(source_trade_id, execution_mode)`: a retried fan-out must not
 * double-count itself into its own capacity cap. `notionalUsd` is `null` when the
 * legs could not be priced, which is what makes the reader able to report a
 * partial sum instead of a confident wrong one.
 */
export async function recordMasterCapacityLedgerEntry(params: {
  masterWalletAddress: string;
  chain: Chain;
  tokenMint: string;
  sourceTradeId: string;
  executionMode: 'paper' | 'live' | 'shadow';
  notionalUsd: number | null;
  notionalBasis: 'quote-stablecoin' | 'source-amount-usd' | 'marked-to-price' | 'unpriced';
  committedAt: Date;
}): Promise<void> {
  await query(
    `INSERT INTO master_capacity_ledger (
       master_wallet_address, chain, token_mint, source_trade_id,
       execution_mode, notional_usd, notional_basis, committed_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source_trade_id, execution_mode) DO NOTHING`,
    [
      params.masterWalletAddress,
      params.chain,
      params.tokenMint,
      params.sourceTradeId,
      params.executionMode,
      params.notionalUsd,
      params.notionalBasis,
      params.committedAt
    ]
  );
}

export interface MasterCapacityPolicyRow {
  max_aggregate_impact_bps: number | null;
  follower_soft_cap: number | null;
  daily_budget_share_bps: number | null;
}

/**
 * Per-master overrides, if any. Absent row means platform defaults, which is the
 * common case: an override is an operator action, not a setting every master has.
 */
export async function fetchMasterCapacityPolicy(params: {
  masterWalletAddress: string;
  chain: Chain;
}): Promise<{
  policy: Pick<MasterCapacityPolicy, 'maxAggregateImpactBps' | 'followerSoftCap'>;
  dailyBudgetShareBps: number | null;
}> {
  const rows = await query<MasterCapacityPolicyRow>(
    `SELECT max_aggregate_impact_bps, follower_soft_cap, daily_budget_share_bps
       FROM master_capacity_policy
      WHERE master_wallet_address = $1
        AND chain = $2`,
    [params.masterWalletAddress, params.chain]
  );

  const row = rows[0];
  return {
    policy: {
      maxAggregateImpactBps: row?.max_aggregate_impact_bps ?? undefined,
      followerSoftCap: row?.follower_soft_cap ?? undefined
    },
    dailyBudgetShareBps: row?.daily_budget_share_bps ?? null
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The priced numerator (S4-M6): accruing real fills onto the cohort row
// ═══════════════════════════════════════════════════════════════════════════
//
// ── What was missing, precisely ───────────────────────────────────────────
//
// `recordMasterCapacityLedgerEntry` above is called by the FAN-OUT site
// (`apps/signal-engine/src/capacity-inputs.ts`, `recordFanoutCapacityLedger`) at
// ENQUEUE time, and it writes `notional_usd NULL` / basis `unpriced`. That is the
// honest value there and not a shortcut: what the fan-out holds is a
// PROJECTION — an upper bound over admissible balances — and none of `053`'s
// three priced bases describes a projection. Recording it as priced would put a
// number in the numerator that no order produced, and every later window would
// cap real cohorts against imagined flow.
//
// The consequence was that the committed term stayed `$0` forever, so
// `fetchMasterWindowNotional` summed nothing and the impact cap measured only its
// own projection. The row said "a fan-out happened and its notional is unknown
// here"; nothing ever came back to say what it turned out to be.
//
// This section is that second half. As each user's fill confirms, the real USD
// notional is ACCUMULATED onto the same cohort row.
//
// ── Why an UPDATE and never a second INSERT ───────────────────────────────
//
// The unique key is `(source_trade_id, execution_mode)` — ONE row for the whole
// cohort, with no `user_id` and never one (`S4-M9`, `S4-M7`). A per-user INSERT
// would collide on that key, `ON CONFLICT DO NOTHING` would keep the first row,
// and **the first confirmed user's fill would masquerade as the entire cohort's
// notional**. Every later user's flow would be invisible to the cap. So the
// write is an accumulating UPDATE keyed on the cohort, and `053` needs no
// per-user shape at all.
//
// ── Why the basis flip and the first non-null write are one statement ─────
//
// Verified against `053` rather than assumed. `chk_master_capacity_ledger_basis`
// is:
//
//     notional_basis IN ('quote-stablecoin','source-amount-usd',
//                        'marked-to-price','unpriced')
//     AND (notional_basis = 'unpriced') = (notional_usd IS NULL)
//     AND (notional_usd IS NULL OR notional_usd >= 0)
//
// The middle clause is an equality between the two columns, so a statement that
// set `notional_usd` while leaving `notional_basis = 'unpriced'` would be
// rejected, and so would the reverse. A CHECK is evaluated per row per
// statement, so both must move in the SAME statement. They do — see
// `ACCRUE_LEDGER_NOTIONAL_SQL`, which is one UPDATE assigning both columns.
//
// The third clause is why a negative accrual is refused in the pure layer rather
// than sent to Postgres: a reversal large enough to drive the row below zero
// would surface as a constraint violation from a statement whose stack trace says
// nothing about reversals.
//
// ── Pure / DB split ──────────────────────────────────────────────────────
//
// Every decision — accrue or not, how much, which basis, is this a replay — is in
// `decideCapacityFillAccrual`, which is pure. The DB function is one parameterized
// UPDATE and a row-count check. There is no database on this branch, so anything
// decided in SQL would be untestable.

/**
 * The three priced bases `053` admits, as a type. `unpriced` is deliberately not
 * in this union: it is the *absence* of a priced figure, and a function that could
 * return it here could accidentally write a priced number under it.
 */
export type PricedNotionalBasis = 'quote-stablecoin' | 'source-amount-usd' | 'marked-to-price';

/** The execution modes `chk_master_capacity_ledger_mode` admits. */
export type CapacityLedgerExecutionMode = 'paper' | 'live' | 'shadow';

/**
 * What happened to one confirmed fill's contribution to the cohort numerator.
 *
 * Three refusals rather than one, on the same reasoning as the
 * `refuse` / `unavailable` split in `apps/trade-executor/src/solana-simulation.ts`:
 * each sends an operator somewhere different, and folding them together would
 * make a broken price feed indistinguishable from a routine replay.
 *
 * These strings are contracts. Telemetry and the admin capacity surface (`S6-43`)
 * key on them, so they are appended to rather than renamed.
 */
export type CapacityFillAccrualCode =
  /** A positive USD delta with a known basis. The only code that writes. */
  | 'accrue'
  /**
   * The execution's cumulative valued USD total did not move, so this call adds
   * nothing. Two causes, both benign and both **correctly** a no-op: the fill was
   * already accrued (a BullMQ retry, or a reconciliation pass re-confirming the
   * same evidence row), or the new fill carried no valued quote leg while an
   * earlier one did.
   *
   * This is the mechanism that makes the caller's idempotency contract
   * self-correcting rather than a bare promise — see the note on
   * {@link decideCapacityFillAccrual}.
   */
  | 'no-new-usd'
  /**
   * Nothing about this execution has a USD value yet: every confirmed fill so far
   * is unvalued (no usable SOL/ETH rate, or a venue that reported no quote leg at
   * all). The row therefore stays `unpriced` with `notional_usd NULL`.
   *
   * **Not an accrual of zero.** A zero would read as "this cohort spent nothing",
   * which is the false confidence the NULL exists to avoid: the window would go
   * from `partial-unpriced-legs` (a declared lower bound) to `accounted` (a
   * complete sum) while being neither. Same discipline as
   * `quote-valuation.ts`'s `native-price-unknown` and
   * `summarizeConfirmedQuoteTotal`'s `unvalued`.
   */
  | 'fill-value-unknown'
  /**
   * The cumulative total went DOWN. Evidence was reversed
   * (`confirmation_state = 'reversed'` drops the fill out of the confirmed sum),
   * or the caller passed a stale "before" figure.
   *
   * **Refused rather than subtracted, and the direction is stated:** leaving the
   * accrued figure high over-counts the numerator, which over-refuses future
   * cohorts. That is wrong but it fails CLOSED. Subtracting could drive the row
   * negative and trip `notional_usd >= 0` inside `053`'s basis CHECK, surfacing as
   * a constraint violation with nothing in the message about reversals. Capacity
   * is also arguably a record of impact already inflicted: a reversed fill still
   * consumed depth at submission time.
   */
  | 'refuse-reversed-fill';

export type CapacityFillAccrual =
  | {
      readonly code: 'accrue';
      /** Exact decimal text, always strictly positive. Never a float. */
      readonly deltaUsd: string;
      readonly notionalBasis: PricedNotionalBasis;
      readonly reason: string;
    }
  | {
      readonly code: 'no-new-usd' | 'fill-value-unknown' | 'refuse-reversed-fill';
      readonly deltaUsd: null;
      readonly notionalBasis: null;
      readonly reason: string;
    };

export interface CapacityFillAccrualInput {
  /**
   * The fan-out event this fill belongs to. Half of `053`'s unique key, and the
   * only identity this write needs — which is the point: no user, no target
   * account, nothing that could turn the ledger into a headcount.
   */
  readonly sourceTradeId: string;
  readonly executionMode: CapacityLedgerExecutionMode;
  /**
   * The unit the venue settled this fill's quote leg in, from
   * `QuoteLegValuation.currency` (`S4-M35`). `null` when the venue reported no
   * quote leg — which is an unknown value, not a zero one.
   */
  readonly quoteCurrency: QuoteCurrency | null;
  /**
   * `copy_executions.confirmed_quote_quantity` as it stood immediately BEFORE
   * this fill was recorded, and immediately after. Both are `SUM(quote_quantity)`
   * over the execution's confirmed/finalized evidence rows, i.e. over VALUED
   * fills only, so `null` means "nothing valued yet" rather than zero.
   *
   * A cumulative pair rather than a per-fill amount, deliberately — see
   * {@link decideCapacityFillAccrual}.
   */
  readonly confirmedQuoteUsdBefore: string | null;
  readonly confirmedQuoteUsdAfter: string | null;
}

/**
 * The basis a fill's USD figure actually has, from the unit it settled in.
 *
 * **`053`'s three bases, and which one describes a confirmed copy fill.** Read
 * from the migration rather than guessed:
 *
 *   * `source-amount-usd` — "from `source_trades.amount_usd`". That is the
 *     MASTER's trade size, not the cohort's. Wrong quantity entirely, and it is
 *     NULL on robinhood-chain and on non-stablecoin Solana routes anyway
 *     (`S4-M23`).
 *   * `quote-stablecoin` — "quote token is USD-pegged". True where the fill
 *     really settled in a dollar-pegged unit, and no conversion was applied.
 *   * `marked-to-price` — "quantity times a fetched price". True where the fill
 *     settled in SOL or ETH and `valuateQuoteLeg` multiplied by a fetched rate.
 *
 * So the honest answer **differs per chain**, which is why this is a function of
 * the settlement currency and not one constant:
 *
 *   * **Polymarket (`polygon`)** settles in USDC/pUSD, which this codebase treats
 *     as USD 1:1 (`nativeQuoteCurrencyForChain` returns `'USD'`, and `persistTrade`
 *     applies no conversion). The executor passes `currency: 'USD'`, so
 *     `quote-stablecoin`. The 1:1 assumption is `S4-M42`'s, and what invalidates it
 *     is pUSD **redeemability** rather than a price feed — so a broken peg would
 *     make this figure wrong without making it unknown. That is a limit of the
 *     assumption, recorded rather than hidden.
 *   * **Solana live** settles in SOL and `valuateQuoteLeg` multiplies by a fetched
 *     SOL price, so `marked-to-price`.
 *   * **Robinhood Chain live** settles in ETH, same conversion, so
 *     `marked-to-price`.
 *   * **Paper on every chain** sizes its quote leg in USD before it gets here
 *     (`persistCanonicalFill` passes `currency: 'USD'` for `paper_simulation`), so
 *     `quote-stablecoin`. Paper rows live under `execution_mode = 'paper'` and the
 *     capacity read filters to `['live']`, so they never enter the cap's numerator
 *     — the basis is recorded for correctness, not because it is consulted.
 *
 * `null` is returned for an unknown currency, never a default. A default would
 * label a converted figure as a stablecoin one, which overstates how much the
 * number can be trusted.
 */
export function pricedBasisForQuoteCurrency(
  currency: QuoteCurrency | null | undefined
): PricedNotionalBasis | null {
  if (currency === 'USD') return 'quote-stablecoin';
  if (currency === 'SOL' || currency === 'ETH') return 'marked-to-price';
  return null;
}

/**
 * Which basis a cohort row carries once legs with different bases have landed on
 * it.
 *
 * `053` has one `notional_basis` column per row and no `mixed` value, so a mixed
 * cohort has to resolve to one of the three. **The weaker claim wins:**
 * `marked-to-price` over `quote-stablecoin`, because a sum containing a
 * rate-converted leg is itself only as trustworthy as that rate, and labelling it
 * `quote-stablecoin` would claim a certainty the number does not have. Degrading
 * a label is honest; upgrading one is not.
 *
 * In practice a cohort should never mix: one `source_trade_id` fixes the chain,
 * and one `execution_mode` fixes the executor path, so every leg settles in the
 * same unit. This exists so that if that reasoning is ever wrong, the row is
 * pessimistic rather than misleading.
 */
export function mergePricedBasis(
  existing: PricedNotionalBasis | 'unpriced' | null,
  incoming: PricedNotionalBasis
): PricedNotionalBasis {
  if (existing === null || existing === 'unpriced' || existing === incoming) return incoming;
  return 'marked-to-price';
}

// ── Exact decimal subtraction ─────────────────────────────────────────────
//
// The delta is a difference of two Postgres NUMERIC texts and it is money, so it
// is not computed in binary floating point. `0.3 - 0.1` is `0.19999999999999998`
// in JS, and a numerator assembled from hundreds of those drifts against the
// column it is supposed to mirror. Same reason `quote-valuation.ts` does its
// multiply and divide on BigInt.
//
// Kept local rather than added to `quote-valuation.ts` because that file is not
// this task's to edit; it belongs beside `multiplyDecimalText` and
// `divideDecimalText`, and moving it there is noted in the report.

const CAPACITY_UNSIGNED_DECIMAL = /^(?:\d+\.?\d*|\d*\.\d+)$/;

/** Canonical unsigned decimal text, or `null` when the input is not one. */
function normalizeLedgerDecimal(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number'
    ? (Number.isFinite(value) && value >= 0 ? value.toFixed(20) : '')
    : value.trim();
  if (text === '' || !CAPACITY_UNSIGNED_DECIMAL.test(text)) return null;
  return text;
}

function ledgerDecimalParts(text: string): { digits: bigint; scale: number } {
  const [integerPart = '0', fractionalPart = ''] = text.split('.');
  const combined = `${integerPart}${fractionalPart}`;
  return { digits: BigInt(combined === '' ? '0' : combined), scale: fractionalPart.length };
}

function trimLedgerDecimal(text: string): string {
  if (!text.includes('.')) return text.replace(/^0+(?=\d)/, '');
  const trimmed = text.replace(/0+$/, '').replace(/\.$/, '');
  return (trimmed === '' ? '0' : trimmed).replace(/^0+(?=\d)/, '');
}

/**
 * `left - right` on unsigned decimal text, exactly. Returns `null` when either
 * input is not a usable non-negative decimal, and a `-`-prefixed result when the
 * difference is negative — the caller refuses on the sign rather than clamping,
 * because a negative delta is a reversal and must be visible as one.
 */
export function subtractDecimalText(
  left: string | number | null | undefined,
  right: string | number | null | undefined
): string | null {
  const a = normalizeLedgerDecimal(left);
  const b = normalizeLedgerDecimal(right);
  if (a === null || b === null) return null;
  const partsA = ledgerDecimalParts(a);
  const partsB = ledgerDecimalParts(b);
  const scale = Math.max(partsA.scale, partsB.scale);
  const scaled =
    partsA.digits * 10n ** BigInt(scale - partsA.scale)
    - partsB.digits * 10n ** BigInt(scale - partsB.scale);
  const negative = scaled < 0n;
  const magnitude = (negative ? -scaled : scaled).toString();
  if (scale === 0) return `${negative ? '-' : ''}${trimLedgerDecimal(magnitude)}`;
  const padded = magnitude.padStart(scale + 1, '0');
  const pointIndex = padded.length - scale;
  const body = trimLedgerDecimal(`${padded.slice(0, pointIndex)}.${padded.slice(pointIndex)}`);
  return `${negative && body !== '0' ? '-' : ''}${body}`;
}

/**
 * Decides what one confirmed fill contributes to its cohort's numerator.
 *
 * Pure: no clock, no database, no network.
 *
 * ── Why a cumulative pair, and where idempotency lives ────────────────────
 *
 * **Idempotency is the CALLER's contract, not this function's — and that is a
 * decision, not an omission.** Stated plainly because getting it wrong is silent:
 * double-counting inflates the numerator and over-refuses future cohorts, which
 * is the safe direction but still wrong, and it decays without any symptom.
 *
 * In-function deduplication would need this module to remember which
 * `copy_executions.id` values have already been accrued onto a ledger row. `053`
 * has nowhere to put that: the ledger row is cohort-level with **no `user_id` and
 * no execution id**, and it must stay that way — a per-execution column is a
 * per-user column with a different name, and `S4-M9`/`S4-M7` forbid making a
 * headcount derivable from capacity data. A side table keyed on execution id
 * would be a new migration, which this task does not have.
 *
 * So the contract is: **call once per confirmed fill.** What makes that contract
 * satisfiable rather than a bare promise is the shape of the input. The caller
 * does not hand over "this fill's USD amount"; it hands over the execution's
 * cumulative valued-USD total **before** and **after** the fill was recorded, and
 * the delta between them is what accrues. So:
 *
 *   * A BullMQ retry re-runs `recordCopyExecutionEvidence`, whose evidence insert
 *     is `ON CONFLICT (execution_id, evidence_type, evidence_id) DO NOTHING`. The
 *     cumulative total is therefore unchanged, the delta is zero, and this
 *     function returns `no-new-usd` and writes nothing. **A replay is a no-op by
 *     arithmetic, not by a promise anyone has to keep.**
 *   * A reconciliation pass re-confirming the same evidence row behaves
 *     identically, for the same reason.
 *   * A genuine second fill (a partial, then the remainder) moves the total, and
 *     only the increment accrues. This is why the input is a pair rather than a
 *     single amount: a per-fill amount would double-count the partial.
 *
 * The residual risk the contract still carries is a **stale** `before` figure. Its
 * two directions are asymmetric and worth naming: too low over-counts and
 * over-refuses (fails closed); too high produces a negative delta, which surfaces
 * as `refuse-reversed-fill` rather than as a silent subtraction. Neither is
 * silent, which is the property being bought.
 *
 * Fails **loud** (`MasterCapacityInputError`) on an input that is structurally
 * wrong — an unparseable cumulative figure, or per-user data — and routes every
 * *missing* value to a named code.
 */
export function decideCapacityFillAccrual(
  input: CapacityFillAccrualInput
): CapacityFillAccrual {
  // The same structural guard the decision uses. The ledger row has no user
  // dimension and this write must not be the thing that introduces one.
  assertNoPerUserCapacityInput(input, 'accrualInput');

  if (typeof input.sourceTradeId !== 'string' || input.sourceTradeId.trim() === '') {
    throw new MasterCapacityInputError('sourceTradeId must be a non-empty string');
  }
  if (
    input.executionMode !== 'paper'
    && input.executionMode !== 'live'
    && input.executionMode !== 'shadow'
  ) {
    throw new MasterCapacityInputError(
      `executionMode must be paper, live or shadow (053's chk_master_capacity_ledger_mode), `
        + `got ${String(input.executionMode)}`
    );
  }

  const after = normalizeLedgerDecimal(input.confirmedQuoteUsdAfter);
  if (input.confirmedQuoteUsdAfter !== null && input.confirmedQuoteUsdAfter !== undefined && after === null) {
    throw new MasterCapacityInputError(
      `confirmedQuoteUsdAfter must be a non-negative decimal or null, got `
        + `${JSON.stringify(input.confirmedQuoteUsdAfter)}`
    );
  }
  const before = normalizeLedgerDecimal(input.confirmedQuoteUsdBefore);
  if (input.confirmedQuoteUsdBefore !== null && input.confirmedQuoteUsdBefore !== undefined && before === null) {
    throw new MasterCapacityInputError(
      `confirmedQuoteUsdBefore must be a non-negative decimal or null, got `
        + `${JSON.stringify(input.confirmedQuoteUsdBefore)}`
    );
  }

  if (after === null) {
    // Nothing about this execution is valued in USD yet. If something WAS valued
    // before, the total cannot have become unknown without a reversal.
    if (before !== null) {
      return {
        code: 'refuse-reversed-fill',
        deltaUsd: null,
        notionalBasis: null,
        reason:
          `The execution's confirmed USD total went from ${before} to unknown, which means `
          + 'evidence was reversed. The accrued cohort notional is left as it stands rather '
          + 'than reduced: over-counting over-refuses future cohorts, which fails closed, '
          + "whereas a subtraction could drive the row below zero and trip 053's "
          + 'notional_usd >= 0 CHECK with a message about nothing.'
      };
    }
    return {
      code: 'fill-value-unknown',
      deltaUsd: null,
      notionalBasis: null,
      reason:
        'No confirmed fill on this execution carries a USD value, so the cohort row stays '
        + 'unpriced with notional_usd NULL. Accruing a zero would turn the window from a '
        + 'declared lower bound into a complete sum reading "this cohort spent nothing", '
        + 'which is exactly the false confidence the NULL exists to avoid.'
    };
  }

  const delta = subtractDecimalText(after, before ?? '0');
  if (delta === null) {
    throw new MasterCapacityInputError(
      `could not compute a USD delta from ${JSON.stringify(input.confirmedQuoteUsdBefore)} -> `
        + `${JSON.stringify(input.confirmedQuoteUsdAfter)}`
    );
  }

  if (delta.startsWith('-')) {
    return {
      code: 'refuse-reversed-fill',
      deltaUsd: null,
      notionalBasis: null,
      reason:
        `The execution's confirmed USD total fell from ${before ?? '0'} to ${after} `
        + `(delta ${delta}). Evidence was reversed, or the caller passed a stale "before" `
        + 'figure. Refused rather than subtracted: the accrued figure stays high, which '
        + 'over-refuses future cohorts and therefore fails closed.'
    };
  }

  if (delta === '0') {
    return {
      code: 'no-new-usd',
      deltaUsd: null,
      notionalBasis: null,
      reason:
        `The execution's confirmed USD total is unchanged at ${after}, so this fill adds `
        + 'nothing. Either it was already accrued — a retry re-presents the same evidence '
        + 'row and the insert is ON CONFLICT DO NOTHING — or this fill carried no valued '
        + 'quote leg while an earlier one did. Writing nothing is correct in both cases.'
    };
  }

  const basis = pricedBasisForQuoteCurrency(input.quoteCurrency);
  if (basis === null) {
    // The total moved, so a USD figure exists, but nothing said what unit produced
    // it. Refusing is the fail-closed direction for a LABEL: guessing a basis
    // would put a number under a claim about its provenance that nobody made.
    return {
      code: 'fill-value-unknown',
      deltaUsd: null,
      notionalBasis: null,
      reason:
        `The execution's confirmed USD total moved by ${delta} but the fill reported no `
        + `settlement currency (${JSON.stringify(input.quoteCurrency)}), so no basis from `
        + "053's list describes it. Left unpriced rather than guessed: a basis is a claim "
        + 'about where a number came from, and defaulting one would put a converted figure '
        + 'under quote-stablecoin.'
    };
  }

  return {
    code: 'accrue',
    deltaUsd: delta,
    notionalBasis: basis,
    reason:
      `Accruing $${delta} of confirmed fill notional onto the cohort row for source trade `
      + `${input.sourceTradeId} (${input.executionMode}), basis ${basis} from a `
      + `${input.quoteCurrency} quote leg.`
  };
}

/**
 * The one statement that turns an `unpriced` cohort row into a priced one and
 * every later fill into an increment.
 *
 * Held as a constant so the test asserting its shape and the code executing it
 * cannot be different strings — the whole invariant here is structural, and a
 * test against a copy of the SQL would pass while the real query inserted.
 *
 * Three properties it must have, each load-bearing:
 *
 *   1. **`UPDATE`, not `INSERT`.** `(source_trade_id, execution_mode)` is unique
 *      and cohort-level; a per-fill INSERT would let the first confirmed user's
 *      fill stand in for the whole cohort.
 *   2. **Both columns in one statement.** `chk_master_capacity_ledger_basis`
 *      equates `notional_basis = 'unpriced'` with `notional_usd IS NULL`, and a
 *      CHECK is evaluated per statement, so splitting them fails whichever half
 *      runs first.
 *   3. **`COALESCE(notional_usd, 0) + delta`**, so the first accrual starts from
 *      the `unpriced` NULL and later ones add. `NULL + x` is `NULL`, which would
 *      silently keep every cohort at zero.
 *
 * `RETURNING` exists so a missed row is detectable: an `UPDATE` that matches
 * nothing is not an error in Postgres, and silently matching nothing is the
 * fail-OPEN direction.
 */
export const ACCRUE_LEDGER_NOTIONAL_SQL = `UPDATE master_capacity_ledger
        SET notional_usd = COALESCE(notional_usd, 0) + $1::numeric,
            notional_basis = CASE
              WHEN notional_basis = 'unpriced' THEN $2
              WHEN notional_basis = $2 THEN notional_basis
              ELSE 'marked-to-price'
            END
      WHERE source_trade_id = $3::uuid
        AND execution_mode = $4
  RETURNING notional_usd::text AS notional_usd, notional_basis`;

export interface AccrueLedgerNotionalRow {
  notional_usd: string | null;
  notional_basis: string;
}

export interface CapacityFillAccrualResult {
  /** True only when a row was actually updated. */
  readonly applied: boolean;
  /**
   * The pure decision's code, or `ledger-row-missing` when the decision said
   * accrue and no cohort row existed to accrue onto.
   */
  readonly code: CapacityFillAccrualCode | 'ledger-row-missing';
  /** The accrued running total after this write, as text. `null` unless applied. */
  readonly notionalUsd: string | null;
  readonly notionalBasis: string | null;
  /** One ops line. Safe to log; it names no user because this path has none. */
  readonly reason: string;
}

/**
 * Accrues one confirmed fill's USD notional onto its cohort's ledger row.
 *
 * The decision is `decideCapacityFillAccrual`; this is the statement and a
 * row-count check.
 *
 * ── `ledger-row-missing` is reported, not repaired ────────────────────────
 *
 * A confirmed fill can arrive for a fan-out that has no ledger row:
 * `recordFanoutCapacityLedger` **swallows** its write failures by design (the
 * orders are already queued, so throwing would re-run the dispatch for nothing).
 * When that happened, this UPDATE matches zero rows and real flow is missing from
 * the numerator — which fails OPEN.
 *
 * It is surfaced as a distinct code rather than fixed here, and the reason is the
 * same one that makes this an UPDATE at all: an INSERT on this path would be a
 * per-fill insert, and the first fill to arrive would define the cohort row. The
 * repair belongs where the cohort identity is known — the fan-out site holds the
 * master address, chain and token mint; this call site holds none of them, and
 * inventing them from the execution row would put a second definition of a
 * cohort's identity in the codebase. Filed in the report rather than guessed at.
 *
 * Never throws for a missing row. It does propagate a genuine query failure, and
 * the caller decides — see the call-site note in the report.
 */
export async function accrueMasterCapacityFillNotional(
  input: CapacityFillAccrualInput,
  client?: PoolClient
): Promise<CapacityFillAccrualResult> {
  const decision = decideCapacityFillAccrual(input);
  if (decision.code !== 'accrue') {
    return {
      applied: false,
      code: decision.code,
      notionalUsd: null,
      notionalBasis: null,
      reason: decision.reason
    };
  }

  const values = [decision.deltaUsd, decision.notionalBasis, input.sourceTradeId, input.executionMode];
  const rows = client
    ? (await client.query<AccrueLedgerNotionalRow>(ACCRUE_LEDGER_NOTIONAL_SQL, values)).rows
    : await query<AccrueLedgerNotionalRow>(ACCRUE_LEDGER_NOTIONAL_SQL, values);

  const row = rows[0];
  if (!row) {
    return {
      applied: false,
      code: 'ledger-row-missing',
      notionalUsd: null,
      notionalBasis: null,
      reason:
        `No master_capacity_ledger row for source trade ${input.sourceTradeId} `
        + `(${input.executionMode}), so $${decision.deltaUsd} of confirmed fill notional is `
        + 'MISSING from the capacity numerator. The fan-out writer swallows its failures, so '
        + 'this is the expected symptom of one. Under-counting the numerator permits larger '
        + 'cohorts than it should, which fails OPEN — worth an alert rather than a debug line.'
    };
  }

  return {
    applied: true,
    code: 'accrue',
    notionalUsd: row.notional_usd,
    notionalBasis: row.notional_basis,
    reason: decision.reason
  };
}
