import type { PoolClient } from 'pg';

export type ResolutionPollSqlClient = Pick<PoolClient, 'query'>;
type State = { token: string; after: string | null; upper: string | null; attempted: number; failed: number };
type StoredState = {
  owner_token: string;
  after_id: string | null;
  upper_id: string | null;
  cycle_attempted: string;
  cycle_failed: string;
  cycle_open: boolean;
};

export type SqlResolutionPollDependencies<Observation> = {
  transaction<T>(operation: (client: ResolutionPollSqlClient) => Promise<T>): Promise<T>;
  /** Only bounded SQL; no providers/network. Called under the fenced cursor row lock. */
  applyObservation(client: ResolutionPollSqlClient, conditionId: string, observation: Observation): Promise<void>;
};

const pollKey = 'gamma-resolution-v1';
const columns = 'owner_token, after_id, upper_id, cycle_attempted, cycle_failed, cycle_open';

function decode(row: StoredState): State {
  const attempted = Number(row.cycle_attempted);
  const failed = Number(row.cycle_failed);
  if (!Number.isSafeInteger(attempted) || !Number.isSafeInteger(failed) || failed < 0 || attempted < failed
    || (row.after_id !== null && !/^0x[0-9a-f]{64}$/.test(row.after_id))
    || (row.upper_id !== null && !/^0x[0-9a-f]{64}$/.test(row.upper_id))
    || (row.after_id !== null && (row.upper_id === null || row.after_id > row.upper_id))) {
    throw new Error('Invalid durable Polymarket resolution cursor');
  }
  return { token: row.owner_token, after: row.after_id, upper: row.upper_id, attempted, failed };
}

/**
 * Requires the explicitly UNAPPLIED schema proposal in the polling aspect report.
 * Never creates tables or falls back to process memory. Runtime role, connection
 * acquisition, commit/rollback and transport cancellation remain deployment gates.
 */
