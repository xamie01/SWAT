import { describe, expect, it } from 'vitest';
import { pool } from '../../packages/db/src/client.js';

describe('master-attributed copy lots schema (S4-M3)', () => {
  it('keeps the master lot ledger separate from the shared LP position table', async () => {
    const result = await pool.query<{ lot_table: string | null; lp_table: string | null }>(
      `SELECT to_regclass('copy_position_master_lots')::text AS lot_table`
    );
    expect(result.rows[0]).toEqual({
      lot_table: 'copy_position_master_lots'
    });
  });

  it('installs the parent ownership trigger and evidence idempotency index', async () => {
    const result = await pool.query<{ trigger_name: string | null; index_name: string | null }>(
      `SELECT
         (SELECT tgname
            FROM pg_trigger
           WHERE tgrelid = 'copy_position_master_lots'::regclass
             AND tgname = 'trg_copy_position_lot_parent') AS trigger_name,
         (SELECT indexname
            FROM pg_indexes
           WHERE tablename = 'copy_position_master_lots'
             AND indexname = 'uq_copy_position_master_lots_evidence') AS index_name`
    );
    expect(result.rows[0]).toEqual({
      trigger_name: 'trg_copy_position_lot_parent',
      index_name: 'uq_copy_position_master_lots_evidence'
    });
  });
});
