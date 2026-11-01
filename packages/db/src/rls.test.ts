import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgresql://swat:swat@127.0.0.1:5432/swat';
});

import { pool, query } from './client.js';
import { forUser, crossTenantScope, scopedQuery, withTenantTransaction } from './tenancy.js';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const adminQuery = <T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> => scopedQuery<T>(crossTenantScope('rls_test_fixture'), text, values);

const EXPECTED_RLS_TABLES = [
  'users',
  'user_sessions',
  'user_auth_wallets',
  'user_api_keys',
  'user_balances',
  'user_wallet_subscriptions',
  'user_token_watches',
  'user_execution_grants',
  'user_execution_settings',
  'user_chain_execution_settings',
  'user_payment_intents',
  'crypto_payments',
  'copy_positions',
  'copy_executions',
  'copy_position_master_lots',
  'copy_position_applications',
  'copy_position_close_all_claims'
];

describe('PostgreSQL Row-Level Security (RLS) — Tenant Isolation', () => {
  beforeAll(async () => {
    // Clean up test fixtures if present
    await adminQuery("DELETE FROM user_execution_grants WHERE user_id IN ($1, $2)", [USER_A, USER_B]);
    await adminQuery("DELETE FROM user_balances WHERE user_id IN ($1, $2)", [USER_A, USER_B]);
    await adminQuery("DELETE FROM crypto_payments WHERE user_id IN ($1, $2)", [USER_A, USER_B]);
    await adminQuery("DELETE FROM users WHERE id IN ($1, $2)", [USER_A, USER_B]);

    // Seed two independent users using admin bypass
    await adminQuery(
      `INSERT INTO users (id, email, password_hash, role) VALUES 
       ($1, 'user_a@wake.protocol', 'hash_a', 'user'),
       ($2, 'user_b@wake.protocol', 'hash_b', 'user')`,
      [USER_A, USER_B]
    );

    // Seed User A & B Execution Grants (valid solana_vault grant)
    await adminQuery(
      `INSERT INTO user_execution_grants (id, user_id, chain, grant_kind, account_address, status) VALUES
       (gen_random_uuid(), $1, 'solana', 'solana_vault', 'AccountA1111111111111111111111111111111111', 'active'),
       (gen_random_uuid(), $2, 'solana', 'solana_vault', 'AccountB2222222222222222222222222222222222', 'active')`,
      [USER_A, USER_B]
    );

    // Seed User A & B Balances
    await adminQuery(
      `INSERT INTO user_balances (user_id, chain, asset, amount, decimals, source) VALUES
       ($1, 'solana', 'USDC', 5000, 6, 'manual-refresh'),
       ($2, 'polygon', 'USDC.e', 12500, 6, 'manual-refresh')`,
      [USER_A, USER_B]
    );

    // Seed User A & B Crypto Payments
    await adminQuery(
      `INSERT INTO crypto_payments (user_id, chain, tx_hash, amount_usdc, tier, plan_id, treasury_address, status) VALUES
       ($1, 'solana', 'tx_hash_user_a_sig_123', 35, 'operator', 'operator_monthly', 'TreasurySolanaAddress', 'confirmed'),
       ($2, 'polygon', 'tx_hash_user_b_sig_456', 150, 'ultra', 'ultra_monthly', '0xTreasuryPolygonAddress', 'confirmed')`,
      [USER_A, USER_B]
    );
  });

  afterAll(async () => {
    await adminQuery("DELETE FROM user_execution_grants WHERE user_id IN ($1, $2)", [USER_A, USER_B]);
    await adminQuery("DELETE FROM user_balances WHERE user_id IN ($1, $2)", [USER_A, USER_B]);
    await adminQuery("DELETE FROM crypto_payments WHERE user_id IN ($1, $2)", [USER_A, USER_B]);
    await adminQuery("DELETE FROM users WHERE id IN ($1, $2)", [USER_A, USER_B]);
  });

  describe('PostgreSQL Catalog Enforcement', () => {
    it('enables and forces RLS on all 17 user-scoped tables', async () => {
      const rows = await query<{ table_name: string; rls_enabled: boolean; rls_forced: boolean }>(
        `SELECT relname AS table_name, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
         FROM pg_class
         JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
         WHERE pg_namespace.nspname = 'public' AND relname = ANY($1)
         ORDER BY relname`,
        [EXPECTED_RLS_TABLES]
      );

      expect(rows).toHaveLength(EXPECTED_RLS_TABLES.length);
      for (const row of rows) {
        expect(row.rls_enabled, `RLS should be enabled on ${row.table_name}`).toBe(true);
        expect(row.rls_forced, `FORCE RLS should be active on ${row.table_name}`).toBe(true);
      }
    });

    it('installs tenant_isolation_policy on all 17 user-scoped tables', async () => {
      const rows = await query<{ tablename: string; policyname: string; cmd: string }>(
        `SELECT tablename, policyname, cmd
         FROM pg_policies
         WHERE schemaname = 'public' AND policyname = 'tenant_isolation_policy' AND tablename = ANY($1)`,
        [EXPECTED_RLS_TABLES]
      );

      expect(rows).toHaveLength(EXPECTED_RLS_TABLES.length);
      for (const row of rows) {
        expect(row.policyname).toBe('tenant_isolation_policy');
        expect(row.cmd).toBe('ALL');
      }
    });
  });

  describe('Table: users Isolation', () => {
    it('scopes SELECT to current tenant and hides other users', async () => {
      const rows = await scopedQuery<{ id: string; email: string }>(
        forUser(USER_A),
        `SELECT id, email FROM users`
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(USER_A);
      expect(rows[0]?.email).toBe('user_a@wake.protocol');

      // Attempting to query user B by explicit ID returns empty result under User A's scope
      const crossRows = await scopedQuery<{ id: string }>(
        forUser(USER_A),
        `SELECT id FROM users WHERE id = $1`,
        [USER_B]
      );
      expect(crossRows).toHaveLength(0);
    });

    it('blocks cross-tenant UPDATE attempts (affects 0 rows)', async () => {
      await scopedQuery(
        forUser(USER_A),
        `UPDATE users SET email = 'hacked@malicious.com' WHERE id = $1`,
        [USER_B]
      );

      // Verify User B email was not modified
      const rows = await adminQuery<{ email: string }>(
        `SELECT email FROM users WHERE id = $1`,
        [USER_B]
      );
      expect(rows[0]?.email).toBe('user_b@wake.protocol');
    });

    it('blocks cross-tenant INSERT with policy violation', async () => {
      await expect(
        scopedQuery(
          forUser(USER_A),
          `INSERT INTO users (id, email, password_hash, role) VALUES ($1, 'spoofed@evil.com', 'h', 'user')`,
          [USER_B]
        )
      ).rejects.toThrow(/insufficient_privilege|row-level security/i);
    });
  });

  describe('Table: user_execution_grants Isolation', () => {
    it('isolates execution grants strictly to the authenticated tenant', async () => {
      const userAGrants = await scopedQuery<{ user_id: string; account_address: string }>(
        forUser(USER_A),
        `SELECT user_id, account_address FROM user_execution_grants`
      );

      expect(userAGrants).toHaveLength(1);
      expect(userAGrants[0]?.user_id).toBe(USER_A);
      expect(userAGrants[0]?.account_address).toBe('AccountA1111111111111111111111111111111111');

      const userBGrants = await scopedQuery<{ user_id: string; account_address: string }>(
        forUser(USER_B),
        `SELECT user_id, account_address FROM user_execution_grants`
      );

      expect(userBGrants).toHaveLength(1);
      expect(userBGrants[0]?.user_id).toBe(USER_B);
      expect(userBGrants[0]?.account_address).toBe('AccountB2222222222222222222222222222222222');
    });
  });

  describe('Table: user_balances Isolation', () => {
    it('isolates cached wallet balances per tenant', async () => {
      const rowsA = await scopedQuery<{ user_id: string; asset: string; amount: number }>(
        forUser(USER_A),
        `SELECT user_id, asset, amount FROM user_balances`
      );

      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]?.user_id).toBe(USER_A);
      expect(rowsA[0]?.asset).toBe('USDC');

      // User A cannot see User B's balance even with a direct WHERE filter
      const rowsBFromA = await scopedQuery(
        forUser(USER_A),
        `SELECT * FROM user_balances WHERE user_id = $1`,
        [USER_B]
      );
      expect(rowsBFromA).toHaveLength(0);
    });
  });

  describe('Table: crypto_payments Isolation', () => {
    it('isolates crypto payment history per tenant', async () => {
      const rowsA = await scopedQuery<{ user_id: string; tx_hash: string }>(
        forUser(USER_A),
        `SELECT user_id, tx_hash FROM crypto_payments`
      );

      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]?.user_id).toBe(USER_A);
      expect(rowsA[0]?.tx_hash).toBe('tx_hash_user_a_sig_123');

      const rowsB = await scopedQuery<{ user_id: string; tx_hash: string }>(
        forUser(USER_B),
        `SELECT user_id, tx_hash FROM crypto_payments`
      );

      expect(rowsB).toHaveLength(1);
      expect(rowsB[0]?.user_id).toBe(USER_B);
      expect(rowsB[0]?.tx_hash).toBe('tx_hash_user_b_sig_456');
    });
  });

  describe('Administrative & Background Engine Bypass', () => {
    it('allows crossTenantScope to query across all tenants for reporting', async () => {
      const allUsers = await scopedQuery<{ id: string }>(
        crossTenantScope('operator_portfolio_reporting'),
        `SELECT id FROM users WHERE id IN ($1, $2) ORDER BY id`,
        [USER_A, USER_B]
      );

      expect(allUsers).toHaveLength(2);
      expect(allUsers.map((u) => u.id)).toEqual([USER_A, USER_B]);
    });
  });

  describe('Least-Privilege Role: swat_app', () => {
    it('forbids swat_app from bypassing RLS even if attempting to set app.bypass_rls', async () => {
      await withTenantTransaction(forUser(USER_A), async (client) => {
        // Switch to the unprivileged app role
        await client.query('SET LOCAL ROLE swat_app');
        // Malicious client tries to spoof bypass
        await client.query("SET LOCAL app.bypass_rls = 'on'");

        // Query users table: should still ONLY see User A
        const result = await client.query<{ id: string }>(
          `SELECT id FROM users WHERE id IN ($1, $2)`,
          [USER_A, USER_B]
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.id).toBe(USER_A);
      });
    });
  });
});
