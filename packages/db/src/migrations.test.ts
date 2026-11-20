import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverMigrationInventory, discoverMigrations } from './migration-discovery.js';

const sqlDir = resolve(import.meta.dirname, '../sql');

describe('migration discovery', () => {
  it('inspects all migration source sequentially without granting execution selection', async () => {
    const migrations = await discoverMigrationInventory(sqlDir);
    expect(migrations.length).toBeGreaterThanOrEqual(69);
    expect(migrations.some((m) => m.file === '066_lp_dashboard.sql')).toBe(true);
    expect(migrations.some((m) => m.file === '067_lp_auto_rebalance.sql')).toBe(true);
    expect(migrations.some((m) => m.file === '068_lp_multichain.sql')).toBe(true);
    expect(migrations.some((m) => m.file === '069_lp_copy_trading.sql')).toBe(true);
    expect(migrations.findIndex((m) => m.file === '065_polymarket_perps.sql'))
      .toBeLessThan(migrations.findIndex((m) => m.file === '066_lp_dashboard.sql'));
  });
  it('refuses executable discovery of the unreviewed proposal suffix', async () => {
    await expect(discoverMigrations(sqlDir)).rejects.toThrow();
  });
});

describe('migration contracts', () => {
  it('leaves transaction ownership to the migration runner', async () => {
    const files = (await readdir(sqlDir)).filter((file) => file.endsWith('.sql'));
    for (const file of files) {
      const sql = await readFile(resolve(sqlDir, file), 'utf8');
      expect(sql, `${file} contains BEGIN`).not.toMatch(/^\s*BEGIN\s*;/im);
      expect(sql, `${file} contains COMMIT`).not.toMatch(/^\s*COMMIT\s*;/im);
      expect(sql, `${file} contains ROLLBACK`).not.toMatch(/^\s*ROLLBACK\s*;/im);
    }
  });

  it('guards UTC conversion by the source column type and never swallows errors', async () => {
    const sql = await readFile(resolve(sqlDir, '016_timestamp_tz.sql'), 'utf8');
    expect(sql).toContain("current_type = 'timestamp without time zone'");
    expect(sql).toContain("current_type != 'timestamp with time zone'");
    expect(sql).not.toContain('EXCEPTION WHEN OTHERS');
    expect(sql).toContain("RAISE EXCEPTION 'Expected timestamp column");
  });

  it('keys attribution by signal, chain, and mode and preserves unknown outcomes', async () => {
    const cleanInstallSql = await readFile(resolve(sqlDir, '019_attribution.sql'), 'utf8');
    const upgradeSql = await readFile(resolve(sqlDir, '029_attribution_semantics.sql'), 'utf8');

    expect(cleanInstallSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_outcomes_identity\s+ON signal_outcomes \(signal_id, chain, execution_mode\)/
    );
    expect(cleanInstallSql).not.toContain('idx_signal_outcomes_signal_id');

    // Existing installations do not replay the edited 019 as an upgrade step:
    // 029 must remove the old identity and install the final one itself.
    expect(upgradeSql).toContain('DROP INDEX IF EXISTS idx_signal_outcomes_signal_id');
    expect(upgradeSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_outcomes_identity\s+ON signal_outcomes \(signal_id, chain, execution_mode\)/
    );
    expect(upgradeSql).toContain('CREATE TABLE IF NOT EXISTS expectancy_reports');
    expect(upgradeSql).toContain('SET realized_pnl_usd = NULL');
    expect(upgradeSql).toContain("t.execution_mode <> 'shadow'");
    expect(upgradeSql).toContain("COUNT(*) FILTER (WHERE t.direction = 'buy') > 0");
    expect(upgradeSql).toContain('BOOL_AND(t.amount_usd IS NOT NULL AND t.token_amount IS NOT NULL)');
    expect(upgradeSql).not.toMatch(/DROP TABLE\s+signal_outcomes/i);
  });

  it('enforces canonical source, signal, execution, and trade linkage', async () => {
    const sql = await readFile(
      resolve(sqlDir, '030_source_signal_execution_linkage.sql'),
      'utf8'
    );
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS unq_signals_source_trade');
    expect(sql).toContain('FOREIGN KEY (signal_id, source_trade_id)');
    expect(sql).toContain('REFERENCES signals (id, source_trade_id)');
    expect(sql).toContain('FOREIGN KEY (copy_execution_id, signal_id, source_trade_id)');
    expect(sql).toContain('REFERENCES copy_executions (id, signal_id, source_trade_id)');
    expect(sql).toContain('chk_trades_copy_execution_identity_complete');
    expect(sql).toMatch(
      /copy_execution_id IS NULL\s+OR \(signal_id IS NOT NULL AND source_trade_id IS NOT NULL\)/
    );
    expect(sql).toContain('source_sell_fraction > 0');
    expect(sql).toContain('source_sell_fraction <= 1');
  });

  it('enforces the LP position state machine twice and caches pools safely', async () => {
    const sql = await readFile(resolve(sqlDir, '066_lp_dashboard.sql'), 'utf8');

    // Every statement replays: tables, indexes, and the trigger all IF NOT EXISTS.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS lp_pools');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS lp_positions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS lp_guardrail_configs');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS lp_tracked_wallets');
    expect(sql).not.toMatch(/CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/);
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_lp_position_state_transition');

    // Fund-touching: the SQL half of the state machine must mirror
    // LP_POSITION_TRANSITIONS in @swat/shared, and every transition journals.
    expect(sql).toContain('enforce_lp_position_state_transition');
    expect(sql).toContain(
      "(OLD.state = 'building' AND NEW.state IN ('active', 'closed'))"
    );
    expect(sql).toContain(
      "(OLD.state = 'active' AND NEW.state IN ('near_edge', 'out_of_range', 'closed'))"
    );
    expect(sql).toContain(
      "(OLD.state = 'near_edge' AND NEW.state IN ('active', 'out_of_range', 'rebalancing', 'closed'))"
    );
    expect(sql).toContain(
      "(OLD.state = 'out_of_range' AND NEW.state IN ('active', 'rebalancing', 'closed'))"
    );
    expect(sql).toContain(
      "(OLD.state = 'rebalancing' AND NEW.state IN ('active', 'near_edge', 'out_of_range', 'closed'))"
    );

    // LP is narrower than the platform: polygon is not an LP chain.
    expect(sql).toContain("CHECK (chain IN ('solana', 'robinhood-chain'))");
    // Unassessed pools never reach the Discover feed's index.
    expect(sql).toContain('WHERE risk_score IS NOT NULL');
    expect(sql).not.toMatch(/DROP TABLE\s+lp_/i);
  });

  it('adds the auto-rebalance opt-in and widens the LP state machine forward', async () => {
    const sql = await readFile(resolve(sqlDir, '067_lp_auto_rebalance.sql'), 'utf8');

    expect(sql).toContain('ADD COLUMN IF NOT EXISTS auto_rebalance BOOLEAN NOT NULL DEFAULT FALSE');
    // The trigger function is replaced (CREATE OR REPLACE), not dropped and
    // recreated: the existing trigger keeps working through the replay.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION enforce_lp_position_state_transition');
    // Track I: the manual trigger may re-center an in-range position; the
    // scheduled monitor never uses this edge.
    expect(sql).toContain(
      "(OLD.state = 'active' AND NEW.state IN ('near_edge', 'out_of_range', 'rebalancing', 'closed'))"
    );
    expect(sql).not.toMatch(/DROP TABLE/i);
  });
});
