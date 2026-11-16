import { query } from './client.js';
import { withTransaction } from './transaction.js';

export type SignalNotificationClaim = 'claimed' | 'busy' | 'delivered' | 'uncertain' | 'missing';

/** Preparing is reclaimable; sending is never automatically reclaimed. */
export async function claimSignalNotification(
  signalId: string,
  ownerToken: string,
  leaseMs = 60_000
): Promise<SignalNotificationClaim> {
  if (!ownerToken.trim() || ownerToken.length > 128) throw new Error('notification owner token is required');
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 60_000) {
    throw new Error('notification lease must be an integer in 1000..60000 milliseconds');
  }
  return withTransaction(async client => {
    const signal = await client.query<{ alerted_at: Date | null }>(
      'SELECT alerted_at FROM signals WHERE id = $1 FOR UPDATE', [signalId]
    );
    if (!signal.rows[0]) return 'missing';
    // Historical alerted_at is sufficient only to withhold another send; it is
    // not used to infer execution completion or reconcile an uncertain attempt.
    const initialState = signal.rows[0].alerted_at ? 'delivered' : 'pending';
    await client.query(
      `INSERT INTO signal_notification_deliveries (signal_id, state)
       VALUES ($1, $2) ON CONFLICT (signal_id) DO NOTHING`, [signalId, initialState]
    );
    const claimed = await client.query<{ signal_id: string }>(
      `UPDATE signal_notification_deliveries
       SET state = 'preparing', owner_token = $2,
           lease_expires_at = NOW() + $3 * INTERVAL '1 millisecond', updated_at = NOW()
       WHERE signal_id = $1 AND $4::boolean = FALSE
         AND (state = 'pending' OR (state = 'preparing' AND lease_expires_at <= NOW()))
       RETURNING signal_id`, [signalId, ownerToken, leaseMs, initialState === 'delivered']
    );
    if (claimed.rows.length) return 'claimed';
    const result = await client.query<{ state: string; expired: boolean }>(
      `SELECT state, lease_expires_at <= NOW() AS expired
       FROM signal_notification_deliveries WHERE signal_id = $1`, [signalId]
    );
    const row = result.rows[0];
    if (row?.state === 'uncertain' || (row?.state === 'sending' && row.expired)) return 'uncertain';
    if (row?.state === 'delivered' || initialState === 'delivered') return 'delivered';
    return 'busy';
  });
}

export async function beginSignalNotificationSend(signalId: string, ownerToken: string): Promise<boolean> {
  const rows = await query<{ signal_id: string }>(
    `UPDATE signal_notification_deliveries SET state = 'sending', updated_at = NOW()
     WHERE signal_id = $1 AND owner_token = $2 AND state = 'preparing'
       AND lease_expires_at > NOW() RETURNING signal_id`, [signalId, ownerToken]
  );
  return rows.length > 0;
}

/** Delivered bookkeeping and the legacy notification stamp commit together. */
export async function completeSignalNotification(signalId: string, ownerToken: string): Promise<boolean> {
  return withTransaction(async client => {
    // Same lock order as claim: signal first, notification second.
    await client.query('SELECT id FROM signals WHERE id = $1 FOR UPDATE', [signalId]);
    const result = await client.query<{ signal_id: string }>(
      `UPDATE signal_notification_deliveries
       SET state = 'delivered', delivered_at = NOW(), lease_expires_at = NULL, updated_at = NOW()
       WHERE signal_id = $1 AND owner_token = $2 AND state = 'sending' RETURNING signal_id`,
      [signalId, ownerToken]
    );
    if (!result.rows.length) return false;
    await client.query(
      `UPDATE signals SET alerted_at = NOW(),
         status = CASE WHEN status = 'pending' THEN 'alerted' ELSE status END
       WHERE id = $1 AND alerted_at IS NULL`, [signalId]
    );
    return true;
  });
}

export async function markSignalNotificationUncertain(signalId: string, ownerToken: string): Promise<boolean> {
  const rows = await query<{ signal_id: string }>(
    `UPDATE signal_notification_deliveries SET state = 'uncertain', updated_at = NOW()
     WHERE signal_id = $1 AND owner_token = $2 AND state = 'sending' RETURNING signal_id`,
    [signalId, ownerToken]
  );
  return rows.length > 0;
}

/** An old owner, or any attempt that might have sent, cannot clear a newer lease. */
export async function releaseSignalNotification(signalId: string, ownerToken: string): Promise<boolean> {
  const rows = await query<{ signal_id: string }>(
    `UPDATE signal_notification_deliveries
     SET state = 'pending', owner_token = NULL, lease_expires_at = NULL, updated_at = NOW()
     WHERE signal_id = $1 AND owner_token = $2 AND state = 'preparing' RETURNING signal_id`,
    [signalId, ownerToken]
  );
  return rows.length > 0;
}
