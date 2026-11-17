import { describe, expect, it, vi } from 'vitest';
vi.mock('./tenancy.js', () => ({ withTenantTransaction: vi.fn(() => { throw new Error('real SQL unavailable in offline tests'); }) }));
import { createLpPaperSqlStore } from './lp-paper-store.js';
import { lpPaperFixture } from './lp-paper-fixture.js';
import { lpSnapshot } from './lp-exact.js';
import type { UserScope } from './tenancy.js';
const scope = { userId: 'alice' } as UserScope;
function sqlFixture(failUpdate = false, legacyCopyCount = '0') {
  const calls: { sql: string; values: unknown[] }[] = [];
  const inserted: Record<string, unknown[]> = {};
  const run = async (_scope: UserScope, action: any) => {
    const before = lpSnapshot(inserted);
    const client = { query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: 'alice' }] };
      if (sql.startsWith('SELECT gen_random_uuid')) return { rows: [{ id: 'operation-sql' }] };
      if (sql.includes('INSERT INTO lp_positions(')) { inserted.position = values; return { rows: [{ id: 'position-sql' }] }; }
      if (sql.includes('INSERT INTO lp_exact_positions')) { inserted.exact = values; return { rows: [] }; }
      if (sql.includes('INSERT INTO lp_copy_executions')) { inserted.copy = values; return { rows: [] }; }
      if (sql.includes('INSERT INTO lp_exact_operations')) { inserted.operation = values; return { rows: [] }; }
      if (sql.includes('INSERT INTO lp_exact_receipts')) { inserted.receipt = values; return { rows: [] }; }
      if (sql.includes('UPDATE lp_exact_operations')) { inserted.done = values; return { rows: [] }; }
      if (sql.includes('UPDATE lp_exact_positions')) { if (failUpdate) throw new Error('SQL transaction injected failure'); inserted.settlement = values; return { rows: [] }; }
      if (sql.startsWith('SELECT e.data')) return { rows: inserted.exact ? [{ data: { ...JSON.parse(String(inserted.exact[5])), revision: '9', state: 'closed' },
        acquisition_data: JSON.parse(String(inserted.exact[5])), state: 'closed', auto_rebalance: true }] : [] };
      if (sql.includes('COUNT(*)::text AS count FROM lp_copy_executions')) return { rows: [{ count: legacyCopyCount }] };
      if (sql.includes("SUM((acquisition_data->>'depositMicroUsd')")) return { rows: [{ spent: '6000000' }] };
      if (sql.includes('allocated_budget_usd::text')) return { rows: [{ id: 'sub', user_id: 'alice', master_wallet_address: 'solana:master', chain: 'solana', venue: 'meteora-dlmm', budget: '10.000000', cap: '6.000000', status: 'active', created_at: new Date('2026-11-17T11:00:00.000Z'), updated_at: new Date('2026-11-17T11:00:00.000Z') }] };
      if (sql.includes('max_pool_allocation_pct::text')) return { rows: [{ cap: '50.00' }] };
      if (sql.includes('AS unassessed')) return { rows: [{ total: '9007199254740993.123456', pool: '100.000001', unassessed: '0' }] };
      return { rows: [] };
    } };
    try { return await action(client); } catch (error) { for (const key of Object.keys(inserted)) delete inserted[key]; Object.assign(inserted, before); throw error; }
  };
  return { store: createLpPaperSqlStore(run as any), calls, inserted };
}
const planner: Parameters<typeof lpPaperFixture>[0] = async (q, strategy) => ({ version: 2, protocol: q.pool.protocol, strategy, poolEvidenceId: q.pool.evidenceId,
  rungs: [{ priceLower: strategy.rangeLower, priceUpper: strategy.rangeUpper, allocation: q.amountAfter, binLower: 1, binUpper: 2 }] });
