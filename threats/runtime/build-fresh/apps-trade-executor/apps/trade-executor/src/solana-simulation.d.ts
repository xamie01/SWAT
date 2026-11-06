import { VersionedTransaction } from '@solana/web3.js';
import type { Commitment, RpcResponseAndContext, SimulateTransactionConfig, SimulatedTransactionResponse } from '@solana/web3.js';
/**
 * Pre-trade transaction simulation for the Solana / Jupiter + Jito path
 * (checklist S4-M15).
 *
 * Before this module the executor had no `simulateTransaction` anywhere: the
 * first time anyone learned a route was broken was when a bundle landed and
 * failed, or was dropped, having already paid a Jito tip and burned a quote.
 * This gate runs the built swap transaction through the RPC simulator and turns
 * the answer into a *structured decision* so the executor can skip with a
 * reason code (S4-M24 needs actionable skip reasons, not a bare boolean).
 *
 * ## Three outcomes, not two
 *
 * `proceed` / `refuse` / `unavailable` are deliberately three states, because
 * collapsing the third into either of the first two is a real failure mode:
 *
 *   * Folding `unavailable` into `proceed` waves through exactly the broken
 *     routes this module exists to catch, and does it *silently* — the operator
 *     would believe simulation was protecting them while an unreachable RPC
 *     disabled it.
 *   * Folding `unavailable` into `refuse` with the same code as a revert means
 *     one flaky RPC endpoint halts all Solana trading and reports the reason as
 *     "the route reverted", sending the operator to debug a route that is fine.
 *
 * So the *classification* lives here and the *policy* is a parameter
 * (`onUnavailable`). The default is fail-closed — see `resolveSolanaSimulationGate`
 * for why, and why the skip code stays distinct from a revert either way.
 *
 * ## What simulation can and cannot tell us on this path
 *
 * The swap is submitted as a **Jito bundle**, not a public-RPC broadcast, so
 * there is an unavoidable gap between the slot the simulator evaluated and the
 * slot a block builder includes the bundle in. This gate therefore only claims
 * to catch failures that are *state-independent over that gap*: a missing or
 * uninitialised token account, a frozen or non-transferable mint, a mint whose
 * program rejects the transfer, an unroutable or drained pool, an insufficient
 * input balance, a malformed instruction, a compute-budget overrun. It makes no
 * claim at all about price: a route that simulates clean can still fail on
 * slippage after the intervening slots move the pool, and the protection for
 * that is the quote's `slippageBps` / `otherAmountThreshold`, not this module.
 *
 * It also simulates **one transaction, not the bundle**. `simulateTransaction`
 * takes a single transaction; the tip transfer that rides alongside the swap in
 * the bundle is not covered here. Jito exposes a bundle-level simulation RPC,
 * but it is not part of `@solana/web3.js@1.98.4` and is not invented here.
 *
 * ## Everything injected
 *
 * No module-level `Connection`, no `Date.now()` in any decision, no clock in the
 * pure functions. The simulator is a parameter (house Standing Rule 2), so the
 * whole gate is exercised with zero network by passing a fake.
 */
/** A definite, transaction-specific refusal. Nothing has been transmitted. */
export type SolanaSimulationRefusalCode = 
/** The simulator executed the transaction and it returned an error. */
'solana-simulation-reverted'
/** Simulated compute consumption exceeded the caller-supplied cap. */
 | 'solana-simulation-compute-units-exceeded'
/** The built transaction bytes are not a decodable versioned transaction. */
 | 'solana-simulation-transaction-undecodable';
/** The simulator could not answer. Says nothing about the transaction itself. */
export type SolanaSimulationUnavailableCode = 
/** The simulate call threw or timed out: RPC down, network error, deadline. */
'solana-simulator-unreachable'
/** A response arrived but did not carry the shape the RPC contract promises. */
 | 'solana-simulator-response-invalid';
export type SolanaSimulationOutcome = {
    readonly kind: 'proceed';
    /**
     * Compute units the simulator reported. `null` when the response omitted
     * the field — it is optional in `SimulatedTransactionResponse`, so a
     * missing value is an RPC quirk, never grounds to refuse a trade.
     */
    readonly unitsConsumed: number | null;
    /** Slot the simulation was evaluated at. The near side of the Jito gap. */
    readonly slot: number | null;
} | {
    readonly kind: 'refuse';
    readonly code: SolanaSimulationRefusalCode;
    /** Operator-readable and specific enough to act on without the raw logs. */
    readonly reason: string;
    readonly unitsConsumed: number | null;
    readonly slot: number | null;
    /** Tail of the program log, bounded so a reason column cannot blow up. */
    readonly logs: readonly string[];
} | {
    readonly kind: 'unavailable';
    readonly code: SolanaSimulationUnavailableCode;
    readonly reason: string;
};
export type SolanaSimulationGateDecision = {
    readonly kind: 'submit';
    readonly outcome: SolanaSimulationOutcome;
} | {
    readonly kind: 'skip';
    readonly code: SolanaSimulationRefusalCode | SolanaSimulationUnavailableCode;
    readonly reason: string;
};
/**
 * Matches the versioned-transaction overload of `Connection.simulateTransaction`
 * in `@solana/web3.js@1.98.4`:
 *
 *   simulateTransaction(transaction: VersionedTransaction, config?: SimulateTransactionConfig)
 *     : Promise<RpcResponseAndContext<SimulatedTransactionResponse>>
 */
