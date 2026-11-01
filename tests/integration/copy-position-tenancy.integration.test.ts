import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import { Keypair } from '@swat/shared';
import { pool } from '../../packages/db/src/client.js';
import { createUser } from '../../packages/db/src/users.js';
import {
  recordSourceTradeEvent,
  requestCopyExecution,
  recordCopyExecutionEvidence
} from '../../packages/db/src/copy-trade-lifecycle.js';

/**
 * Tenancy key on `copy_positions` (checklist S4-10, migration 050).
 *
 * **The bug this locks down.** `copy_positions` used to be keyed
 * `PRIMARY KEY (target_account, chain, token_mint)`. In live mode each user
 * trades from a distinct address, so that key separated users by accident. In
 * paper mode `resolvePaperCopyTargetAccount(chain)` returns ONE synthetic
 * address per chain with no user dimension, so every paper user on a chain
 * collapsed onto a single row: user A's buy inflated user B's
 * `confirmed_quantity`, and B's exit computed P&L against A's cost basis. Paper
 * is the default mode for every free-tier user, so this was the common path.
 *
 * **These assertions fail against the old key**, which is the point of writing
 * them — the first test's second INSERT raises `23505 unique_violation` under a
 * three-column primary key, and the migration is what makes it pass.
 *
 * **Why this suite is at the schema level.** The property under test is a
 * property of the DDL, not of any one query helper, and it has to hold for every
 * writer including ones not yet written. Testing it here means a future migration
 * that drops `NULLS NOT DISTINCT` or narrows the index fails immediately rather
 * than at whichever call site happens to notice first.
 *
 * **Still owed:** an end-to-end assertion driving two paper users through
 * `requestCopyExecution` / `recordCopyExecutionEvidence` and comparing the
 * resulting ledgers. That needs tenancy threaded through
 * `tests/integration/helpers/lifecycle-fixture.ts`, which does not carry a user
 * dimension yet. The schema guarantees below are necessary for that test to pass
 * but are not a substitute for it.
 */

const runId = randomUUID().replace(/-/g, '').slice(0, 12);
const userIds: string[] = [];
const targetAccounts: string[] = [];

/** The shared synthetic address paper mode settles from — deliberately not per-user. */
function paperTarget(suffix: string): string {
  const account = `solana:${Keypair.generate().publicKey.toBase58()}`;
  targetAccounts.push(account);
  return account;
}

async function makeUser() {
  const user = await createUser({
    email: `s4-10-${randomUUID()}@example.com`,
    password: 'a-very-long-password',
    tier: 'free'
  });
  userIds.push(user.id);
  return user;
}

