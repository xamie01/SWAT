/**
 * Net LP result (LP Dashboard Track A4).
 *
 * The single definition of "what did this LP position actually earn" — reused
 * verbatim by the wallet PnL calculator (Track D3) and the rebalance economic
 * check (Track F3), so its sign convention is a contract, not an implementation
 * detail:
 *
 *   - Every cost (`impermanentLoss`, `gasCost`, `rebalanceCost`) is stated as a
 *     **positive** number and subtracted. Passing IL as a negative "loss" would
 *     double-count it as a gain, so these inputs are validated ≥ 0.
 *   - `inventoryChange` is **signed**: positive when the position's asset
 *     inventory is worth more than the deposit baseline (price drift or
 *     appreciation), negative when it is worth less.
 *   - `feesEarned` is ≥ 0 — collected plus accrued fees, USD.
 *   - All inputs are USD over the same window. Mixing windows (24h fees with
 *     all-time IL) is the caller's bug and silently produces garbage; callers
 *     should assert their windows line up.
 *
 * Pure: no chain calls, no side effects. That is the point — Tracks D, E, and F
 * can each hold one against fixtures.
 */
export interface NetLpResultInput {
  /** Fees collected plus accrued over the window, USD. */
  readonly feesEarned: number;
  /** Impermanent loss over the window, USD, stated positive. */
  readonly impermanentLoss: number;
  /** Gas paid over the window, USD, stated positive. */
  readonly gasCost: number;
  /** Repositioning cost (swap slippage from re-centering, not gas), USD, stated positive. */
  readonly rebalanceCost: number;
  /** Signed change in inventory value versus the deposit baseline, USD. */
  readonly inventoryChange: number;
}

function assertCost(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative cost, got ${value}`);
  }
}

/**
 * `feesEarned + inventoryChange − impermanentLoss − gasCost − rebalanceCost`.
 *
 * Negative is a normal answer: LP is not free to hold, and a window of IL plus
 * gas can absolutely out-earn its fees. The rebalance gate (Track F) treats
 * `netLpResult ≤ 0` as "repositioning did not pay for itself", not as an error.
 */
export function netLpResult(input: NetLpResultInput): number {
  assertCost('feesEarned', input.feesEarned);
  assertCost('impermanentLoss', input.impermanentLoss);
  assertCost('gasCost', input.gasCost);
  assertCost('rebalanceCost', input.rebalanceCost);
  if (!Number.isFinite(input.inventoryChange)) {
    throw new Error(`inventoryChange must be finite, got ${input.inventoryChange}`);
  }

  return (
    input.feesEarned
    + input.inventoryChange
    - input.impermanentLoss
    - input.gasCost
    - input.rebalanceCost
  );
}
