import type { Chain } from './types.js';

/**
 * Slippage tolerance resolution (`S4-P4`).
 *
 * Until now slippage was a hard-coded constant at each venue call site — 1500 bps
 * on the Solana live paths, 300 on Robinhood. That is survivable with one operator
 * whose appetite is whatever the constant says, and wrong the moment a second user
 * exists: two people with different risk appetites get the same ceiling, so a
 * user's "own stated limit" is not something the system can honour.
 *
 * It matters more than it looks. The `DG-7` decision — serve every eligible user
 * rather than capping fan-out — relies on each user's own tolerance rejecting a
 * bad fill, so that the platform never has to choose who misses a trade. Without a
 * per-user limit there is nothing bounding the tail of a 500-user fan-out except a
 * 15% constant, and `DG-7` is not safe to ship.
 *
 * **Per chain, not per user.** Tolerable slippage is a property of the venue, not
 * the person: 3% is loose on a Polymarket CLOB book and tight on a thin Solana
 * memecoin. A single global value would force a user to accept the loosest chain's
 * risk everywhere, so the setting lives on `user_chain_execution_settings`
 * (`(user_id, chain)`).
 */

/**
 * Defaults for a user who has not set a tolerance, matching the constants these
 * replace so behaviour is unchanged for anyone who never touches the setting.
 */
export const DEFAULT_SLIPPAGE_BPS: Readonly<Record<Chain, number>> = {
  solana: 1500,
  polygon: 300,
  'robinhood-chain': 300
} as const;

/**
 * Platform ceiling. A user may go looser than the chain default but not past this.
 *
 * Without it a user could set 90% and the executor would dutifully fill an order at
 * a tenth of the quoted price — technically "their stated limit", but not a risk
 * anyone chooses knowingly, and the kind of fill that reads as a platform failure
 * regardless of what the setting said. Mirrors the `CHECK` on the column.
 */
export const MAX_SLIPPAGE_BPS = 5_000;

/** Floor. Zero would make every order unfillable, which is a footgun, not a policy. */
export const MIN_SLIPPAGE_BPS = 1;

/**
 * Resolves the tolerance for one order.
 *
 * `null` means the user has never set a value and is deliberately distinct from a
 * user-chosen one — it is what lets a chain default be retuned later for users who
 * never expressed a preference, without silently overwriting anyone who did.
 *
 * A user value is used **as given**, tighter or looser. The chain default is a
 * default, never a floor: a user who asks for 50 bps on Solana gets 50, not 1500.
 * Treating the constant as a minimum would quietly widen the risk of every
 * cautious user to the platform's own appetite.
 */
export function resolveSlippageBps(
  chain: Chain,
  userValueBps: number | null | undefined
): number {
  if (userValueBps === null || userValueBps === undefined) {
    return DEFAULT_SLIPPAGE_BPS[chain];
  }
  if (!Number.isInteger(userValueBps)) {
    // A fractional bps is a caller bug, not a preference to round. Falling back to
    // the default would hide it; the venues take integers.
    throw new Error(`max_slippage_bps must be an integer, got ${userValueBps}`);
  }
  return Math.min(Math.max(userValueBps, MIN_SLIPPAGE_BPS), MAX_SLIPPAGE_BPS);
}

/** Whether a stored value is acceptable. Used by the API before persisting. */
export function isValidSlippageBps(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_SLIPPAGE_BPS
    && value <= MAX_SLIPPAGE_BPS
  );
}
