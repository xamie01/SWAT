import { query } from './client.js';
import { withTransaction } from './transaction.js';
const chains = new Set(['solana', 'polygon', 'robinhood-chain']);
const initialState = {
    consecutiveFailures: 0,
    trippedAt: null
};
export class CircuitBreakerStateCorruptionError extends Error {
    constructor(account, chain) {
        super(`Circuit breaker state for ${account}:${chain} is malformed; refusing to continue`);
        this.name = 'CircuitBreakerStateCorruptionError';
    }
}
function assertChain(chain) {
    if (!chains.has(chain)) {
        throw new Error(`Unsupported circuit breaker chain: ${chain}`);
    }
}
function breakerKey(account, chain) {
    assertChain(chain);
    if (!account || typeof account !== 'string') {
        throw new Error('Account must be a non-empty string for circuit breaker keys');
    }
    return `breaker:${account}:${chain}`;
}
function serializeState(state) {
    return JSON.stringify(state);
}
function parseState(account, chain, value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new CircuitBreakerStateCorruptionError(account, chain);
    }
    const record = value;
    const keys = Object.keys(record).sort();
    const hasExactShape = keys.length === 2
        && keys[0] === 'consecutiveFailures'
        && keys[1] === 'trippedAt';
    const failures = record.consecutiveFailures;
    const trippedAt = record.trippedAt;
    const hasValidFailures = Number.isSafeInteger(failures) && Number(failures) >= 0;
    const hasValidTripTime = trippedAt === null || (typeof trippedAt === 'string'
        && trippedAt.length > 0
        && Number.isFinite(Date.parse(trippedAt)));
    if (!hasExactShape || !hasValidFailures || !hasValidTripTime) {
        throw new CircuitBreakerStateCorruptionError(account, chain);
    }
    return {
        consecutiveFailures: failures,
        trippedAt: trippedAt
    };
}
function validateThreshold(threshold) {
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
        throw new Error('Circuit breaker threshold must be an integer from 1 through 100');
    }
}
function validateFailureTime(failedAt) {
    if (!(failedAt instanceof Date) || Number.isNaN(failedAt.getTime())) {
        throw new Error('Circuit breaker failure time must be a valid date');
    }
}
function validateCooldown(cooldownMs) {
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs <= 0) {
        throw new Error('Circuit breaker cooldown must be a positive safe integer');
    }
}
/** Reads directly from PostgreSQL on every call so state is shared across processes and restarts. */
export async function readCircuitBreakerState(account, chain) {
    const key = breakerKey(account, chain);
    const rows = await query('SELECT value FROM config WHERE key = $1', [key]);
    if (rows.length === 0)
        throw new CircuitBreakerStateCorruptionError(account, chain);
    return parseState(account, chain, rows[0]?.value);
}
/** Atomically increments one chain and records the first threshold-crossing timestamp. */
export async function recordCircuitBreakerFailure(account, chain, threshold, failedAt = new Date()) {
    const key = breakerKey(account, chain);
    validateThreshold(threshold);
    validateFailureTime(failedAt);
    return withTransaction(async (client) => {
        const result = await client.query('SELECT value FROM config WHERE key = $1 FOR UPDATE', [key]);
        const current = parseState(account, chain, result.rows[0]?.value);
        const consecutiveFailures = Math.min(current.consecutiveFailures + 1, Number.MAX_SAFE_INTEGER);
        const next = {
            consecutiveFailures,
            trippedAt: current.trippedAt
                ?? (consecutiveFailures >= threshold ? failedAt.toISOString() : null)
        };
        await client.query(`UPDATE config
          SET value = $2::jsonb,
              updated_at = NOW()
        WHERE key = $1`, [key, serializeState(next)]);
        return next;
    });
}
/** Atomically clears one chain after validating and locking its persisted state. */
export async function recordCircuitBreakerSuccess(account, chain) {
    const key = breakerKey(account, chain);
    const reset = { ...initialState };
    return withTransaction(async (client) => {
        const result = await client.query('SELECT value FROM config WHERE key = $1 FOR UPDATE', [key]);
        parseState(account, chain, result.rows[0]?.value);
        await client.query(`UPDATE config
          SET value = $2::jsonb,
              updated_at = NOW()
        WHERE key = $1`, [key, serializeState(reset)]);
        return reset;
    });
}
/**
 * Claims one half-open recovery probe after the cooldown. Updating `trippedAt`
 * acts as a cross-process lease so concurrent workers continue delaying.
 */
export async function claimCircuitBreakerProbe(account, chain, cooldownMs, now = new Date()) {
    const key = breakerKey(account, chain);
    validateCooldown(cooldownMs);
    validateFailureTime(now);
    return withTransaction(async (client) => {
        const result = await client.query('SELECT value FROM config WHERE key = $1 FOR UPDATE', [key]);
        const current = parseState(account, chain, result.rows[0]?.value);
        // Returning commits the (read-only) transaction and releases the row lock,
        // which is what the explicit COMMIT on these paths did.
        if (current.trippedAt === null)
            return false;
        const elapsedMs = now.getTime() - Date.parse(current.trippedAt);
        if (!Number.isFinite(elapsedMs) || elapsedMs < cooldownMs)
            return false;
        const leased = {
            consecutiveFailures: current.consecutiveFailures,
            trippedAt: now.toISOString()
        };
        await client.query(`UPDATE config
          SET value = $2::jsonb,
              updated_at = NOW()
        WHERE key = $1`, [key, serializeState(leased)]);
        return true;
    });
}
//# sourceMappingURL=circuit-breaker.js.map