afterAll(async () => {
  // Order matters: `copy_positions.user_id` is ON DELETE RESTRICT, so positions
  // must go before the users they belong to. That ordering is itself asserted
  // below — deleting a user out from under financial history must not be
  // possible.
  if (targetAccounts.length > 0) {
    await pool.query('DELETE FROM copy_position_master_lot_reductions WHERE lot_id IN (SELECT id FROM copy_position_master_lots WHERE position_id IN (SELECT id FROM copy_positions WHERE target_account = ANY($1)))', [targetAccounts]);
    await pool.query('DELETE FROM copy_position_master_lots WHERE position_id IN (SELECT id FROM copy_positions WHERE target_account = ANY($1))', [targetAccounts]);
    await pool.query('DELETE FROM copy_position_applications WHERE execution_id IN (SELECT id FROM copy_executions WHERE target_account = ANY($1))', [targetAccounts]);
    await pool.query('DELETE FROM copy_execution_evidence WHERE execution_id IN (SELECT id FROM copy_executions WHERE target_account = ANY($1))', [targetAccounts]);
    await pool.query('DELETE FROM copy_execution_state_history WHERE execution_id IN (SELECT id FROM copy_executions WHERE target_account = ANY($1))', [targetAccounts]);
    await pool.query('DELETE FROM copy_executions WHERE target_account = ANY($1)', [targetAccounts]);
    await pool.query('DELETE FROM copy_positions WHERE target_account = ANY($1)', [targetAccounts]);
  }
  await pool.query("DELETE FROM source_position_applications WHERE source_trade_id IN (SELECT id FROM source_trades WHERE source_event_id LIKE 'tx:' || $1 || ':%')", [runId]);
  await pool.query("DELETE FROM source_trade_confirmation_history WHERE source_trade_id IN (SELECT id FROM source_trades WHERE source_event_id LIKE 'tx:' || $1 || ':%')", [runId]);
  await pool.query("DELETE FROM source_trades WHERE source_event_id LIKE 'tx:' || $1 || ':%'", [runId]);
  if (userIds.length > 0) {
    await pool.query('DELETE FROM audit_log WHERE actor_id = ANY($1)', [userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
  }
  // Deliberately no `pool.end()`. The pool is shared across integration files
  // (globalSetup closes its own separate one for exactly this reason), so
  // closing it here would break whichever file vitest runs next.
});

describe('copy_positions tenancy (S4-10)', () => {
  it('gives two paper users independent positions behind one shared target account', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const target = paperTarget('A');
    const token = `TOKEN${runId}`;

    await pool.query(
      `INSERT INTO copy_positions (target_account, chain, token_mint, user_id) VALUES ($1,'solana',$2,$3)`,
      [target, token, alice.id]
    );
    // Against the old three-column primary key this raises 23505. It is the
    // whole regression: same target, same chain, same token, different tenant.
    await pool.query(
      `INSERT INTO copy_positions (target_account, chain, token_mint, user_id) VALUES ($1,'solana',$2,$3)`,
      [target, token, bob.id]
    );

    const { rows } = await pool.query<{ user_id: string; id: string }>(
      `SELECT id, user_id FROM copy_positions
        WHERE target_account = $1 AND chain = 'solana' AND token_mint = $2
        ORDER BY user_id`,
      [target, token]
    );

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([alice.id, bob.id]));
  });

  it('keeps quantities and cost bases from bleeding between tenants', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const target = paperTarget('B');
    const token = `TOKEN${runId}`;

    for (const userId of [alice.id, bob.id]) {
      await pool.query(
        `INSERT INTO copy_positions (target_account, chain, token_mint, user_id) VALUES ($1,'solana',$2,$3)`,
        [target, token, userId]
      );
    }

    // Alice buys. Under the old key this write landed on the row Bob also read.
    await pool.query(
      `UPDATE copy_positions
          SET confirmed_quantity = 500, cost_basis_usd = 1000
        WHERE target_account = $1 AND chain = 'solana' AND token_mint = $2 AND user_id = $3`,
      [target, token, alice.id]
    );

    const read = async (userId: string) => {
      const { rows } = await pool.query<{ confirmed_quantity: number; cost_basis_usd: number }>(
        `SELECT confirmed_quantity, cost_basis_usd FROM copy_positions
          WHERE target_account = $1 AND chain = 'solana' AND token_mint = $2 AND user_id = $3`,
        [target, token, userId]
      );
      return rows[0]!;
    };

    expect(await read(alice.id)).toMatchObject({ confirmed_quantity: 500, cost_basis_usd: 1000 });
    // Bob's exit would otherwise compute P&L against Alice's basis.
    expect(await read(bob.id)).toMatchObject({ confirmed_quantity: 0, cost_basis_usd: 0 });
  });

  it('still collapses legacy operator rows, because NULLS NOT DISTINCT is load-bearing', async () => {
    const target = paperTarget('C');
    const token = `TOKEN${runId}`;

    await pool.query(
      `INSERT INTO copy_positions (target_account, chain, token_mint, user_id) VALUES ($1,'solana',$2,NULL)`,
      [target, token]
    );

    // Under PostgreSQL's default NULLS DISTINCT, two NULL-tenant rows would NOT
    // collide — so migration 050 would have *removed* the uniqueness that
    // existed before it while appearing to add a dimension, and every
    // `ensureCopyPosition` call for the operator would insert a fresh duplicate
    // until the ledger fragmented silently. This assertion is what stops a
    // future migration quietly dropping that clause.
    await expect(
      pool.query(
        `INSERT INTO copy_positions (target_account, chain, token_mint, user_id) VALUES ($1,'solana',$2,NULL)`,
        [target, token]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses to delete a user who still owns financial history', async () => {
    const user = await makeUser();
    const target = paperTarget('D');

    await pool.query(
      `INSERT INTO copy_positions (target_account, chain, token_mint, user_id) VALUES ($1,'solana',$2,$3)`,
      [target, `TOKEN${runId}`, user.id]
    );

    // ON DELETE RESTRICT, not CASCADE. `copy_positions` is the ledger `trades`
    // is derived from; a DELETE FROM users must not destroy the evidence chain
    // behind a retained trade. Users with financial rows are soft-deleted.
    await expect(
      pool.query('DELETE FROM users WHERE id = $1', [user.id])
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('is keyed on a single surrogate column, so the migration can replay', async () => {
    // Migration 050 guards its constraint drops on `cardinality(conkey)` rather
    // than on name, because the replacement primary key reuses the name
    // `copy_positions_pkey`. If the key were ever three columns again, that
    // guard would drop the live key on the next `pnpm db:migrate` — and
    // migrate.ts replays every file on every invocation.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT cardinality(conkey)::int AS n
         FROM pg_constraint
        WHERE conrelid = 'copy_positions'::regclass AND contype = 'p'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.n).toBe(1);
  });

  it('drives two paper users through execution and evidence with completely disjoint ledgers', async () => {
    const [alice, bob] = [await makeUser(), await makeUser()];
    const target = paperTarget('E');
    const master = `solana:${Keypair.generate().publicKey.toBase58()}`;
    const token = `solana:${Keypair.generate().publicKey.toBase58()}`;
    const occurredAt = new Date('2026-10-01T00:00:00Z');

    const sourceEventId = `tx:${runId}:1`;
    const source = await recordSourceTradeEvent({
      chain: 'solana',
      sourceEventType: 'transaction',
      sourceEventId,
      transactionHash: sourceEventId,
      walletAddress: master,
      tokenMint: token,
      side: 'buy',
      quantity: '100',
      amountUsd: 1000,
      eventAt: occurredAt,
      confirmationState: 'confirmed',
      confirmationEvidenceId: randomUUID()
    });

    const aliceExec = await requestCopyExecution({
      sourceTradeId: source.event.id,
      targetAccount: target,
      executionMode: 'paper',
      userId: alice.id,
      requestedBaseQuantity: '10'
    });

    const bobExec = await requestCopyExecution({
      sourceTradeId: source.event.id,
      targetAccount: target,
      executionMode: 'paper',
      userId: bob.id,
      requestedBaseQuantity: '20'
    });

    expect(aliceExec.execution.id).not.toBe(bobExec.execution.id);
    expect(aliceExec.execution.userId).toBe(alice.id);
    expect(bobExec.execution.userId).toBe(bob.id);

    await recordCopyExecutionEvidence({
      executionId: aliceExec.execution.id,
      evidenceType: 'paper_simulation',
      evidenceId: aliceExec.execution.clientOrderId,
      baseQuantity: '10',
      quoteLeg: { currency: 'USD', amount: 100 },
      confirmationState: 'confirmed',
      completesExecution: true,
      occurredAt
    });

    await recordCopyExecutionEvidence({
      executionId: bobExec.execution.id,
      evidenceType: 'paper_simulation',
      evidenceId: bobExec.execution.clientOrderId,
      baseQuantity: '20',
      quoteLeg: { currency: 'USD', amount: 200 },
      confirmationState: 'confirmed',
      completesExecution: true,
      occurredAt
    });

    const { rows: positions } = await pool.query<{
      user_id: string;
      confirmed_quantity: string;
      cost_basis_usd: string;
    }>(
      `SELECT user_id, confirmed_quantity::text, cost_basis_usd::text
         FROM copy_positions
        WHERE target_account = $1 AND token_mint = $2
        ORDER BY user_id`,
      [target, token]
    );

    expect(positions).toHaveLength(2);
    expect(positions.find(p => p.user_id === alice.id)).toMatchObject({
      confirmed_quantity: '10',
      cost_basis_usd: '100'
    });
    expect(positions.find(p => p.user_id === bob.id)).toMatchObject({
      confirmed_quantity: '20',
      cost_basis_usd: '200'
    });

    const { rows: lots } = await pool.query<{
      user_id: string;
      remaining_quantity: string;
    }>(
      `SELECT user_id, remaining_quantity::text
         FROM copy_position_master_lots
        WHERE token_mint = $1
        ORDER BY user_id`,
      [token]
    );

    expect(lots).toHaveLength(2);
    expect(lots.find(l => l.user_id === alice.id)?.remaining_quantity).toBe('10');
    expect(lots.find(l => l.user_id === bob.id)?.remaining_quantity).toBe('20');
  });
});
