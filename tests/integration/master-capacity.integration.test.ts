import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../packages/db/src/client.js';
import {
  MASTER_CAPACITY_WINDOWS,
  assessMasterCapacity,
  fetchMasterCapacityPolicy,
  fetchMasterWindowNotional,
  recordMasterCapacityLedgerEntry,
  usableLiquidityFromPoolTvlUsd
} from '../../packages/db/src/master-capacity.js';

/**
 * Per-master capacity accounting (`S4-M6`, migration `053`).
 *
 * `packages/db/src/master-capacity.test.ts` covers the decision with no
 * database — that is where the arithmetic, the uniform-skip guard and the two
 * messages are tested. What only PostgreSQL can prove is here:
 *
 *  1. The CHECK constraints genuinely make an incoherent ledger row
 *     unrepresentable. The one that matters most is
 *     `chk_master_capacity_ledger_basis`: it is what stops an unpriceable leg
 *     from being recorded as `$0` with a priced basis, which would make real
 *     copy flow read as no flow and turn the cap into a control that passes
 *     everything.
 *  2. `unq_master_capacity_ledger_event` makes the writer idempotent, so a
 *     retried fan-out cannot double-count itself into its own cap.
 *  3. The window aggregate really does exclude rows outside the window, other
 *     tokens and other masters — a leak there would either free capacity that
 *     was consumed or charge a master for someone else's flow.
 *  4. **Neither table has a `user_id` column, now or ever.** That is the
 *     structural half of "capacity binds uniformly on every user" (`S4-M7`) and
 *     of "follower counts are never displayed" (`S4-M9`): a table that cannot
 *     see users cannot prioritise between them, and a cohort-level ledger makes
 *     a headcount undrivable from capacity data.
 *  5. `053` is replay-safe. `migrate.ts` has no applied-migrations table and
 *     re-runs every file on every invocation, so this is a correctness property
 *     of the file, not a nicety.
 *
 * **This file has never been executed.** No database was available when `S4-M6`
 * landed and `053` has not been applied anywhere.
 */

const runId = randomUUID().replace(/-/g, '').slice(0, 12);
const ADDRESS_PREFIX = `solana:SWATcap${runId}`;
const MASTER = `${ADDRESS_PREFIX}A`;
const OTHER_MASTER = `${ADDRESS_PREFIX}B`;
const TOKEN = `solana:SWATtok${runId}A`;
const OTHER_TOKEN = `solana:SWATtok${runId}B`;

const sourceTradeIds: string[] = [];

/** A source trade to hang a ledger row off. The FK is RESTRICT, so it is real. */
async function makeSourceTrade(walletAddress = MASTER, tokenMint = TOKEN): Promise<string> {
  const eventId = `s4m6-${randomUUID()}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO source_trades (
       chain, transaction_hash, wallet_address, token_mint, direction,
       amount_usd, token_amount, source_event_type, source_event_id, event_at
     ) VALUES ('solana', $1, $2, $3, 'buy', 1000, 1000, 'transaction', $1, NOW())
     RETURNING id`,
    [eventId, walletAddress, tokenMint]
  );
  const id = result.rows[0]!.id;
  sourceTradeIds.push(id);
  return id;
}

