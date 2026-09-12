import type { Chain } from '@swat/shared';
import { pool } from './client.js';

/**
 * Per-account EVM nonce serialisation (`S4-M12`).
 *
 * **This closes a correctness bug, not a performance one.** The EVM executor
 * reads the account's pending nonce and then increments it locally between the
 * approval and the swap (`apps/trade-executor/src/robinhood.ts`). Two concurrent
 * jobs for the same account read the *same* pending nonce, both submit a
 * transaction claiming it, and the node keeps one. The other is silently
 * replaced: no revert, no error, no failed job — a fill simply never happens,
 * and the only trace is a position that never opened. Under per-user fan-out
 * every user gets their own key, so the collision moves from "unlikely" to
 * "whenever one user's two signals overlap".
 *
 * `S3-25`'s concurrency-1-per-chain worker makes this rare inside a single
 * executor process, but it is not a fix: the pre-split `swat-trades` drain
 * worker is chain-agnostic and can run a second Robinhood job concurrently, and
 * a second executor replica reopens the window permanently. A lock outside the
 * process is the only thing that holds in both cases.
 *
 * **Why a session-level advisory lock rather than the transaction-scoped
 * `pg_advisory_xact_lock` used elsewhere in this file's sibling
 * (`copy-trade-lifecycle.ts:1404`):** the critical section spans RPC calls and a
 * receipt wait, so it cannot live inside one database transaction without
 * holding that transaction open across the network. A session lock releases on
 * `pg_advisory_unlock` *or* when the backend session ends — which means a crashed
 * executor releases its locks automatically, with no TTL sweep to write and no
 * possibility of a wedged account surviving a restart. A lease row in a table
 * would have needed both.
 */

/**
 * The lock's text key, hashed to a bigint by `hashtextextended` in SQL.
 *
 * Exported and pure so the keying rules are testable without a database, since
 * getting them wrong fails in the two directions that matter and neither is
 * visible at runtime: too coarse and unrelated accounts serialise against each
 * other, too fine and two jobs for one account both proceed.
 *
 * `chain` is part of the key because nonces are per (chain, account) — the same
 * address on `polygon` and on `robinhood-chain` has two independent nonce
 * sequences, and locking them together would serialise a user's Polymarket and
 * Robinhood mirrors for no reason. The address is lowercased because EVM
 * addresses are case-insensitive and arrive both checksummed (from viem, which
 * returns `getAddress` form) and lowercased (from `resolveChainValue`, which
 * lowercases every EVM value); the same account must not yield two keys.
 *
 * The `evm-nonce:` namespace keeps these keys away from every other advisory
 * lock in the codebase — notably `migrate.ts`'s `pg_advisory_lock(1)` and the
 * copy-position locks in `copy-trade-lifecycle.ts`.
 */
export function evmNonceLockKey(chain: Chain, account: string): string {
  const normalized = account.trim().toLowerCase();
  if (!normalized) throw new Error('evmNonceLockKey requires a non-empty account');
  if (normalized.includes(':')) {
    // A chain-prefixed value here would key the lock differently from the bare
    // address the executor signs with, so the two would not exclude each other.
    throw new Error(`evmNonceLockKey requires a bare address, got prefixed ${account}`);
  }
  return JSON.stringify(['evm-nonce', chain, normalized]);
}

export type EvmNonceLockOutcome<T> =
  | { acquired: true; result: T }
  | { acquired: false; result?: undefined };

/**
 * Runs `run` while holding the exclusive nonce lock for `(chain, account)`.
 *
 * Returns `{acquired: false}` **without running** when another holder has the
 * lock. It does not block: a blocking `pg_advisory_lock` would sit past the
 * BullMQ job's lock duration and get the job declared stalled, which is a worse
 * failure than a clean retry. The caller should surface a retryable state so the
 * queue re-delivers the job after the current holder has submitted and the
 * node's pending nonce has advanced.
 *
 * Errors from `run` propagate unchanged, after the lock is released.
 */
export async function withEvmNonceLock<T>(input: {
  chain: Chain;
  account: string;
  run: () => Promise<T>;
}): Promise<EvmNonceLockOutcome<T>> {
  const key = evmNonceLockKey(input.chain, input.account);
  const client = await pool.connect();

  // Registered before the first statement, for the same reason
  // `withTransaction` does it: a checked-out client is not covered by the pool's
  // error handler, and an EventEmitter that emits 'error' with no listener
  // throws — so a database restart mid-trade would take the process down rather
  // than failing the one trade in flight.
  const swallowClientError = (): void => {};
  client.on('error', swallowClientError);

  let connectionBroken = false;
  let held = false;
  try {
    const locked = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`,
      [key]
    );
    held = locked.rows[0]?.locked === true;
    if (!held) return { acquired: false };
    return { acquired: true, result: await input.run() };
  } catch (error) {
    // A failure here must not return the connection to the pool still holding
    // the lock; the finally below handles that. Rethrow so the caller fails the
    // trade rather than proceeding unserialised.
    throw error;
  } finally {
    if (held) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [key]);
      } catch {
        // The unlock failed, so this session may still hold the lock. Destroying
        // the client ends the session, and a session-scoped advisory lock dies
        // with it. Returning it to the pool instead would leak the lock for the
        // life of that pooled connection and wedge the account indefinitely —
        // the one outcome worse than failing this trade.
        connectionBroken = true;
      }
    }
    client.off('error', swallowClientError);
    client.release(connectionBroken);
  }
}
