import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
vi.mock('./client.js', () => ({ query: vi.fn() }));
import { insertTradeWithClient } from './trades.js';
const input = { signalId: 'signal', sourceTradeId: null, copyExecutionId: 'execution', exitLotId: 'lot', userId: null,
  tokenMint: 'solana:token', chain: 'solana' as const, direction: 'sell' as const, executionMode: 'paper', tokenAmount: '0.000000000000000001' };
describe('real trade SQL contract for migration061 canonical exits', () => {
  it('binds exit_lot_id and exact quantity, satisfying source XOR lot origin contract', async () => {
    const query = vi.fn(async (sql: string, values: unknown[]) => {
      const match = /INSERT INTO trades\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/.exec(sql)!;
      const columns = match[1]!.split(',').map(value => value.trim());
      const placeholders = match[2]!.split(',').map(value => Number(value.trim().slice(1)) - 1);
      const row = Object.fromEntries(columns.map((column,index) => [column,values[placeholders[index]!] ]));
      // Contract fixture enforcing actual 061 CHECK, not PostgreSQL acceptance.
      if (row.copy_execution_id && (!row.signal_id || (!!row.source_trade_id === !!row.exit_lot_id))) throw new Error('061 canonical origin constraint');
      expect(row.exit_lot_id).toBe('lot'); expect(row.token_amount).toBe(input.tokenAmount);
      expect(sql).toContain('trades.exit_lot_id IS NOT DISTINCT FROM EXCLUDED.exit_lot_id');
      expect(sql).toContain('trades.user_id IS NOT DISTINCT FROM EXCLUDED.user_id');
      return { rows: [{ id: 'trade' }] };
    });
    expect(await insertTradeWithClient({ query } as unknown as PoolClient, input)).toEqual({ id: 'trade' });
  });
  it('fee-only evidence mutation is forbidden and policy capture app grant unavailable in forward schema', () => {
    const sql = readFileSync(new URL('../sql/074_canonical_worker_foundation.sql', import.meta.url), 'utf8');
    expect(sql).toContain("to_jsonb(NEW) - ARRAY['confirmation_state','confirmation_updated_at']");
    expect(sql).toContain('approved policy capture writer unavailable');
    expect(sql).not.toContain('GRANT SELECT,INSERT ON public.copy_execution_policy_snapshots');
  });
});
