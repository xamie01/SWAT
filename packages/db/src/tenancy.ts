import type { PoolClient, QueryResultRow } from 'pg';
import * as transactionModule from './transaction.js';
import type { TransactionOptions } from './transaction.js';
import { isRuntimePoolClient } from './runtime-client-registry.js';
import { assertDatabaseRole } from './database-role.js';

/**
 * Tenant scoping (D12 & Migration 064).
 *
 * Dual-layer defense-in-depth security model:
 *
 * 1. Application Layer (TypeScript Nominal Typing):
 *    `user_id` comes from the verified session, never from an untrusted request payload.
 *    Per-user query functions take a `UserScope` as their first parameter. The only
 *    constructor is `forUser(userId)`, which ensures raw string bodies cannot be passed.
 *
 * 2. Database Layer (PostgreSQL Row-Level Security):
 *    PostgreSQL RLS is enabled and forced (`FORCE ROW LEVEL SECURITY`) across all 17
 *    user-scoped tables (`users`, `user_sessions`, `user_auth_wallets`, `user_api_keys`,
 *    `user_balances`, `user_wallet_subscriptions`, `user_token_watches`,
 *    `user_execution_grants`, `user_execution_settings`, `user_chain_execution_settings`,
 *    `user_payment_intents`, `crypto_payments`, `copy_positions`, `copy_executions`,
 *    `copy_position_master_lots`, `copy_position_applications`, `copy_position_close_all_claims`).
 *    When executing queries within `withTenantTransaction(scope, ...)` or `scopedQuery(scope, ...)`,
 *    Postgres sets `app.bypass_rls = 'off'` and `app.current_user_id = scope.userId`,
 *    enforcing kernel-level database isolation.
 */

declare const scopeBrand: unique symbol;

export interface UserScope {
  readonly userId: string;
  /** Prevents a bare `{ userId }` object literal from satisfying the type. */
  readonly [scopeBrand]: true;
}

/**
 * The only constructor for a `UserScope`.
 *
 * Call this with a session-derived id and nothing else. It is intentionally the
 * single grep target for "where does tenant scope enter the system?".
 */
export function forUser(userId: string): UserScope {
  if (!userId.trim() || userId.trim() === '*') {
    // An empty scope would silently widen every query built from it.
    throw new Error('forUser() requires a non-wildcard user id');
  }
  return { userId } as UserScope;
}

/**
 * Escape hatch for routes that legitimately cross tenants (admin listings,
 * platform-wide reports, background jobs).
 *
 * Deliberately verbose and separately named so that crossing tenants is
 * greppable rather than implicit — `grep -rn crossTenant` should return a short,
 * reviewable list. Any new occurrence is a security review item.
 */
export function crossTenantScope(reason: string): UserScope {
  if (!reason) throw new Error('crossTenantScope() requires a stated reason');
  return { userId: '*' } as UserScope;
}

export function isCrossTenant(scope: UserScope): boolean {
  return scope.userId === '*';
}

/**
 * Sets the PostgreSQL session variables for Row-Level Security on a checked-out client.
 *
 * Scopes queries to `scope.userId`, enabling Postgres RLS enforcement on all 17 user tables.
 * Setting `is_rls_bypassed = 'off'` activates kernel RLS filtering for specific users.
 * Cross-tenant administration is refused until a separate privileged capability is reviewed.
 */
export async function setTenantScope(client: PoolClient, scope: UserScope): Promise<void> {
  if (isCrossTenant(scope)) {
    throw new Error('Cross-tenant queries require a separately reviewed privileged capability');
  }
  if (!isRuntimePoolClient(client)) {
    await assertDatabaseRole(client, 'runtime');
    await client.query("SET LOCAL app.bypass_rls = 'off'");
  }
  await client.query("SELECT set_config('app.current_user_id', $1, true)", [scope.userId]);
}

/**
 * Executes an operation inside a PostgreSQL transaction with active Row-Level Security (RLS).
 *
 * Enforces database-level isolation so that queries cannot read or mutate another tenant's rows,
 * even in the event of an application-level SQL logic error.
 */
export async function withTenantTransaction<T>(
  scope: UserScope,
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  return transactionModule.withTransaction(async (client) => {
    await setTenantScope(client, scope);
    return operation(client);
  }, options);
}

/**
 * Executes a read operation under tenant RLS using `readPool` (falling back to
 * `writePool` when `DATABASE_READ_URL` is unset).
 */
export async function withTenantReadTransaction<T>(
  scope: UserScope,
  operation: (client: PoolClient) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const runReadTx =
    'withReadTransaction' in transactionModule && typeof transactionModule.withReadTransaction === 'function'
      ? transactionModule.withReadTransaction
      : transactionModule.withTransaction;
  return runReadTx(async (client) => {
    await setTenantScope(client, scope);
    return operation(client);
  }, options);
}

/**
 * Runs a single query under tenant Row-Level Security within an isolated transaction.
 */
export async function scopedQuery<T extends QueryResultRow = QueryResultRow>(
  scope: UserScope,
  text: string,
  values?: unknown[]
): Promise<T[]> {
  return withTenantTransaction(scope, async (client) => {
    const result = await client.query<T>(text, values);
    return result.rows;
  });
}

/**
 * Runs a single read query under tenant RLS via `withTenantReadTransaction`.
 */
export async function scopedReadQuery<T extends QueryResultRow = QueryResultRow>(
  scope: UserScope,
  text: string,
  values?: unknown[]
): Promise<T[]> {
  return withTenantReadTransaction(scope, async (client) => {
    const result = await client.query<T>(text, values);
    return result.rows;
  });
}
