import type { Chain } from '@swat/shared';
import type { OpenPositionSnapshot, StopLossClaimInput } from '@swat/db';
import { isStopLossBreached, positionDrawdownPct } from '@swat/db';

/**
 * Stop-loss sweep. Runs on the back of the scorer's existing 5-minute
 * mark-to-market pass, so it reuses the prices that pass already fetched
 * instead of adding a second polling loop.
 *
 * Every dependency is injected so the sweep can be tested without Postgres,
 * Redis or BullMQ — same shape as `runAttributionReporting`.
 */

export const STOP_LOSS_ACCOUNT = 'operator';

/** The sell handed to the trade executor. Always closes the whole position. */
export type StopLossSellJob = {
  signalId: string;
  tokenMint: string;
  score: number;
  direction: 'sell';
  stopLoss: true;
  sellTokenAmount: number;
};

export type StopLossAlert = {
  type: 'STOP_LOSS_TRIGGERED';
  title: string;
  message: string;
  severity: 'high';
  chain: Chain;
};

export type StopLossSweepDependencies = {
  positions: OpenPositionSnapshot[];
  resolvePolicy: (account: string, chain: Chain) => Promise<{ stopLossPct: number }>;
  claim: (input: StopLossClaimInput) => Promise<boolean>;
  release: (account: string, signalId: string) => Promise<void>;
  /**
   * `chain` is passed explicitly rather than left for the caller to re-derive
   * from `job.tokenMint`: since S3-25 the queue is chosen per chain, and the
   * position already carries the authoritative chain. Re-deriving it would be a
   * second implementation of the same decision.
   */
  enqueueSell: (job: StopLossSellJob, jobId: string, chain: Chain) => Promise<unknown>;
  publishAlert: (alert: StopLossAlert) => Promise<unknown>;
  account?: string;
};

export type StopLossSweepResult = {
  scanned: number;
  breached: number;
  queued: number;
  alreadyTriggered: number;
  failed: number;
};

export function formatStopLossAlert(
  position: OpenPositionSnapshot,
  thresholdPct: number,
  drawdownPct: number
): StopLossAlert {
  return {
    type: 'STOP_LOSS_TRIGGERED',
    title: `Stop-loss triggered: ${position.tokenMint}`,
    message:
      `Position on ${position.tokenMint} is down ${drawdownPct.toFixed(2)}% ` +
      `against a ${thresholdPct}% stop-loss.\n` +
      `Signal: ${position.signalId}\n` +
      `Open quantity: ${position.openQuantity}\n` +
      `Cost basis: $${position.openCostBasisUsd.toFixed(2)}\n` +
      `Unrealised P&L: $${position.unrealizedPnlUsd.toFixed(2)}\n` +
      `A full closing sell has been queued.`,
    severity: 'high',
    chain: position.chain
  };
}

/**
 * Evaluate every open position against its chain's stop-loss threshold and
 * queue one closing sell per breach.
 *
 * The claim is what makes this exactly-once: `claim` inserts the single
 * (account, signal) row and only the winner queues a sell. If queueing then
 * fails the claim is released so the next sweep can retry — a position is never
 * left both unclaimed and unsold.
 */
export async function runStopLossSweep(
  dependencies: StopLossSweepDependencies
): Promise<StopLossSweepResult> {
  const account = dependencies.account ?? STOP_LOSS_ACCOUNT;
  const result: StopLossSweepResult = {
    scanned: dependencies.positions.length,
    breached: 0,
    queued: 0,
    alreadyTriggered: 0,
    failed: 0
  };

  const policyByChain = new Map<Chain, { stopLossPct: number }>();

  for (const position of dependencies.positions) {
    let policy = policyByChain.get(position.chain);
    if (!policy) {
      try {
        policy = await dependencies.resolvePolicy(account, position.chain);
      } catch (error) {
        console.error(`[scorer] stop-loss policy lookup failed for ${position.chain}`, error);
        result.failed++;
        continue;
      }
      policyByChain.set(position.chain, policy);
    }

    if (!isStopLossBreached(position, policy.stopLossPct)) continue;
    const drawdownPct = positionDrawdownPct(position);
    if (drawdownPct === null) continue;
    result.breached++;

    let claimed: boolean;
    try {
      claimed = await dependencies.claim({
        account,
        signalId: position.signalId,
        chain: position.chain,
        tokenMint: position.tokenMint,
        thresholdPct: policy.stopLossPct,
        drawdownPct,
        openQuantity: position.openQuantity,
        openCostBasisUsd: position.openCostBasisUsd,
        priceUsd: position.currentPriceUsd
      });
    } catch (error) {
      console.error(`[scorer] stop-loss claim failed for ${position.signalId}`, error);
      result.failed++;
      continue;
    }

    if (!claimed) {
      result.alreadyTriggered++;
      continue;
    }

    try {
      await dependencies.enqueueSell(
        {
          signalId: position.signalId,
          tokenMint: position.tokenMint,
          score: 100,
          direction: 'sell',
          stopLoss: true,
          sellTokenAmount: position.openQuantity
        },
        `stop-loss-${account}-${position.signalId}`,
        position.chain
      );
    } catch (error) {
      console.error(`[scorer] stop-loss sell enqueue failed for ${position.signalId}`, error);
      await dependencies.release(account, position.signalId).catch((releaseError) => {
        console.error(`[scorer] stop-loss claim release failed for ${position.signalId}`, releaseError);
      });
      result.failed++;
      continue;
    }

    result.queued++;

    // Alerting must not undo a queued exit, so a failure here is logged only.
    await dependencies
      .publishAlert(formatStopLossAlert(position, policy.stopLossPct, drawdownPct))
      .catch((error) => {
        console.error(`[scorer] stop-loss alert failed for ${position.signalId}`, error);
      });
  }

  return result;
}
