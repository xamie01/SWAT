import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverMigrations, migrationProfileFromEnv } from './migration-discovery.js';

const sqlDir = resolve(import.meta.dirname, '../sql');
const lpSqlDir = resolve(import.meta.dirname, '../sql-lp');

describe('migration profiles', () => {
  it('defaults to core and rejects unknown profiles', () => {
    expect(migrationProfileFromEnv(undefined)).toBe('core');
    expect(migrationProfileFromEnv('')).toBe('core');
    expect(migrationProfileFromEnv('lp')).toBe('lp');
    expect(() => migrationProfileFromEnv('all')).toThrow(/core.*lp/);
  });

  it('keeps LP SQL out of core discovery and includes it only for lp', async () => {
    const core = await discoverMigrations(sqlDir, lpSqlDir, 'core');
    const lp = await discoverMigrations(sqlDir, lpSqlDir, 'lp');
    expect(core.every((migration) => migration.profile === 'core')).toBe(true);
    expect(core.some((migration) => migration.file.includes('lp_'))).toBe(false);
    expect(lp.some((migration) => migration.profile === 'lp' && migration.file === '059_lp_dashboard.sql')).toBe(true);
    expect(lp.some((migration) => migration.profile === 'lp' && migration.file === '060_lp_auto_rebalance.sql')).toBe(true);
    expect(lp.findIndex((migration) => migration.file === '058_copy_position_lots.sql'))
      .toBeLessThan(lp.findIndex((migration) => migration.file === '059_lp_dashboard.sql'));
  });
});

describe('migration contracts', () => {
  it('leaves transaction ownership to the migration runner', async () => {
    const files = (await readdir(sqlDir)).filter((file) => file.endsWith('.sql'));
    const lpFiles = (await readdir(lpSqlDir)).filter((file) => file.endsWith('.sql'));
    for (const file of [...files, ...lpFiles]) {
      const root = lpFiles.includes(file) ? lpSqlDir : sqlDir;
      const sql = await readFile(resolve(root, file), 'utf8');
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
});
