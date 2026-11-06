import { OrderSide, SignatureType, createSecureClient, type SecureClientOptions } from '@polymarket/client';
import { type BuilderCode } from '@polymarket/bindings';
import { type ApiKeyCreds, type OpenOrder, type OrderBook } from '@polymarket/bindings/clob';
import { type BuilderApiKeyCreds } from '@polymarket/client/node';
import { ethers } from 'ethers';
import { type PolymarketMarketState } from './polymarket-market-state.js';
import { escalatePolymarketExit, type PolymarketExitAlert, type PolymarketExitEscalationOutcome, type PolymarketExitLimitRung, type PolymarketExitRedeem } from './polymarket-exit-escalation.js';
import { type PolymarketStalenessPolicy } from './polymarket-staleness.js';
export declare const POLYMARKET_CLOB_HOST = "https://clob.polymarket.com";
export declare const POLYGON_CHAIN_ID = 137;
export declare const POLYMARKET_SDK_VERSION = "0.2.0";
export declare const POLYMARKET_DECIMALS = 6;
export declare const POLYMARKET_SHARE_DECIMALS = 2;
export declare const polygonProvider: ethers.providers.JsonRpcProvider;
export declare const polymarketSigner: ethers.Wallet | null;
type PolymarketSecureClient = Awaited<ReturnType<typeof createSecureClient>>;
type PolymarketClientFactory = (options: SecureClientOptions) => Promise<PolymarketSecureClient>;
declare let liveReadiness: {
    ready: boolean;
    reason: string;
};
export interface PolymarketIdentity {
    signerAddress: string;
    funderAddress: string;
    signatureType: SignatureType;
    signatureTypeName: keyof typeof SignatureType;
    builderCode: BuilderCode;
    directWalletWritesAllowed: boolean;
}
export interface PolymarketClientInitialization extends PolymarketIdentity {
    credentialSource: 'environment' | 'derived';
    builderAuthentication: 'none' | 'local';
    builderMakerFeeBps: number;
    builderTakerFeeBps: number;
}
export declare function parsePolymarketSignatureType(value: string | undefined): {
    value: SignatureType;
    name: keyof typeof SignatureType;
};
export declare function parsePolymarketBuilderCode(value: string | undefined): BuilderCode;
export declare function loadPolymarketApiCredentials(env?: NodeJS.ProcessEnv): ApiKeyCreds | null;
export declare function loadPolymarketBuilderCredentials(env?: NodeJS.ProcessEnv): BuilderApiKeyCreds | null;
export declare function resolvePolymarketIdentity(signerAddress: string, env?: NodeJS.ProcessEnv): PolymarketIdentity;
export declare function assertSupportedPolymarketRuntime(nodeVersion?: string): void;
export declare function setPolymarketClientForTesting(client: PolymarketSecureClient | null): void;
/**
 * The authenticated client, or null when Polymarket is not configured.
 *
 * Nullable counterpart to `requireSecureClobClient`, for callers that must
 * degrade rather than fail — the redemption sweep runs on a timer and an absent
 * client is the normal paper-mode posture, not an error worth throwing on every
 * tick.
 */
