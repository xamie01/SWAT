import type { Chain } from '@swat/shared';
import type { QueryResultRow } from 'pg';
import { pool, query } from './client.js';

export interface CircuitBreakerState {
  consecutiveFailures: number;
  trippedAt: string | null;
}

type CircuitBreakerRow = QueryResultRow & { value: unknown };

const chains = new Set<Chain>(['solana', 'polygon', 'robinhood-chain']);
const initialState: CircuitBreakerState = {
  consecutiveFailures: 0,
  trippedAt: null
};

export class CircuitBreakerStateCorruptionError extends Error {
  constructor(account: string, chain: Chain) {
    super(`Circuit breaker state for ${account}:${chain} is malformed; refusing to continue`);
    this.name = 'CircuitBreakerStateCorruptionError';
  }
}

function assertChain(chain: Chain): void {
  if (!chains.has(chain)) {
    throw new Error(`Unsupported circuit breaker chain: ${chain}`);
  }
}

function breakerKey(account: string, chain: Chain): string {
  assertChain(chain);
  if (!account || typeof account !== 'string') {
    throw new Error('Account must be a non-empty string for circuit breaker keys');
  }
  return `breaker:${account}:${chain}`;
}

function serializeState(state: CircuitBreakerState): string {
  return JSON.stringify(state);
}

function parseState(account: string, chain: Chain, value: unknown): CircuitBreakerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CircuitBreakerStateCorruptionError(account, chain);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const hasExactShape = keys.length === 2
    && keys[0] === 'consecutiveFailures'
    && keys[1] === 'trippedAt';
  const failures = record.consecutiveFailures;
  const trippedAt = record.trippedAt;
  const hasValidFailures = Number.isSafeInteger(failures) && Number(failures) >= 0;
  const hasValidTripTime = trippedAt === null || (
    typeof trippedAt === 'string'
    && trippedAt.length > 0
    && Number.isFinite(Date.parse(trippedAt))
  );

  if (!hasExactShape || !hasValidFailures || !hasValidTripTime) {
    throw new CircuitBreakerStateCorruptionError(account, chain);
  }

  return {
    consecutiveFailures: failures as number,
    trippedAt: trippedAt as string | null
  };
}

function validateThreshold(threshold: number): void {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
    throw new Error('Circuit breaker threshold must be an integer from 1 through 100');
  }
}

function validateFailureTime(failedAt: Date): void {
  if (!(failedAt instanceof Date) || Number.isNaN(failedAt.getTime())) {
    throw new Error('Circuit breaker failure time must be a valid date');
  }
}

function validateCooldown(cooldownMs: number): void {
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs <= 0) {
    throw new Error('Circuit breaker cooldown must be a positive safe integer');
  }
}

/** Reads directly from PostgreSQL on every call so state is shared across processes and restarts. */
export async function readCircuitBreakerState(account: string, chain: Chain): Promise<CircuitBreakerState> {
  const key = breakerKey(account, chain);
  const rows = await query<CircuitBreakerRow>(
    'SELECT value FROM config WHERE key = $1',
    [key]
  );

  if (rows.length === 0) throw new CircuitBreakerStateCorruptionError(account, chain);
  return parseState(account, chain, rows[0]?.value);
}

/** Atomically increments one chain and records the first threshold-crossing timestamp. */
export async function recordCircuitBreakerFailure(
  account: string,
  chain: Chain,
  threshold: number,
  failedAt = new Date()
): Promise<CircuitBreakerState> {
  const key = breakerKey(account, chain);
  validateThreshold(threshold);
  validateFailureTime(failedAt);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<CircuitBreakerRow>(
      'SELECT value FROM config WHERE key = $1 FOR UPDATE',
      [key]
    );
    const current = parseState(account, chain, result.rows[0]?.value);
    const consecutiveFailures = Math.min(
      current.consecutiveFailures + 1,
      Number.MAX_SAFE_INTEGER
    );
    const next: CircuitBreakerState = {
      consecutiveFailures,
      trippedAt: current.trippedAt
        ?? (consecutiveFailures >= threshold ? failedAt.toISOString() : null)
    };

    await client.query(
      `UPDATE config
          SET value = $2::jsonb,
              updated_at = NOW()
        WHERE key = $1`,
      [key, serializeState(next)]
    );
    await client.query('COMMIT');
    return next;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Atomically clears one chain after validating and locking its persisted state. */
export async function recordCircuitBreakerSuccess(account: string, chain: Chain): Promise<CircuitBreakerState> {
  const key = breakerKey(account, chain);
  const reset = { ...initialState };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query<CircuitBreakerRow>(
      'SELECT value FROM config WHERE key = $1 FOR UPDATE',
      [key]
    );
    parseState(account, chain, result.rows[0]?.value);
    await client.query(
      `UPDATE config
          SET value = $2::jsonb,
              updated_at = NOW()
        WHERE key = $1`,
      [key, serializeState(reset)]
    );
    await client.query('COMMIT');
    return reset;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Claims one half-open recovery probe after the cooldown. Updating `trippedAt`
 * acts as a cross-process lease so concurrent workers continue delaying.
 */
export async function claimCircuitBreakerProbe(
  account: string,
  chain: Chain,
  cooldownMs: number,
  now = new Date()
): Promise<boolean> {
  const key = breakerKey(account, chain);
  validateCooldown(cooldownMs);
  validateFailureTime(now);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query<CircuitBreakerRow>(
      'SELECT value FROM config WHERE key = $1 FOR UPDATE',
      [key]
    );
    const current = parseState(account, chain, result.rows[0]?.value);
    if (current.trippedAt === null) {
      await client.query('COMMIT');
      return false;
    }

    const elapsedMs = now.getTime() - Date.parse(current.trippedAt);
    if (!Number.isFinite(elapsedMs) || elapsedMs < cooldownMs) {
      await client.query('COMMIT');
      return false;
    }

    const leased: CircuitBreakerState = {
      consecutiveFailures: current.consecutiveFailures,
      trippedAt: now.toISOString()
    };
    await client.query(
      `UPDATE config
          SET value = $2::jsonb,
              updated_at = NOW()
        WHERE key = $1`,
      [key, serializeState(leased)]
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