async function captured() {
  const f = lpPaperFixture(planner);
  const request = { operationKey: 'acq', chain: 'solana' as const, poolAddress: 'solana:pool', depositAsset: 'solana:mint', deposit: { raw: '900719925474099312345', scale: 18 },
    strategy: { rangeLower: 90, rangeUpper: 110, distribution: 'spot' as const, rungCount: 1 } };
  const p = await f.service.acquire(scope, request);
  const r = await f.service.requestOperation(scope, { positionId: p.id, operationKey: 'close', action: 'close' }); f.receipts.available = true;
  const done = await f.service.process(scope, { operationId: r.operation.id, chain: 'solana' });
  return { request, p, op: r.operation, receipt: done.operation.receipt! };
}
describe('tenant same-client exact LP SQL store seam (not PostgreSQL execution)', () => {
  it('factory import/construct performs no SQL and wildcard is denied before checked-out action', async () => {
    const s = sqlFixture(); expect(s.calls).toEqual([]);
    await expect(s.store.transaction({ userId: '*' } as UserScope, async () => null)).rejects.toThrow('tenant'); expect(s.calls).toEqual([]);
  });
  it('writes rawscale decimal strings and acquisition evidence+history on same owner-locked client', async () => {
    const c = await captured(); const s = sqlFixture();
    const p = await s.store.transaction(scope, tx => tx.insertAcquisition({ request: c.request, fingerprint: c.p.acquisitionFingerprint, quote: c.p.acquisitionQuote, plan: c.p.plan, origin: null }));
    expect(s.calls[0]!.sql).toContain('FOR UPDATE'); expect(s.inserted.position![8]).toBe('900.719925474099312345');
    expect(s.inserted.position![11]).toBe('1111.999096'); expect(JSON.parse(String(s.inserted.exact![5])).deposit.raw).toBe('900719925474099312345');
    expect(p.id).toBe('position-sql'); expect(s.calls.filter(call => call.sql.includes('lp_position_state_history'))).toHaveLength(2);
  });
  it('acquisition and copy retry read immutable snapshot, not current state or consent', async () => {
    const c = await captured(); const s = sqlFixture();
    const initial = await s.store.transaction(scope, tx => tx.insertAcquisition({ request: c.request, fingerprint: c.p.acquisitionFingerprint,
      quote: c.p.acquisitionQuote, plan: c.p.plan, origin: null }));
    expect(await s.store.transaction(scope, tx => tx.acquisition(c.request.operationKey))).toEqual(initial);
    expect(await s.store.transaction(scope, tx => tx.copyPosition('sub', 'event'))).toEqual(initial);
    expect(await s.store.transaction(scope, tx => tx.position(initial.id))).toMatchObject({ revision: '9', state: 'closed', autoRebalance: true });
  });
  it('unlinked legacy copy reservations block budget assessment; linked exact acquisition is counted once', async () => {
    const blocked = sqlFixture(false, '1');
    await expect(blocked.store.transaction(scope, tx => tx.copySpentMicroUsd('sub'))).rejects.toThrow('legacy copy capital unassessed');
    const s = sqlFixture(); expect(await s.store.transaction(scope, tx => tx.copySpentMicroUsd('sub'))).toBe('6000000');
    expect(s.calls.find(call => call.sql.includes('FROM lp_copy_executions'))!.sql).toContain('NOT EXISTS');
  });
  it('reads exposure and subscription NUMERIC using SQL text casts, not global numeric parser', async () => {
    const s = sqlFixture();
    const policy = await s.store.transaction(scope, tx => tx.policy('solana', 'solana:pool'));
    expect(policy.totalMicroUsd).toBe('9007199254740993123456'); expect(policy.poolMicroUsd).toBe('100000001'); expect(policy.poolCapBps).toBe(5000);
    const sub = await s.store.transaction(scope, tx => tx.subscription('sub')); expect(sub?.budgetMicroUsd).toBe('10000000');
    expect(s.calls.find(call => call.sql.includes('AS total'))?.sql).toContain('::text');
  });
  it('receipt persisted before completion/position/closed history on same transaction', async () => {
    const c = await captured(); const s = sqlFixture();
    await s.store.transaction(scope, tx => tx.settle(c.op, c.p, c.receipt));
    const receiptIndex = s.calls.findIndex(call => call.sql.includes('INSERT INTO lp_exact_receipts'));
    const closeIndex = s.calls.findIndex(call => call.sql.includes("SET state='closed'"));
    expect(receiptIndex).toBeGreaterThan(0); expect(closeIndex).toBeGreaterThan(receiptIndex);
    expect(JSON.parse(String(s.inserted.settlement![2]))).toMatchObject({ state: 'closed', realizedMicroUsd: '50000', currentAmount: { raw: '0', scale: 18 } });
    expect(JSON.parse(String(s.inserted.done![2])).status).toBe('completed');
  });
  it('failure during position settlement rolls back prior receipt/completion at transaction seam', async () => {
    const c = await captured(); const s = sqlFixture(true);
    await expect(s.store.transaction(scope, tx => tx.settle(c.op, c.p, c.receipt))).rejects.toThrow('transaction injected failure');
    expect(s.inserted).toEqual({}); expect(s.calls.some(call => call.sql.includes("SET state='closed'"))).toBe(false);
  });
  it('copy acquisition and legacy execution linkage are one transaction with truthful exact amount/ratio', async () => {
    const c = await captured(); const s = sqlFixture();
    await s.store.transaction(scope, tx => tx.insertAcquisition({ request: c.request, fingerprint: c.p.acquisitionFingerprint, quote: c.p.acquisitionQuote, plan: c.p.plan,
      origin: { subscriptionId: 'sub', subscriptionRevision: 'revision', eventId: 'event', masterWalletAddress: 'solana:master', masterPositionId: 'solana:nft',
        masterEvidenceHash: 'hash', masterDepositMicroUsd: '2000000000', budgetMicroUsd: '1200000000' } }));
    expect(s.inserted.copy![3]).toBe('position-sql'); expect(s.inserted.copy![5]).toBe('2000.000000'); expect(s.inserted.copy![6]).toBe('1111.999096');
    expect(s.calls.find(call => call.sql.includes('INSERT INTO lp_copy_executions'))!.sql).toContain('$7::numeric/$6::numeric');
  });
});