export declare function getPolymarketClientIfReady(): PolymarketSecureClient | null;
export declare function initializePolymarketClient(env?: NodeJS.ProcessEnv, clientFactory?: PolymarketClientFactory, nodeVersion?: string): Promise<PolymarketClientInitialization>;
export declare function setPolymarketLiveReadiness(ready: boolean, reason?: string): void;
export declare function getPolymarketLiveReadiness(): Readonly<typeof liveReadiness>;
export declare function parsePolymarketFixed6(value: string, label: string): number;
export declare function getPolymarketAvailableBalance(tokenID: string, direction: 'buy' | 'sell'): Promise<number>;
export declare function getPolymarketAskPrice(tokenID: string, side?: OrderSide): Promise<number>;
export interface PolymarketBookPlan {
    bestPrice: number;
    limitPrice: number;
    averagePrice: number;
    estimatedShares: number;
    estimatedNotionalUsd: number;
    slippageBps: number;
}
export declare function planPolymarketBookOrder(book: OrderBook, direction: 'buy' | 'sell', requestedAmount: number, maxSlippageBps: number, now?: number): PolymarketBookPlan;
/**
 * Price a paper fill the way the live path prices a real one: walk the book for
 * the requested size instead of assuming the whole order clears at the best
 * level.
 *
 * Taking the best price for any size makes paper systematically optimistic
 * against live - the thinner the book, the wider the gap - which is precisely
 * the error a shadow/paper benchmark exists to avoid. This shares
 * `planPolymarketBookOrder` with the live path so the two cannot drift, and it
 * inherits the same staleness, tick-grid, thin-book, and slippage rejections.
 *
 * `requestedAmount` is USD notional for a buy and shares for a sell, matching
 * the live contract.
 */
export declare function simulatePolymarketBookFill(params: {
    tokenID: string;
    direction: 'buy' | 'sell';
    requestedAmount: number;
    now?: number;
}): Promise<PolymarketBookPlan>;
/**
 * The master-fill reference a mirrored order is bounded against (`S4-M16`).
 *
 * Supplied only on the mirroring path. A manual or stop-loss order has no master
 * and legitimately carries none, which is why this is optional rather than
 * defaulted — but when it *is* supplied and `masterFillPriceUsd` is absent, the
 * mirror fails closed with a skip instead of falling back to a book-derived
 * bound that nobody sanctioned.
 */
export interface PolymarketMirrorContext {
    /** The canonical source event being mirrored. Present iff this is a copy. */
    readonly sourceTradeId: string;
    /** The tracked wallet's realized price for that event, in USD per share. */
    readonly masterFillPriceUsd: number | null;
    /** Per-user override; falls back to POLYMARKET_MIRROR_TOLERANCE_BPS. */
    readonly toleranceBps?: number;
}
export declare function triggerPolymarket(params: {
    signalId: string;
    tokenID: string;
    spendAmountUsd: number;
    direction: 'buy' | 'sell';
    sellShares?: number;
    mirror?: PolymarketMirrorContext;
    /**
     * When the source event this order copies actually happened (`S4-M18`).
     *
     * Optional for the same reason `mirror` is: only a copy has a source event. A
     * manual execute or a stop-loss exit has none, and gating those on a timestamp
     * that does not exist would refuse every one of them. Present-but-unusable
     * still fails closed — the staleness rule below refuses rather than falling
     * back to the flat ceiling.
     */
    sourceEventAt?: Date;
    /** Per-user override; falls back to the POLYMARKET_STALENESS_* environment. */
    stalenessPolicy?: Partial<PolymarketStalenessPolicy>;
    /** Timestamp when user's geo-eligibility was verified via interactive session (S4-P16). */
    geoVerifiedAt?: Date | null;
    /** Injected clock, so the staleness boundary is testable without faking time. */
    now?: () => number;
}): Promise<{
    orderId: string;
    status: import("@polymarket/client").OrderPostStatus;
    executionStatus: "pending_confirmation";
    reason: string;
    settlementTransactionHashes: import("@polymarket/client").TxHash[];
    tradeIds: string[];
    latencyMs: number;
    spendAmountUsd: number;
    shares: number;
    averagePrice: null;
    feesUsd: null;
    requestedSpendAmountUsd: number;
    requestedShares: number;
    slippageBps: number;
    mirrorBoundPrice: number;
    mirrorTrackingBps: number | null;
} | {
    orderId: string;
    status: import("@polymarket/client").OrderPostStatus;
    executionStatus: string;
    settlementTransactionHashes: string[];
    tradeIds: string[];
    latencyMs: number;
    spendAmountUsd: number;
    shares: number;
    averagePrice: number;
    feesUsd: number;
    requestedSpendAmountUsd: number;
    requestedShares: number;
    slippageBps: number;
    mirrorBoundPrice: number;
    mirrorTrackingBps: number | null;
}>;
/**
 * How many times a rung's cancellation is attempted before the ladder stops.
 *
 * Three, because the two states worth retrying are both short-lived: the venue's
 * matching-delay window, and a read of the order that briefly trails the cancel
 * we just sent. Anything still resting after three attempts is a fact about the
 * book rather than a race, and the answer to that is a human.
 */