export function createSqlResolutionPollStore<Observation>(dependencies: SqlResolutionPollDependencies<Observation>) {
  const transaction = <T>(operation: (client: ResolutionPollSqlClient) => Promise<T>) => dependencies.transaction(async client => {
    await client.query("SELECT set_config('statement_timeout', '1000', true), set_config('lock_timeout', '1000', true)");
    return operation(client);
  });

  async function lock(client: ResolutionPollSqlClient, state: State): Promise<void> {
    const result = await client.query<StoredState>(
      `SELECT ${columns} FROM polymarket_resolution_poll_progress
       WHERE poll_key = $1 AND owner_token = $2 AND lease_until > clock_timestamp() AND cycle_open = TRUE
       FOR UPDATE`, [pollKey, state.token]
    );
    if (result.rows.length !== 1) throw new Error('Polymarket resolution polling lease lost');
    const actual = decode(result.rows[0]!);
    if (actual.after !== state.after || actual.upper !== state.upper
      || actual.attempted !== state.attempted || actual.failed !== state.failed) {
      throw new Error('Stale Polymarket resolution polling progress');
    }
  }

  return {
    async claim(token: string, leaseMs: number): Promise<State | null> {
      if (!token || token.length > 200 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 130_000) {
        throw new Error('Invalid Polymarket resolution polling lease');
      }
      return transaction(async client => {
        await client.query(
          `INSERT INTO polymarket_resolution_poll_progress (poll_key) VALUES ($1) ON CONFLICT (poll_key) DO NOTHING`, [pollKey]
        );
        const claim = await client.query<StoredState>(
          `UPDATE polymarket_resolution_poll_progress
           SET owner_token = $2, lease_until = clock_timestamp() + ($3::integer * interval '1 millisecond')
           WHERE poll_key = $1 AND (lease_until IS NULL OR lease_until <= clock_timestamp())
           RETURNING ${columns}`, [pollKey, token, leaseMs]
        );
        const row = claim.rows[0];
        if (!row) return null;
        if (row.cycle_open) return decode(row);
        const upper = await client.query<{ condition_id: string }>(
          `SELECT condition_id FROM polymarket_markets
           WHERE status = 'active' AND context_complete = TRUE
           ORDER BY condition_id COLLATE "C" DESC LIMIT 1`
        );
        const initialized = await client.query<StoredState>(
          `UPDATE polymarket_resolution_poll_progress
           SET after_id = NULL, upper_id = $3, cycle_attempted = 0, cycle_failed = 0, cycle_open = TRUE
           WHERE poll_key = $1 AND owner_token = $2 RETURNING ${columns}`,
          [pollKey, token, upper.rows[0]?.condition_id ?? null]
        );
        if (initialized.rows.length !== 1) throw new Error('Polymarket resolution polling initialization failed');
        return decode(initialized.rows[0]!);
      });
    },

    async fetchPage(state: State, limit: number): Promise<{ conditionId: string; tickSize: string | null }[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) throw new Error('Invalid resolution keyset limit');
      return transaction(async client => {
        await lock(client, state);
        const rows = await client.query<{ condition_id: string; tick_size: string | null }>(
          `SELECT condition_id, tick_size::text FROM polymarket_markets
           WHERE status = 'active' AND context_complete = TRUE
             AND ($1::text IS NULL OR condition_id COLLATE "C" > $1::text COLLATE "C")
             AND condition_id COLLATE "C" <= $2::text COLLATE "C"
           ORDER BY condition_id COLLATE "C" ASC LIMIT $3`, [state.after, state.upper, limit]
        );
        if (rows.rows.length > limit) throw new Error('Oversized resolution keyset page');
        return rows.rows.map(row => ({ conditionId: row.condition_id, tickSize: row.tick_size }));
      });
    },

    async reserveAttempt(state: State, conditionId: string): Promise<State> {
      if (!/^0x[0-9a-f]{64}$/.test(conditionId) || !state.upper || conditionId > state.upper
        || (state.after !== null && conditionId <= state.after)) throw new Error('Invalid resolution polling reservation');
      return transaction(async client => {
        await lock(client, state);
        const result = await client.query<StoredState>(
          `UPDATE polymarket_resolution_poll_progress
           SET after_id = $3, cycle_attempted = cycle_attempted + 1, cycle_failed = cycle_failed + 1
           WHERE poll_key = $1 AND owner_token = $2 RETURNING ${columns}`, [pollKey, state.token, conditionId]
        );
        if (result.rows.length !== 1) throw new Error('Polymarket resolution polling reservation failed');
        return decode(result.rows[0]!);
      });
    },

    async settleCovered(state: State, observation: Observation): Promise<State> {
      if (!state.after || state.failed < 1) throw new Error('No reserved resolution polling attempt');
      return transaction(async client => {
        await lock(client, state);
        await dependencies.applyObservation(client, state.after!, observation);
        const result = await client.query<StoredState>(
          `UPDATE polymarket_resolution_poll_progress SET cycle_failed = cycle_failed - 1
           WHERE poll_key = $1 AND owner_token = $2 RETURNING ${columns}`, [pollKey, state.token]
        );
        if (result.rows.length !== 1) throw new Error('Polymarket resolution polling settlement failed');
        return decode(result.rows[0]!);
      });
    },

    async finishCycle(state: State): Promise<void> {
      await transaction(async client => {
        await lock(client, state);
        await client.query(
          `UPDATE polymarket_resolution_poll_progress SET cycle_open = FALSE
           WHERE poll_key = $1 AND owner_token = $2`, [pollKey, state.token]
        );
      });
    },

    async release(state: State): Promise<void> {
      await transaction(async client => {
        // An expired owner may release only its own lease, never the replacement's.
        await client.query(
          `UPDATE polymarket_resolution_poll_progress SET owner_token = NULL, lease_until = NULL
           WHERE poll_key = $1 AND owner_token = $2`, [pollKey, state.token]
        );
      });
    }
  };
}
