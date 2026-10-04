import { createLpPosition, type UserScope } from '@swat/db';
import type { LpStrategyType } from '@swat/db';
import type { LpChain } from '@swat/shared';
import { buildLadderPlan, type LadderRung } from './ladder-plan.js';
import type { EvmRungStep } from './evm-ladder.js';
import type { RungTxStep } from './meteora-ladder.js';
import { resolveStrategyTemplate, type StrategyTemplateName } from './templates.js';

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
  readonly protocol: 'meteora-dlmm' | 'uniswap-v3' | 'uniswap-v4';
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
  readonly userAddress: string;
}

function resolveLadderParams(
  request: BuildPositionRequest,
  currentPrice: number
): CustomLadderParams {
  if (request.template && request.custom) {
    throw new Error('pass either a template or custom ladder params, not both');
  }
  if (request.template) {
    return resolveStrategyTemplate(request.template, currentPrice);
  }
  if (request.custom) {
    return request.custom;
  }
  throw new Error('a strategy template or custom ladder params is required');
}

export async function buildPosition(
  deps: BuildPositionDeps,
  scope: UserScope,
  request: BuildPositionRequest
): Promise<BuildPositionResult> {
  if (!Number.isFinite(request.depositAmount) || request.depositAmount <= 0) {
    throw new Error(`depositAmount must be positive, got ${request.depositAmount}`);
  }
  if (request.depositAsset.indexOf(':') < 0 || request.poolAddress.indexOf(':') < 0) {
    throw new Error('pool and deposit addresses must be chain-prefixed');
  }

  const mode = await deps.executionMode.resolveMode(request.chain);
  if (mode === 'off') {
    throw new Error(`LP execution on ${request.chain} is off`);
  }

  const guardDecision = await deps.deployGuard.assertDeployAllowed({
    scope,
    chain: request.chain,
    poolAddress: request.poolAddress,
    depositAmount: request.depositAmount
  });
  if (!guardDecision.allowed) {
    return {
      positionId: '',
      mode,
      rungs: [],
      steps: [],
      rejectionReasons: guardDecision.reasons
    };
  }

  const pool = await deps.poolView.getPool(request.chain, request.poolAddress);
  if (!pool) {
    throw new Error(`pool ${request.poolAddress} is not in the scan cache; run a scan first`);
  }
  const currentPrice = pool.currentPrice;
  if (currentPrice === null || currentPrice <= 0) {
    throw new Error(`pool ${request.poolAddress} has no current price to anchor the ladder`);
  }

  const params = resolveLadderParams(request, currentPrice);
  const plan = buildLadderPlan({
    protocol: pool.protocol,
    rangeLower: params.rangeLower,
    rangeUpper: params.rangeUpper,
    rungCount: params.rungCount,
    distribution: params.distribution,
    currentPrice,
    binStep: pool.binStep ?? undefined,
    tickSpacing: pool.tickSpacing ?? undefined,
    depositAmount: request.depositAmount
  });

  const createPosition = deps.createPosition ?? createLpPosition;
  const position = await createPosition(scope, {
    chain: request.chain,
    protocol: pool.protocol,
    poolAddress: request.poolAddress,
    strategyType: params.distribution,
    rangeLower: params.rangeLower,
    rangeUpper: params.rangeUpper,
    rungAllocations: plan.rungs,
    depositAmount: request.depositAmount,
    depositAsset: request.depositAsset,
    autoRebalance: request.autoRebalance === true
  });

  let steps: readonly LadderExecutionStep[];
  if (request.chain === 'solana') {
    if (!deps.meteoraBuilder) {
      throw new Error('meteora ladder builder is not configured');
    }
    steps = await deps.meteoraBuilder.buildLadder({
      plan,
      pairAddress: request.poolAddress,
      userAddress: deps.userAddress,
      currentPrice,
      distribution: params.distribution
    });
  } else {
    if (!deps.evmBuilder) {
      throw new Error('evm ladder builder is not configured');
    }
    steps = await deps.evmBuilder.buildLadder({
      plan,
      poolAddress: request.poolAddress,
      recipient: deps.userAddress,
      currentPrice,
      distribution: params.distribution
    });
  }

  return { positionId: position.id, mode, rungs: plan.rungs, steps, rejectionReasons: [] };
}