async function ledgerRowCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM master_capacity_ledger
      WHERE master_wallet_address = ANY($1)`,
    [[MASTER, OTHER_MASTER]]
  );
  return Number(result.rows[0]!.count);
}

afterAll(async () => {
  await pool.query(`DELETE FROM master_capacity_ledger WHERE master_wallet_address = ANY($1)`, [
    [MASTER, OTHER_MASTER]
  ]);
  await pool.query(
    `DELETE FROM master_capacity_policy WHERE master_wallet_address LIKE $1 || '%'`,
    [ADDRESS_PREFIX]
  );
  if (sourceTradeIds.length > 0) {
    await pool.query(`DELETE FROM source_trades WHERE id = ANY($1)`, [sourceTradeIds]);
  }
});

describe('master_capacity_ledger constraints', () => {
  it('rejects a bare address in the chain-prefixed column', async () => {
    const sourceTradeId = await makeSourceTrade();
    await expect(
      pool.query(
        `INSERT INTO master_capacity_ledger (
           master_wallet_address, chain, token_mint, source_trade_id,
           execution_mode, notional_usd, notional_basis
         ) VALUES ('BareAddressNoPrefix', 'solana', $1, $2, 'live', 100, 'quote-stablecoin')`,
        [TOKEN, sourceTradeId]
      )
    ).rejects.toThrow(/chk_master_capacity_ledger_prefix/);
  });

  it('refuses to record an unpriced leg as a zero-dollar priced leg', async () => {
    // The whole point of the basis CHECK. A leg that could not be priced,
    // written as 0 with a priced basis, would make real flow read as no flow.
    const sourceTradeId = await makeSourceTrade();
    await expect(
      pool.query(
        `INSERT INTO master_capacity_ledger (
           master_wallet_address, chain, token_mint, source_trade_id,
           execution_mode, notional_usd, notional_basis
         ) VALUES ($1, 'solana', $2, $3, 'live', 0, 'unpriced')`,
        [MASTER, TOKEN, sourceTradeId]
      )
    ).rejects.toThrow(/chk_master_capacity_ledger_basis/);
  });

  it('refuses a NULL notional under a priced basis', async () => {
    const sourceTradeId = await makeSourceTrade();
    await expect(
      pool.query(
        `INSERT INTO master_capacity_ledger (
           master_wallet_address, chain, token_mint, source_trade_id,
           execution_mode, notional_usd, notional_basis
         ) VALUES ($1, 'solana', $2, $3, 'live', NULL, 'quote-stablecoin')`,
        [MASTER, TOKEN, sourceTradeId]
      )
    ).rejects.toThrow(/chk_master_capacity_ledger_basis/);
  });

  it('refuses a negative notional and an unknown basis', async () => {
    const negativeId = await makeSourceTrade();
    await expect(
      pool.query(
        `INSERT INTO master_capacity_ledger (
           master_wallet_address, chain, token_mint, source_trade_id,
           execution_mode, notional_usd, notional_basis
         ) VALUES ($1, 'solana', $2, $3, 'live', -1, 'quote-stablecoin')`,
        [MASTER, TOKEN, negativeId]
      )
    ).rejects.toThrow(/chk_master_capacity_ledger_basis/);

    const basisId = await makeSourceTrade();
    await expect(
      pool.query(
        `INSERT INTO master_capacity_ledger (
           master_wallet_address, chain, token_mint, source_trade_id,
           execution_mode, notional_usd, notional_basis
         ) VALUES ($1, 'solana', $2, $3, 'live', 10, 'vibes')`,
        [MASTER, TOKEN, basisId]
      )
    ).rejects.toThrow(/chk_master_capacity_ledger_basis/);
  });

  it('accepts an unpriced leg with a NULL notional', async () => {
    const sourceTradeId = await makeSourceTrade();
    await recordMasterCapacityLedgerEntry({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      sourceTradeId,
      executionMode: 'live',
      notionalUsd: null,
      notionalBasis: 'unpriced',
      committedAt: new Date()
    });
    const observation = await fetchMasterWindowNotional({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      windowStartsAt: new Date(Date.now() - 60_000),
      windowEndsAt: new Date(Date.now() + 60_000),
      executionModes: ['live']
    });
    expect(observation.coverage).toBe('partial-unpriced-legs');
    expect(observation.unpricedLegCount).toBeGreaterThanOrEqual(1);
  });

  it('rejects an unknown chain and an unknown execution mode', async () => {
    const chainId = await makeSourceTrade();
    await expect(
      pool.query(
        `INSERT INTO master_capacity_ledger (
           master_wallet_address, chain, token_mint, source_trade_id,
           execution_mode, notional_usd, notional_basis
         ) VALUES ('ethereum:0xmaster', 'ethereum', $1, $2, 'live', 10, 'quote-stablecoin')`,
        [TOKEN, chainId]
      )
    ).rejects.toThrow(/chk_master_capacity_ledger_chain/);

    const modeId = await makeSourceTrade();
    await expect(
      pool.query(
        `INSERT INTO master_capacity_ledger (
           master_wallet_address, chain, token_mint, source_trade_id,
           execution_mode, notional_usd, notional_basis
         ) VALUES ($1, 'solana', $2, $3, 'dry-run', 10, 'quote-stablecoin')`,
        [MASTER, TOKEN, modeId]
      )
    ).rejects.toThrow(/chk_master_capacity_ledger_mode/);
  });
});

describe('the writer is idempotent per fan-out event', () => {
  it('does not let a retried fan-out double-count itself into its own cap', async () => {
    const sourceTradeId = await makeSourceTrade();
    const before = await ledgerRowCount();
    const entry = {
      masterWalletAddress: MASTER,
      chain: 'solana' as const,
      tokenMint: TOKEN,
      sourceTradeId,
      executionMode: 'live' as const,
      notionalUsd: 2_500,
      notionalBasis: 'quote-stablecoin' as const,
      committedAt: new Date()
    };
    await recordMasterCapacityLedgerEntry(entry);
    await recordMasterCapacityLedgerEntry(entry);
    await recordMasterCapacityLedgerEntry({ ...entry, notionalUsd: 999_999 });
    expect(await ledgerRowCount()).toBe(before + 1);

    const stored = await pool.query<{ notional_usd: string }>(
      `SELECT notional_usd FROM master_capacity_ledger
        WHERE source_trade_id = $1 AND execution_mode = 'live'`,
      [sourceTradeId]
    );
    // DO NOTHING, not DO UPDATE: the first record of a committed cohort stands.
    expect(Number(stored.rows[0]!.notional_usd)).toBe(2_500);
  });

  it('keeps paper and live flow as separate rows for the same source trade', async () => {
    const sourceTradeId = await makeSourceTrade();
    for (const executionMode of ['paper', 'live', 'shadow'] as const) {
      await recordMasterCapacityLedgerEntry({
        masterWalletAddress: MASTER,
        chain: 'solana',
        tokenMint: TOKEN,
        sourceTradeId,
        executionMode,
        notionalUsd: 100,
        notionalBasis: 'quote-stablecoin',
        committedAt: new Date()
      });
    }
    const rows = await pool.query(
      `SELECT 1 FROM master_capacity_ledger WHERE source_trade_id = $1`,
      [sourceTradeId]
    );
    expect(rows.rowCount).toBe(3);
  });
});

describe('the window aggregate', () => {
  it('sums only this master, this token and this window', async () => {
    await pool.query(
      'DELETE FROM master_capacity_ledger WHERE master_wallet_address = ANY($1)',
      [[MASTER, OTHER_MASTER]]
    );
    const now = Date.now();
    const inWindow = new Date(now - 60_000);
    const outOfWindow = new Date(now - 6 * 60 * 60 * 1000);

    const cases: Array<[string, string, Date, number]> = [
      [MASTER, TOKEN, inWindow, 1_000],
      [MASTER, TOKEN, inWindow, 500],
      [MASTER, TOKEN, outOfWindow, 90_000],
      [MASTER, OTHER_TOKEN, inWindow, 70_000],
      [OTHER_MASTER, TOKEN, inWindow, 80_000]
    ];
    for (const [master, token, committedAt, notionalUsd] of cases) {
      await recordMasterCapacityLedgerEntry({
        masterWalletAddress: master,
        chain: 'solana',
        tokenMint: token,
        sourceTradeId: await makeSourceTrade(master, token),
        executionMode: 'live',
        notionalUsd,
        notionalBasis: 'quote-stablecoin',
        committedAt
      });
    }

    const observation = await fetchMasterWindowNotional({
      masterWalletAddress: MASTER,
      chain: 'solana',
      tokenMint: TOKEN,
      windowStartsAt: new Date(now - MASTER_CAPACITY_WINDOWS.selfImpactDecayMs),
      windowEndsAt: new Date(now + 1_000),
      executionModes: ['live']
    });
    expect(observation.committedNotionalUsd).toBe(1_500);
    expect(observation.coverage).toBe('accounted');
  });

  it('feeds a decision that skips the cohort once the window is full', async () => {
    const now = Date.now();
    await recordMasterCapacityLedgerEntry({
      masterWalletAddress: OTHER_MASTER,
      chain: 'solana',
      tokenMint: OTHER_TOKEN,
      sourceTradeId: await makeSourceTrade(OTHER_MASTER, OTHER_TOKEN),
      executionMode: 'live',
      notionalUsd: 4_900,
      notionalBasis: 'quote-stablecoin',
      committedAt: new Date(now - 30_000)
    });

    const observation = await fetchMasterWindowNotional({
      masterWalletAddress: OTHER_MASTER,
      chain: 'solana',
      tokenMint: OTHER_TOKEN,
      windowStartsAt: new Date(now - MASTER_CAPACITY_WINDOWS.fanoutDrainMs),
      windowEndsAt: new Date(now + 1_000),
      executionModes: ['live']
    });

    // $200k TVL -> $100k usable -> 500 bps ceiling on solana -> $5,000 of room.
    const decision = assessMasterCapacity({
      masterWalletAddress: OTHER_MASTER,
      chain: 'solana',
      tokenMint: OTHER_TOKEN,
      windowMs: MASTER_CAPACITY_WINDOWS.fanoutDrainMs,
      windowEndsAt: new Date(now),
      observation: { ...observation, projectedNotionalUsd: 200 },
      liquidity: usableLiquidityFromPoolTvlUsd('solana', OTHER_TOKEN, 200_000),
      activeFollowerCount: 12,
      policy: { unassessablePolicy: 'skip' }
    });
    expect(decision.outcome).toBe('skip');
    expect(decision.reasonCode).toBe('capacity-price-impact-cap-reached');
    expect(decision.user.message).toMatch(/at capacity/i);
  });
});

describe('master_capacity_policy', () => {
  it('round-trips an override and reports platform defaults for an absent row', async () => {
    const absent = await fetchMasterCapacityPolicy({
      masterWalletAddress: MASTER,
      chain: 'solana'
    });
    expect(absent.policy.maxAggregateImpactBps).toBeUndefined();
    expect(absent.dailyBudgetShareBps).toBeNull();

    await pool.query(
      `INSERT INTO master_capacity_policy (
         master_wallet_address, chain, max_aggregate_impact_bps,
         follower_soft_cap, daily_budget_share_bps, note
       ) VALUES ($1, 'solana', 120, 25, 1500, 'S4-M6 integration test')`,
      [MASTER]
    );
    const present = await fetchMasterCapacityPolicy({
      masterWalletAddress: MASTER,
      chain: 'solana'
    });
    expect(present.policy).toEqual({ maxAggregateImpactBps: 120, followerSoftCap: 25 });
    expect(present.dailyBudgetShareBps).toBe(1_500);
  });

  it('rejects out-of-range overrides at the database, not only in TypeScript', async () => {
    const cases: Array<[column: string, value: number]> = [
      ['max_aggregate_impact_bps', 0],
      ['max_aggregate_impact_bps', 10_001],
      ['follower_soft_cap', 0],
      ['daily_budget_share_bps', 10_001],
      ['daily_budget_share_bps', -1]
    ];
    for (const [index, [column, value]] of cases.entries()) {
      // A distinct address per case: the PK would otherwise mask a CHECK that
      // failed to fire as a duplicate-key error.
      await expect(
        pool.query(
          `INSERT INTO master_capacity_policy (master_wallet_address, chain, ${column})
           VALUES ($1, 'solana', $2)`,
          [`${OTHER_MASTER}r${index}`, value]
        )
      ).rejects.toThrow(/chk_master_capacity_policy_ranges/);
    }
  });

  it('rejects a bare address in the policy table too', async () => {
    await expect(
      pool.query(
        `INSERT INTO master_capacity_policy (master_wallet_address, chain)
         VALUES ('BareAddressNoPrefix', 'solana')`
      )
    ).rejects.toThrow(/chk_master_capacity_policy_prefix/);
  });
});

describe('structural guarantees only the schema can give', () => {
  it('has no user_id column on either capacity table, and must never gain one', async () => {
    // The structural half of S4-M7 (uniform skip) and S4-M9 (no follower
    // counts). A per-user capacity row would make both violable by a JOIN.
    const result = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('master_capacity_ledger', 'master_capacity_policy')
          AND (column_name LIKE '%user%'
            OR column_name LIKE '%tier%'
            OR column_name LIKE '%account%'
            OR column_name LIKE '%follower_count%')`
    );
    expect(result.rows).toEqual([]);
  });

  it('replays cleanly, because migrate.ts re-runs every file on every invocation', async () => {
    const sql = await readFile(
      new URL('../../packages/db/sql/053_master_capacity.sql', import.meta.url),
      'utf8'
    );
    await pool.query(sql);
    await pool.query(sql);
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('master_capacity_ledger', 'master_capacity_policy')`
    );
    expect(tables.rowCount).toBe(2);
  });
});