export type SolanaTransactionSimulator = (transaction: VersionedTransaction, config: SimulateTransactionConfig) => Promise<RpcResponseAndContext<SimulatedTransactionResponse>>;
export interface SolanaSimulationInput {
    /** Base64 transaction exactly as `buildJupiterSwap` returned it. */
    readonly transactionBase64: string;
    /** For log lines only; never used in a decision. */
    readonly clientOrderId?: string;
}
export interface SolanaSimulationOptions {
    readonly simulate: SolanaTransactionSimulator;
    /**
     * Hard ceiling on simulated compute units.
     *
     * **No default, deliberately.** Nothing in this repo configures a compute-unit
     * limit today — the swap is built with `computeUnitPriceMicroLamports:
     * undefined` and no `ComputeBudgetProgram` instruction is ever added — so any
     * number chosen here would be invented. Left unset the compute check does not
     * run at all and `unitsConsumed` is reported for observability only.
     */
    readonly maxComputeUnits?: number;
    /** Commitment for the simulated slot. */
    readonly commitment?: Commitment;
    /** Max log lines carried onto a refusal. */
    readonly maxLogLines?: number;
}
/**
 * Simulates one built swap transaction and classifies the answer.
 *
 * Never throws: every failure path is a returned outcome, because a throw from
 * here would surface in the executor as a job crash and a BullMQ retry, which on
 * a submit path is how a duplicate position gets opened.
 */
export declare function simulateSolanaSwapTransaction(input: SolanaSimulationInput, options: SolanaSimulationOptions): Promise<SolanaSimulationOutcome>;
export type SolanaSimulationUnavailablePolicy = 'skip' | 'submit';
/**
 * Applies the unavailable-simulator policy and produces the executor's decision.
 *
 * **Default is `skip` (fail closed).** The two errors are not symmetric. A skip
 * costs one missed copy trade, is visible in the skip reason, and is recoverable
 * — the position was never opened. Submitting blind costs a Jito tip plus a
 * failed or adversely-filled on-chain transaction against real funds, and it
 * reintroduces precisely the loss this checklist item was raised to stop. The
 * code stays distinct from a revert (`solana-simulator-unreachable`, not
 * `solana-simulation-reverted`) so an operator triaging skips can tell "our RPC
 * is down" from "this route is broken", and an ops alert can page on the first
 * without anyone re-reading logs.
 *
 * `submit` exists because fail-closed on a shared dependency is an availability
 * risk an operator may legitimately choose to take instead — but it has to be
 * chosen explicitly, and the choice is recorded in the outcome either way.
 */
export declare function resolveSolanaSimulationGate(outcome: SolanaSimulationOutcome, onUnavailable?: SolanaSimulationUnavailablePolicy): SolanaSimulationGateDecision;
export interface SolanaSimulationGate {
    /** Simulate, classify, and apply the unavailable policy in one call. */
    evaluate(input: SolanaSimulationInput): Promise<SolanaSimulationGateDecision>;
}
export interface SolanaSimulationGateOptions extends SolanaSimulationOptions {
    readonly onUnavailable?: SolanaSimulationUnavailablePolicy;
}
export declare function createSolanaSimulationGate(options: SolanaSimulationGateOptions): SolanaSimulationGate;
/**
 * The slice of `Connection` this module needs. Structural, so a fake satisfies
 * it without constructing a real `Connection` in a test.
 */
export interface SimulationConnection {
    simulateTransaction(transaction: VersionedTransaction, config?: SimulateTransactionConfig): Promise<RpcResponseAndContext<SimulatedTransactionResponse>>;
}
/**
 * Default simulator deadline.
 *
 * Sits between the Jupiter swap-build timeout (8s) and the Jito submit timeout
 * (10s): a simulation slower than this has spent more of the quote's life than
 * the check is worth, and a hung RPC would otherwise hold a trade job open for
 * the whole BullMQ lock. Overridable with `SOLANA_SIMULATION_TIMEOUT_MS`.
 */
export declare const DEFAULT_SOLANA_SIMULATION_TIMEOUT_MS = 5000;
/**
 * Wraps a `Connection` as a deadline-bounded simulator.
 *
 * The timer lives here, in the adapter, and never in the decision logic — the
 * classification functions above hold no clock and are tested with no timers at
 * all. A blown deadline surfaces as a rejection, which
 * `simulateSolanaSwapTransaction` classifies as `solana-simulator-unreachable`:
 * an unanswered simulation, not a failing route.
 */
export declare function createConnectionSimulator(connection: SimulationConnection, timeoutMs?: number): SolanaTransactionSimulator;
/**
 * Environment options for the gate, resolved without touching the network.
 *
 * Split from `createSolanaSimulationGateFromEnvironment` so the env parsing is
 * testable on its own — building the gate needs an RPC endpoint, reading the
 * config does not.
 */
export declare function resolveSolanaSimulationEnvironment(): {
    readonly enabled: boolean;
    readonly rpcUrl: string | null;
    readonly timeoutMs: number;
    readonly maxComputeUnits?: number;
    readonly onUnavailable: SolanaSimulationUnavailablePolicy;
};
/**
 * Builds the gate from the environment, or returns null when it cannot run.
 *
 * Null rather than throwing, matching `createSolanaSignerFromEnvironment`: a
 * paper-mode box has no Solana RPC configured and must still boot. A null gate
 * means the runtime submits unsimulated — which is only reachable at all once
 * live execution is configured, because `resolveChainMode` clamps an
 * unconfigured Solana to paper first.
 *
 * `connectionFactory` is a parameter so this is testable without a network: the
 * default constructs a real `Connection`, which performs no I/O until used.
 */
export declare function createSolanaSimulationGateFromEnvironment(connectionFactory?: (rpcUrl: string) => SimulationConnection): SolanaSimulationGate | null;
//# sourceMappingURL=solana-simulation.d.ts.map