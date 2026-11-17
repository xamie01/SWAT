import {
  lpAssertPlan, lpRaw, lpStrategy, type LpExactPlan, type LpExactStrategy, type LpPaperQuote
} from '@swat/db/dist/lp-exact.js';
import { createLpPaperService, type LpPaperServiceDeps } from '@swat/db/dist/lp-paper-service.js';
import { buildLadderPlan } from './ladder-plan.js';

/** Paper geometry only. Financial allocation uses integer raw shares, never float deposit arithmetic. */
export async function buildExactPaperPlan(quote: LpPaperQuote, strategy: LpExactStrategy): Promise<LpExactPlan> {
  lpStrategy(strategy);
  const amount = quote.amountAfter;
  const total = lpRaw(amount, true);
  const shape = buildLadderPlan({ protocol: quote.pool.protocol, ...strategy, distribution: strategy.distribution,
    currentPrice: quote.pool.currentPrice, binStep: quote.pool.binStep ?? undefined,
    tickSpacing: quote.pool.tickSpacing ?? undefined, depositAmount: 1 });
  const weights = shape.rungs.map(rung => {
    if (!Number.isFinite(rung.weight) || rung.weight <= 0) throw new Error('LP geometric weight unavailable');
    return BigInt(Math.max(1, Math.floor(rung.weight * 1_000_000_000_000)));
  });
  const denominator = weights.reduce((sum, weight) => sum + weight, 0n);
  const allocations = weights.map(weight => total * weight / denominator);
  let remainder = total - allocations.reduce((sum, value) => sum + value, 0n);
  // Deterministic largest-remainder allocation; dust belongs to an actual rung, never disappears.
  const rank = weights.map((weight, index) => ({ index, remainder: total * weight % denominator }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const entry of rank) { if (remainder === 0n) break; allocations[entry.index] = allocations[entry.index]! + 1n; remainder--; }
  const plan: LpExactPlan = { version: 2, protocol: quote.pool.protocol, strategy, poolEvidenceId: quote.pool.evidenceId,
    rungs: shape.rungs.map((rung, index) => ({ priceLower: rung.priceLower, priceUpper: rung.priceUpper,
      allocation: { raw: allocations[index]!.toString(), scale: amount.scale },
      ...(quote.pool.protocol === 'meteora-dlmm' ? { binLower: rung.binLower!, binUpper: rung.binUpper! }
        : { tickLower: rung.tickLower!, tickUpper: rung.tickUpper! }) })) };
  lpAssertPlan(plan, amount, quote.pool.protocol, quote.pool.evidenceId);
  return plan;
}
/** Injected construction seam, not an automatic oracle or protocol-provider implementation. */
export function createExactLpDomain(deps: Omit<LpPaperServiceDeps, 'plan'>) {
  return createLpPaperService({ ...deps, plan: buildExactPaperPlan });
}