export declare const POLYMARKET_RUNG_CANCEL_ATTEMPTS = 3;
/**
 * Pause between cancellation attempts.
 *
 * Two seconds is chosen against the documented 250 ms taker delay with headroom,
 * not against the configurable sports `secondsDelay` — a long game delay is not
 * something to spin on, and the `blocked` branch is the correct answer there.
 */
export declare const POLYMARKET_RUNG_CANCEL_RETRY_MS = 2000;
/**
 * Submit one exit-escalation rung as a GTD limit order (`S4-M17`).
 *
 * Separate from `triggerPolymarket` because the two order shapes answer different
 * questions. `triggerPolymarket` mirrors a master's trade and must not rest;
 * this recovers an exit that already failed to fill and is allowed to rest for a
 * bounded window.
 *
 * The `expiration` arrives pre-computed by `planPolymarketExitEscalation`, which
 * owns the documented `now + 60 + N` formula and the 3-minute venue floor. It is
 * re-checked here only for the case where a rung was planned and then sat in a
 * queue long enough to go stale — submitting an already-expired expiration is a
 * guaranteed rejection that would consume a rung.
 */
export declare function submitPolymarketExitRung(params: {
    tokenID: string;
    rung: PolymarketExitLimitRung;
    now?: number;
}): Promise<{
    orderId: string;
    status: string;
    expiration: number;
}>;
/**
 * Build the `submitRung` port the escalation driver needs.
 *
 * The port's contract is "submit this rung, let it live out its window, then
 * report what it filled", so the waiting lives here rather than in the driver —
 * the driver stays pure enough to test without a clock, and the caller decides
 * whether to occupy a worker for the rung's lifetime or hand it to a delayed job
 * by supplying its own `sleep`.
 *
 * **Retiring the rung before the next one is placed (`S4-M36`).** This used to
 * `await client.cancelOrder(...)` inside a try/catch on the assumption that a
 * failed cancellation throws. It does not: the venue answers **200** with a
 * `canceled` / `not_canceled` split, so a stale order landed in `not_canceled`
 * and the catch never ran. The belt-and-braces cancellation was therefore a
 * no-op on exactly the path it was written for, and the consequence was not
 * cosmetic — a rung still resting on the book plus a non-zero `sizeMatched` read
 * as a partial fill, so the ladder placed the next rung for the remainder and
 * left **two live sell orders whose combined size can exceed the position**.
 *
 * Three things changed, in the order the item ranks them:
 *
 *   1. the fetched order must be **terminal**, not merely partially matched. The
 *      data was always in hand — `fetchOrder` was already called and its status
 *      thrown away while only `sizeMatched` was read.
 *   2. the cancellation response is read through
 *      `interpretPolymarketCancellation`, the one helper both call sites now
 *      share, rather than inferred from the absence of an exception.
 *   3. if the rung is not provably dead the cancel is retried and then the ladder
 *      **stops** with an alert. Failing closed is deliberate and is the opposite
 *      of `S4-M31`: there the worst case was one odd trade, here it is selling a
 *      user's position twice, and the cost of stopping is a slower exit.
 *
 * A cancel refused inside the venue's matching-delay window counts as *wait*, not
 * as failure: `/concepts/order-lifecycle` documents cancels as blocked there, so
 * the refusal is the venue behaving as specified.
 *
 * Every venue call is an injectable port so the retirement logic can be exercised
 * without a signer or a live client.
 */
