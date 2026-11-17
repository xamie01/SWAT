import type { LpChain, LpProtocol } from '@swat/shared';
import type { createValuedLpPosition, findLpAcquisition, LpStrategyType, LpUsdValuation, UserScope } from '@swat/db';
import type { LpPaperService } from '@swat/db/dist/lp-paper-service.js';
import type { LpExactAcquisitionRequest, LpExactPosition } from '@swat/db/dist/lp-exact.js';
import type { buildLadderPlan, LadderRung } from './ladder-plan.js';
import type { EvmRungStep } from './evm-ladder.js';
import type { RungTxStep } from './meteora-ladder.js';
import type { StrategyTemplateName } from './templates.js';

export type ExecutionMode = 'off' | 'paper' | 'live';
export interface ExecutionModePort { resolveMode(chain: LpChain): Promise<ExecutionMode> }
export interface DeployGuardDecision { readonly allowed: boolean; readonly reasons: readonly string[] }
export interface DeployGuardPort {
  assertDeployAllowed(input: { readonly scope: UserScope; readonly chain: LpChain; readonly poolAddress: string; readonly requestedUsd: number }): Promise<DeployGuardDecision>;
}
export interface LadderPoolView {
  readonly protocol: LpProtocol;
  readonly binStep: number | null;
  readonly tickSpacing: number | null;
  readonly observedAt?: Date;
  readonly currentPrice: number | null;
}
export interface PoolViewPort { getPool(chain: LpChain, poolAddress: string): Promise<LadderPoolView | null> }
export interface CustomLadderParams {
  readonly rangeLower: number;
  readonly rangeUpper: number;
  readonly rungCount: number;
  readonly distribution: LpStrategyType;
}
/** Deprecated numeric DTO retained for callers' type compatibility, but cannot admit capital. */
export interface BuildPositionRequest {
  readonly chain: LpChain;
  readonly poolAddress: string;
  readonly template?: StrategyTemplateName;
  readonly custom?: CustomLadderParams;
  readonly operationKey?: string;
  readonly depositAmount: number;
  readonly depositAsset: string;
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
  readonly exactPaper?: LpPaperService;
  readonly meteoraBuilder?: {
    buildLadder(input: { readonly plan: ReturnType<typeof buildLadderPlan>; readonly pairAddress: string; readonly userAddress: string;
      readonly currentPrice: number; readonly distribution: LpStrategyType; readonly slippageBps?: number }): Promise<readonly RungTxStep[]>;
  };
  readonly evmBuilder?: {
    buildLadder(input: { readonly plan: ReturnType<typeof buildLadderPlan>; readonly poolAddress: string; readonly recipient: string;
      readonly currentPrice: number; readonly distribution: LpStrategyType; readonly slippageBps?: number }): Promise<readonly EvmRungStep[]>;
  };
  readonly valuation?: { value(input: { chain: LpChain; asset: string; quantity: number }): Promise<LpUsdValuation | null> };
  readonly persistPosition?: typeof createValuedLpPosition;
  readonly findAcquisition?: typeof findLpAcquisition;
  readonly createPosition?: unknown;
  readonly transitionPosition?: unknown;
  readonly now?: () => Date;
  readonly userAddress: string;
}
export async function buildExactPosition(deps: Pick<BuildPositionDeps, 'exactPaper'>, scope: UserScope, request: LpExactAcquisitionRequest): Promise<LpExactPosition> {
  if (!deps.exactPaper) throw new Error('LP exact injected quote/receipt capability unavailable');
  return deps.exactPaper.acquire(scope, request);
}
/** No label-only float valuation or unsigned plan is allowed to assert a financial acquisition. */
export async function buildPosition(_deps: BuildPositionDeps, _scope: UserScope, _request: BuildPositionRequest): Promise<BuildPositionResult> {
  throw new Error('LP legacy numeric acquisition unavailable; exact rawscale quote-bound DTO required');
}
