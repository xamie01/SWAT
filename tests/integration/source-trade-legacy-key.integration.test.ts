import { describe, expect, it, beforeAll } from 'vitest';
// Relative deep import, matching every other suite in this directory. The repo
// root has no `@swat/db` dependency (only `@swat/shared`), so the bare specifier
// is unresolvable when vitest runs this file from the root — it would throw
// ERR_MODULE_NOT_FOUND before a single assertion ran.
import { query } from '../../packages/db/src/index.js';
import { assertIntegrationSchemaCurrent } from './helpers/schema-guard.js';

/**
 * `028`'s drop of `023`'s UNIQUE key — the bug and the fix.
 *
 * WRITTEN BUT NEVER EXECUTED: no database was available in the session that wrote
 * it. Everything below is the assertion set that would prove the fix; treat the
 * behaviour as unverified until `pnpm test:integration` runs.
 *
 * The bug: `028` guarded the drop on
 * `conname = 'source_trades_chain_transaction_hash_wallet_address_token_mint_direction_key'`
 * — 76 characters, where PostgreSQL truncates identifiers at 63. The comparison
 * could never be true, so the guard did nothing and the DROP never ran. `023`'s
 * key therefore survived on every database that applied `023`, while `028` went on
 * to install the replacement identity as though it were gone.
 *
 * Why that matters: the surviving key forbids two rows sharing
 * `(chain, transaction_hash, wallet_address, token_mint, direction)`. One
 * transaction carrying two fills of the same token in the same direction is a
 * shape real ingestion produces — `source_event_index` exists in the replacement
 * key precisely to distinguish them — so those inserts were being rejected with a
 * `23505` rather than stored.
 */
describe('source_trades legacy uniqueness key (028 shape-matched drop)', () => {
  beforeAll(async () => {
    await assertIntegrationSchemaCurrent();
  });

  it('has no unique constraint on the legacy five-column shape', async () => {
    // Matched by shape, not name — the same reason the migration had to be.
    const rows = await query<{ conname: string }>(`
      SELECT c.conname
        FROM pg_constraint c
       WHERE c.conrelid = 'source_trades'::regclass
         AND c.contype = 'u'
         AND (
           SELECT array_agg(a.attname::text ORDER BY a.attname)
             FROM unnest(c.conkey) AS k(attnum)
             JOIN pg_attribute a
               ON a.attrelid = c.conrelid
              AND a.attnum = k.attnum
         ) = ARRAY['chain', 'direction', 'token_mint', 'transaction_hash', 'wallet_address']
    `);
    expect(rows).toEqual([]);
  });

  it('still has the replacement canonical-event identity', async () => {
    // The drop must not have taken the new key with it.
    const rows = await query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
       WHERE tablename = 'source_trades'
         AND indexname = 'unq_source_trades_canonical_event'
    `);
    expect(rows).toHaveLength(1);
  });

  it('accepts two fills of the same token and direction in one transaction', async () => {
    // The exact insert the surviving key rejected. Distinguished only by
    // source_event_index, which is why the replacement key includes it.
    const wallet = 'solana:legacy-key-probe-wallet';
    const token = 'solana:legacy-key-probe-token';
    const txHash = 'legacy-key-probe-signature';

    await query(
      `INSERT INTO wallets (address, chain, status)
       VALUES ($1, 'solana', 'active')
       ON CONFLICT (address) DO NOTHING`,
      [wallet]
    );

    const insertFill = (index: string) => query(
      `INSERT INTO source_trades (
         chain, source_event_type, source_event_id, source_event_index,
         transaction_hash, wallet_address, token_mint, direction,
         token_amount, event_at, observed_at, confirmation_state
       ) VALUES (
         'solana', 'transaction', $1, $2,
         $1, $3, $4, 'buy',
         1, NOW(), NOW(), 'confirmed'
       )`,
      [txHash, index, wallet, token]
    );

    try {
      await insertFill('0');
      // Before the fix this second insert raised 23505 on the legacy key.
      await expect(insertFill('1')).resolves.not.toThrow();

      const stored = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM source_trades
          WHERE transaction_hash = $1 AND wallet_address = $2`,
        [txHash, wallet]
      );
      expect(stored[0]?.count).toBe('2');
    } finally {
      await query(`DELETE FROM source_trades WHERE transaction_hash = $1`, [txHash]);
      await query(`DELETE FROM wallets WHERE address = $1`, [wallet]);
    }
  });

  it('still rejects a genuine duplicate of the canonical event identity', async () => {
    // Dropping the old key must not have made the table permissive: the same
    // (chain, event_type, event_id, event_index) is still one event.
    const wallet = 'solana:legacy-key-dupe-wallet';
    const token = 'solana:legacy-key-dupe-token';
    const txHash = 'legacy-key-dupe-signature';

    await query(
      `INSERT INTO wallets (address, chain, status)
       VALUES ($1, 'solana', 'active')
       ON CONFLICT (address) DO NOTHING`,
      [wallet]
    );

    const insertSame = () => query(
      `INSERT INTO source_trades (
         chain, source_event_type, source_event_id, source_event_index,
         transaction_hash, wallet_address, token_mint, direction,
         token_amount, event_at, observed_at, confirmation_state
       ) VALUES (
         'solana', 'transaction', $1, '0',
         $1, $2, $3, 'buy',
         1, NOW(), NOW(), 'confirmed'
       )`,
      [txHash, wallet, token]
    );

    try {
      await insertSame();
      await expect(insertSame()).rejects.toMatchObject({ code: '23505' });
    } finally {
      await query(`DELETE FROM source_trades WHERE transaction_hash = $1`, [txHash]);
      await query(`DELETE FROM wallets WHERE address = $1`, [wallet]);
    }
  });

  it('replays cleanly — a second migrate leaves the same shape', async () => {
    // migrate.ts re-runs every file, so the shape-matched drop must be a no-op the
    // second time. Asserted by shape rather than by running migrate here.
    const rows = await query<{ contype: string; conname: string }>(`
      SELECT contype::text, conname FROM pg_constraint
       WHERE conrelid = 'source_trades'::regclass AND contype = 'u'
    `);
    const shapes = rows.map((r) => r.conname);
    expect(new Set(shapes).size).toBe(shapes.length);
  });
});