export declare function createPolymarketExitRungSubmitter(params: {
    tokenID: string;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (message: string) => void;
    submit?: (rung: PolymarketExitLimitRung) => Promise<{
        orderId: string;
    }>;
    cancelOrder?: (input: {
        orderId: string;
    }) => Promise<unknown>;
    fetchOrder?: (input: {
        orderId: string;
    }) => Promise<OpenOrder>;
    /** Raised when a rung cannot be shown to be dead, before the ladder stops. */
    emitAlert?: (alert: {
        orderId: string;
        reason: string;
    }) => Promise<void>;
    maxCancelAttempts?: number;
    cancelRetryDelayMs?: number;
}): (rung: PolymarketExitLimitRung) => Promise<{
    filledShares: number;
}>;
export type PolymarketReconciliationStatus = 'pending_confirmation' | 'partial' | 'filled' | 'cancelled' | 'failed' | 'ambiguous';
export interface PolymarketReconciliationOutcome {
    tradeId: string;
    orderId: string;
    status: PolymarketReconciliationStatus;
    reason?: string;
    shares?: number;
    amountUsd?: number;
    averagePrice?: number;
    feesUsd?: number | null;
    venueTradeIds?: string[];
    settlementTransactionHashes?: string[];
}
/**
 * Reconcile the one pending trade belonging to a canonical execution.
 *
 * `pollPolymarketOrders` sweeps by `status = 'pending_confirmation'`, so an
 * execution whose trade row has already left that status is invisible to it.
 * The reconciliation coordinator claims from `copy_executions` instead and needs
 * to drive a single execution, so it comes through here.
 *
 * Returns null when there is nothing to reconcile — either live readiness is
 * absent or no matching pending trade row exists.
 */
export declare function reconcilePolymarketExecution(executionId: string, now?: number): Promise<PolymarketReconciliationOutcome | null>;
export declare function pollPolymarketOrders(): Promise<PolymarketReconciliationOutcome[]>;
/**
 * Drive the exit-escalation ladder for exits that reconciliation has already
 * declared unfilled (`S4-M17`).
 *
 * `pollPolymarketOrders` is where an exit *becomes* known-unfilled: a sell whose
 * FAK reconciled to `cancelled`, `failed`, or `partial` is a position the master
 * has left and the user still holds. Until this sweep existed the ladder in
 * `polymarket-exit-escalation.ts` had no caller, so that state was terminal —
 * the trade row said "cancelled" and nobody sold the shares.
 *
 * **Where it runs.** Inside the single guarded `reconcilePending` pass in
 * `index.ts`, at the tail, after the per-venue sweeps and the canonical
 * coordinator. Not on its own timer (audit finding `C1`): a second timer could
 * overlap this ladder with the reconciliation that classifies its own rungs. At
 * the tail because a ladder occupies the pass for as long as its rungs rest, and
 * the fast sweeps must not queue behind it.
 *
 * **What it deliberately does not do.** It does not resume a partly-walked
 * ladder. `escalatePolymarketExit` holds the rung index in a local, so one call
 * walks the whole ladder or terminates; there is no column to persist a rung in
 * and this module does not invent one. The consequences are stated on
 * `POLYMARKET_EXIT_ESCALATION_SWEEP_LIMIT` and
 * `resolvePolymarketExitReferencePrice`.
 */
/**
 * How many exits one pass will escalate.
 *
 * One by default, and low on purpose. A ladder rests each rung for its full
 * effective lifetime inside this call, so N candidates occupy the guarded
 * reconciliation pass for N ladders' worth of wall clock. Raising this trades
 * reconciliation latency for exit throughput, and the honest fix is not a bigger
 * number — it is persisted rung state so each pass can advance one rung and
 * return.
 */
export declare const POLYMARKET_EXIT_ESCALATION_SWEEP_LIMIT = 1;
/**
 * How far back a failed exit stays escalatable.
 *
 * An exit that failed an hour ago is not the same trade any more: the market has
 * moved, and re-offering a ladder measured from that reference is the staleness
 * `S4-M18` refuses on the entry path. Bounded rather than unbounded so a backlog
 * of historical failures cannot be replayed by a restart.
 */
