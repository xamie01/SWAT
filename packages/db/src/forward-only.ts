import type { PoolClient } from 'pg';
import { query } from './client.js';
import type { UserScope } from './tenancy.js';
import type { ForwardOnlySubscriptionWindow } from './forward-only-state.js';
export * from './forward-only-state.js';

/** Ambient read compatibility; the forward-only decision and its types are
 * shared with pool-free eligibility through forward-only-state. */

// ---------------------------------------------------------------------------
// The DB half: read the window, decide nothing.
// ---------------------------------------------------------------------------

/**
 * `active_since` is selected and `created_at` deliberately is not, so this
 * query cannot be edited into the wrong column by autocomplete.
 */
const FORWARD_ONLY_WINDOW_COLUMNS = 'user_id, wallet_address, state, active_since';

interface ForwardOnlyWindowRow {
  user_id: string;
  wallet_address: string;
  state: string;
  active_since: Date;
}

function toWindow(row: ForwardOnlyWindowRow): ForwardOnlySubscriptionWindow {
  return {
    userId: row.user_id,
    walletAddress: row.wallet_address,
    state: row.state,
    activeSince: row.active_since
  };
}

/**
 * Read one subscription's forward-only window **on a caller-supplied client**.
 *
 * This overload exists so the read can happen inside the transaction that is
 * about to create a copy execution. Reading through the pool instead would use
 * a different snapshot, and a subscription that ended between the read and the
 * insert would still get an entry.
 *
 * Every lifecycle state is returned, including `ended`: the decision needs to
 * distinguish "you unsubscribed" from "we have no record of you following this
 * wallet", and a `WHERE state <> 'ended'` here would collapse the two into one
 * skip code.
 *
 * `userId` is a plain string rather than a `UserScope` because on the copy path
 * the tenant has already been established and canonicalised by
 * `normalizeTenantId`; the branded type guards the boundary where a tenant id
 * could come from a request payload, which is what
 * {@link loadForwardOnlySubscriptionWindow} is for.
 */
export async function readForwardOnlySubscriptionWindow(
  client: Pick<PoolClient, 'query'>,
  input: { userId: string; walletAddress: string }
): Promise<ForwardOnlySubscriptionWindow | null> {
  const result = await client.query<ForwardOnlyWindowRow>(
    `SELECT ${FORWARD_ONLY_WINDOW_COLUMNS}
       FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2`,
    [input.userId, input.walletAddress]
  );
  const row = result.rows[0];
  return row ? toWindow(row) : null;
}

/**
 * Pool-scoped read for callers outside a transaction — the fan-out planner and
 * any API surface that wants to explain a skip after the fact.
 *
 * Takes a `UserScope` so the tenant cannot arrive from a request payload.
 * `walletAddress` must be the chain-prefixed master address.
 */
export async function loadForwardOnlySubscriptionWindow(
  scope: UserScope,
  walletAddress: string
): Promise<ForwardOnlySubscriptionWindow | null> {
  const rows = await query<ForwardOnlyWindowRow>(
    `SELECT ${FORWARD_ONLY_WINDOW_COLUMNS}
       FROM user_wallet_subscriptions
      WHERE user_id = $1 AND wallet_address = $2`,
    [scope.userId, walletAddress]
  );
  const row = rows[0];
  return row ? toWindow(row) : null;
}
