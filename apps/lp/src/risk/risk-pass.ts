import { attachLpPoolRisk, listUnassessedLpPools, type LpPool } from '@swat/db';
import { combineTokenRisk } from './score.js';
import type { TokenRiskCheck, TokenRiskContext } from './types.js';

/**
 * The risk pass (Track C6) — attaches a risk score to every scanned pool so
 * nothing reaches the Discover feed without one.
 *
 * Runs after the scan job, over pools whose `risk_score` is still NULL. One
 * pool's check failing must not block the others: the failed pool simply stays
 * unassessed (and therefore unlisted) until the next pass — "we have not
 * looked yet" is the honest state, and the feed already excludes it.
 */

export interface RiskPassDeps {
  /** Checks per chain; a pool is assessed by its chain's checks. */
  readonly checksByChain: Record<string, readonly TokenRiskCheck[]>;
  readonly listUnassessed?: typeof listUnassessedLpPools;
  readonly attachRisk?: typeof attachLpPoolRisk;
}

export interface RiskPassSummary {
  readonly assessed: number;
  readonly failed: number;
  /** Pools on a chain with no checks configured — left unassessed, never scored 0. */
  readonly skippedNoChecks: number;
}

function toContext(pool: LpPool): TokenRiskContext {
  return {
    chain: pool.chain,
    baseTokenMint: pool.baseTokenMint,
    quoteTokenMint: pool.quoteTokenMint,
    poolAddress: pool.poolAddress
  };
}

export async function runRiskPass(deps: RiskPassDeps): Promise<RiskPassSummary> {
  const listUnassessed = deps.listUnassessed ?? listUnassessedLpPools;
  const attachRisk = deps.attachRisk ?? attachLpPoolRisk;

  const unassessed = await listUnassessed(200);
  let assessed = 0;
  let failed = 0;
  let skippedNoChecks = 0;

  for (const pool of unassessed) {
    const checks = deps.checksByChain[pool.chain];
    if (!checks || checks.length === 0) {
      // A chain with no configured checks has NOT been looked at. Attaching a
      // score of 0 would present "we have not looked yet" as "clean" and put
      // the pool on the feed — the exact failure the NULL-vs-0 split on
      // lp_pools.risk_score exists to prevent.
      skippedNoChecks += 1;
      continue;
    }
    try {
      const findings = (await Promise.all(checks.map((check) => check(toContext(pool))))).flat();
      const combined = combineTokenRisk(findings);
      await attachRisk(pool.chain, pool.poolAddress, combined.score, combined.flags);
      assessed += 1;
    } catch (error) {
      failed += 1;
      console.error(
        '[lp] risk check failed for pool',
        pool.poolAddress,
        error instanceof Error ? error.message : error
      );
    }
  }

  return { assessed, failed, skippedNoChecks };
}