export declare const POLYMARKET_EXIT_ESCALATION_MAX_AGE_MS: number;
export interface PolymarketExitEscalationCandidate {
    readonly id: string;
    readonly copy_execution_id: string | null;
    readonly signal_id: string | null;
    readonly token_mint: string;
    readonly status: string;
    readonly venue_order_id: string;
    /** Average price of the confirmed portion, or null when nothing filled. */
    readonly price_usd: string | number | null;
    readonly token_amount: string | number | null;
    readonly target_amount_usd: string | number | null;
}
export type PolymarketExitReferenceResolution = {
    readonly kind: 'reference';
    readonly referencePrice: number;
} | {
    readonly kind: 'unavailable';
    readonly reason: string;
};
/**
 * Find the price the failed attempt was bounded at, or say why it cannot be found.
 *
 * The ladder measures rungs down from the price the attempt that just failed
 * offered — see `polymarket-exit-escalation.ts` on why the master's raw fill is
 * the wrong reference. `triggerPolymarket` computes exactly that number
 * (`boundPrice`, returned as `mirrorBoundPrice`) and then drops it: `TradeInsert`
 * has no column for a signed protective bound, so it is not persisted.
 *
 * What survives is `price_usd`, which `finishConfirmedFill` sets to the average
 * price of the *confirmed* portion. For a sell that is a price the venue actually
 * paid us, so it is at or above the bound we signed — a valid, slightly
 * conservative reference. A sell that filled nothing has `price_usd = NULL`
 * (`insertTrade` only writes a price when there is a confirmed fill), and there
 * is nothing else on the row that means "the price we offered":
 * `target_amount_usd` is a requested notional and `token_amount` is null too, so
 * dividing them would invent a price rather than recover one.
 *
 * So this returns `unavailable` for the zero-fill case rather than guessing. That
 * is the honest half of `S4-M17`: the ladder runs for exits that partially
 * filled, and a zero-fill exit is reported as needing the missing column.
 */
export declare function resolvePolymarketExitReferencePrice(row: Pick<PolymarketExitEscalationCandidate, 'id' | 'status' | 'price_usd'>): PolymarketExitReferenceResolution;
/** Test seam; also the reset an operator would want after fixing a market by hand. */
export declare function resetPolymarketExitEscalationMemoryForTesting(): void;
export interface PolymarketExitEscalationSweepPorts {
    /** Publish the ladder's terminal alert. */
    readonly emitAlert: (alert: PolymarketExitAlert, candidate: PolymarketExitEscalationCandidate) => Promise<void>;
    readonly loadCandidates?: () => Promise<PolymarketExitEscalationCandidate[]>;
    readonly fetchBook?: (tokenID: string) => Promise<OrderBook>;
    readonly fetchSellableShares?: (tokenID: string) => Promise<number>;
    readonly fetchMarketState?: (conditionId: string) => Promise<PolymarketMarketState>;
    readonly submitRungFor?: (tokenID: string) => (rung: PolymarketExitLimitRung) => Promise<{
        filledShares: number;
    }>;
    readonly requestRedemption?: (redeem: PolymarketExitRedeem, candidate: PolymarketExitEscalationCandidate) => Promise<void>;
    readonly escalate?: typeof escalatePolymarketExit;
    readonly limit?: number;
    readonly now?: () => number;
    readonly log?: (message: string) => void;
}
export interface PolymarketExitEscalationSweepResult {
    readonly scanned: number;
    readonly escalated: number;
    readonly completed: number;
    readonly alerted: number;
    readonly redeemed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly skips: readonly {
        readonly tradeId: string;
        readonly reason: string;
    }[];
    readonly outcomes: readonly {
        readonly tradeId: string;
        readonly outcome: PolymarketExitEscalationOutcome;
    }[];
}
export declare function runPolymarketExitEscalationSweep(ports: PolymarketExitEscalationSweepPorts): Promise<PolymarketExitEscalationSweepResult>;
export {};
//# sourceMappingURL=polymarket.d.ts.map