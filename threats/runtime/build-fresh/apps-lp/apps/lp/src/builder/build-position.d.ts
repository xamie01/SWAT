import { createLpPosition, transitionLpPosition, type UserScope } from '@swat/db';
import type { LpStrategyType } from '@swat/db';
import type { LpChain, LpProtocol } from '@swat/shared';
import { buildLadderPlan, type LadderRung } from './ladder-plan.js';
import type { EvmRungStep } from './evm-ladder.js';
import type { RungTxStep } from './meteora-ladder.js';
import { type StrategyTemplateName } from './templates.js';
/**
 * The build-position entrypoint (Track E6) — what the "Deploy Ladder" button
 * calls. One function in: `{chain, pool, template-or-custom, deposit}`; one
 * result out: a persisted `building` position plus its execution bundle.
 *
 * Two gates run before anything is built, in order:
 *
 *   1. The chain execution mode (the existing `resolveChainMode` clamp —
 *      fail-closed to paper, live requires `LIVE_ENABLED_CHAINS` plus an
 *      active certification). `off` refuses outright.
 *   2. The guardrail deploy check (Track G1's exposure cap), behind a port so
 *      this module stays oblivious to how the cap is computed.
 *
 * In paper mode the bundle is a *plan*: steps are returned unsigned and never
 * broadcast. Only a live-clamped chain returns sign-ready steps, and even then
 * the executor submits, not this function.
 */
export type ExecutionMode = 'off' | 'paper' | 'live';
export interface ExecutionModePort {
    resolveMode(chain: LpChain): Promise<ExecutionMode>;
}
export interface DeployGuardDecision {
    readonly allowed: boolean;
    readonly reasons: readonly string[];
}
export interface DeployGuardPort {
    assertDeployAllowed(input: {
        readonly scope: UserScope;
        readonly chain: LpChain;
        readonly poolAddress: string;
        readonly depositAmount: number;
    }): Promise<DeployGuardDecision>;
}
export interface LadderPoolView {
    readonly protocol: LpProtocol;
    readonly binStep: number | null;
    readonly tickSpacing: number | null;
    readonly currentPrice: number | null;
}
export interface PoolViewPort {
    getPool(chain: LpChain, poolAddress: string): Promise<LadderPoolView | null>;
}
export interface CustomLadderParams {
    readonly rangeLower: number;
    readonly rangeUpper: number;
    readonly rungCount: number;
    readonly distribution: LpStrategyType;
}
export interface BuildPositionRequest {
    readonly chain: LpChain;
    /** Chain-prefixed. */
    readonly poolAddress: string;
    /** Either a named preset or explicit ladder parameters. */
    readonly template?: StrategyTemplateName;
    readonly custom?: CustomLadderParams;
    readonly depositAmount: number;
    /** Chain-prefixed deposit asset. */
    readonly depositAsset: string;
    /** Track I: opt this position into monitor-driven auto-rebalancing. Default false. */
    readonly autoRebalance?: boolean;
}
export type LadderExecutionStep = RungTxStep | EvmRungStep;
export interface BuildPositionResult {
    readonly positionId: string;
    readonly mode: ExecutionMode;
    readonly rungs: readonly LadderRung[];
    readonly steps: readonly LadderExecutionStep[];
    readonly rejectionReasons: readonly string[];
}
export interface BuildPositionDeps {
    readonly executionMode: ExecutionModePort;
    readonly deployGuard: DeployGuardPort;
    readonly poolView: PoolViewPort;
    readonly meteoraBuilder?: {
        buildLadder(input: {
            readonly plan: ReturnType<typeof buildLadderPlan>;
            readonly pairAddress: string;
            readonly userAddress: string;
            readonly currentPrice: number;
            readonly distribution: LpStrategyType;
            readonly slippageBps?: number;
        }): Promise<readonly RungTxStep[]>;
    };
    readonly evmBuilder?: {
        buildLadder(input: {
            readonly plan: ReturnType<typeof buildLadderPlan>;
            readonly poolAddress: string;
            readonly recipient: string;
            readonly currentPrice: number;
            readonly distribution: LpStrategyType;
            readonly slippageBps?: number;
        }): Promise<readonly EvmRungStep[]>;
    };
    readonly createPosition?: typeof createLpPosition;
    readonly transitionPosition?: typeof transitionLpPosition;
    readonly userAddress: string;
}
export declare function buildPosition(deps: BuildPositionDeps, scope: UserScope, request: BuildPositionRequest): Promise<BuildPositionResult>;
//# sourceMappingURL=build-position.d.ts.map