import { describe, expect, it, vi } from 'vitest';
vi.mock('./tenancy.js', () => ({ withTenantTransaction: vi.fn(() => { throw new Error('real SQL unavailable in offline tests'); }) }));
import { createLpPaperSqlStore } from './lp-paper-store.js';
import { lpPaperFixture } from './lp-paper-fixture.js';
import { lpAcquisitionHash, lpExactHash, lpSnapshot, type LpExactOperation, type LpExactPosition } from './lp-exact.js';
import { lpAdmissionContextKey, lpAdmissionQuoteInput, type LpQuoteAdmissionContext, type LpProtectedQuoteAdmission, type LpProtectedSettlementAdmission } from './lp-paper-admission-contract.js';
import type { LpAcquisitionCommit } from './lp-paper-service.js';
import type { UserScope } from './tenancy.js';
const userId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const admissionId = '44444444-4444-4444-8444-444444444444';
const settlementId = '55555555-5555-4555-8555-555555555555';
const scope = { userId } as UserScope;
const time = (seconds: number) => new Date(Date.UTC(2026, 10, 17, 12, 0, seconds)).toISOString();
function admitted(context: LpQuoteAdmissionContext): LpProtectedQuoteAdmission {
  return { id: admissionId, userId, context: lpSnapshot(context), input: lpAdmissionQuoteInput(userId, context),
    contextKey: lpAdmissionContextKey(context), quote: lpSnapshot(context.commit.quote), quoteHash: lpExactHash(context.commit.quote), admittedAt: time(1) };
}
/** Admissions and locked rows are explicit inputs, not fabricated in response to a runtime candidate. */
function sqlFixture(input: { quote?: LpProtectedQuoteAdmission; settlement?: LpProtectedSettlementAdmission;
  position?: LpExactPosition; operation?: LpExactOperation; failUpdate?: boolean; legacyCopyCount?: string } = {}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const inserted: Record<string, unknown[]> = {};
  const state = { position: lpSnapshot(input.position ?? null), operation: lpSnapshot(input.operation ?? null),
    acquisition: null as LpExactPosition | null, legacyState: null as LpExactPosition['state'] | null, legacyConsent: null as boolean | null };
  const run = async (_scope: UserScope, action: any) => {
    const before = lpSnapshot(inserted), prior = lpSnapshot(state);
    const client = { query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('lp-admission:clock')) return { rows: [{ now: time(12) }] };
      if (sql.includes('lp-admission:quote')) {
        const q = input.quote;
        return { rows: q ? [{ id: q.id, user_id: q.userId, input: q.input, quote: q.quote, context: q.context,
          context_key: q.contextKey, quote_hash: q.quoteHash, admitted_at: q.admittedAt }] : [] };
      }
      if (sql.includes('lp-admission:operation-time')) return { rows: state.operation ? [{ created_at: time(2) }] : [] };
      if (sql.includes('lp-admission:settlement')) {
        const s = input.settlement;
        return { rows: s ? [{ id: s.id, user_id: s.userId, quote_admission_id: s.quoteAdmissionId, operation_id: s.operationId,
          position_id: s.positionId, position_revision: s.positionRevision, receipt: s.receipt, context: s.context, admitted_at: s.admittedAt }] : [] };
      }
      if (sql.startsWith('SELECT id FROM users')) return { rows: [{ id: userId }] };
      if (sql.startsWith('SELECT gen_random_uuid')) return { rows: [{ id: operationId }] };
      if (sql.includes('INSERT INTO lp_positions(')) { inserted.position = values; return { rows: [{ id: positionId }] }; }
      if (sql.includes('INSERT INTO lp_exact_positions')) {
        inserted.exact = values; state.position = JSON.parse(String(values[5])); state.acquisition = lpSnapshot(state.position); return { rows: [] };
      }
      if (sql.includes('INSERT INTO lp_copy_executions')) { inserted.copy = values; return { rows: [] }; }
      if (sql.includes('INSERT INTO lp_exact_operations')) { inserted.operation = values; state.operation = JSON.parse(String(values[5])); return { rows: [] }; }
      if (sql.includes('INSERT INTO lp_exact_receipts')) { inserted.receipt = values; return { rows: [] }; }
      if (sql.includes('UPDATE lp_exact_operations')) { inserted.done = values; state.operation = JSON.parse(String(values[2])); return { rows: [] }; }
      if (sql.includes('UPDATE lp_exact_positions')) {
        if (input.failUpdate) throw new Error('SQL transaction injected failure');
        inserted.settlement = values; state.position = JSON.parse(String(values[2])); return { rows: [] };
      }
      if (sql.startsWith('SELECT e.data')) return { rows: state.position ? [{ data: lpSnapshot(state.position),
        acquisition_data: lpSnapshot(state.acquisition ?? state.position), state: state.legacyState ?? state.position.state,
        auto_rebalance: state.legacyConsent ?? state.position.autoRebalance }] : [] };
      if (sql.startsWith('SELECT data FROM lp_exact_operations')) return { rows: state.operation ? [{ data: lpSnapshot(state.operation) }] : [] };
      if (sql.includes('COUNT(*)::text AS count FROM lp_copy_executions')) return { rows: [{ count: input.legacyCopyCount ?? '0' }] };
      if (sql.includes("SUM((acquisition_data->>'depositMicroUsd')")) return { rows: [{ spent: '6000000' }] };
      if (sql.includes('allocated_budget_usd::text')) return { rows: [{ id: 'sub', user_id: userId, master_wallet_address: 'solana:master', chain: 'solana', venue: 'meteora-dlmm', budget: '10.000000', cap: '6.000000', status: 'active', created_at: new Date('2026-11-17T11:00:00.000Z'), updated_at: new Date('2026-11-17T11:00:00.000Z') }] };
      if (sql.includes('max_pool_allocation_pct::text')) return { rows: [{ cap: '50.00' }] };
      if (sql.includes('AS unassessed')) return { rows: [{ total: '9007199254740993.123456', pool: '100.000001', unassessed: '0' }] };
      return { rows: [] };
    } };
    try { return await action(client); } catch (error) {
      for (const key of Object.keys(inserted)) delete inserted[key]; Object.assign(inserted, before); Object.assign(state, prior); throw error;
    }
  };
  return { store: createLpPaperSqlStore(run as any), calls, inserted, state };
}
const planner: Parameters<typeof lpPaperFixture>[0] = async (q, strategy) => ({ version: 2, protocol: q.pool.protocol, strategy, poolEvidenceId: q.pool.evidenceId,
  rungs: [{ priceLower: strategy.rangeLower, priceUpper: strategy.rangeUpper, allocation: q.amountAfter, binLower: 1, binUpper: 2 }] });
async function captured() {
  const f = lpPaperFixture(planner);
  const request = { operationKey: 'acq', chain: 'solana' as const, poolAddress: 'solana:pool', depositAsset: 'solana:mint', deposit: { raw: '900719925474099312345', scale: 18 },
    strategy: { rangeLower: 90, rangeUpper: 110, distribution: 'spot' as const, rungCount: 1 } };
  const acquired = await f.service.acquire(scope, request), p = { ...acquired, id: positionId };
  delete f.state.positions[acquired.id]; f.state.positions[p.id] = lpSnapshot(p);
  const r = await f.service.requestOperation(scope, { positionId: p.id, operationKey: 'close', action: 'close' });
  const op = { ...r.operation, id: operationId };
  delete f.state.operations[r.operation.id]; f.state.operations[op.id] = lpSnapshot(op);
  f.time.now = new Date(time(10)); f.receipts.available = true;
  const done = await f.service.process(scope, { operationId: op.id, chain: 'solana' });
  const receipt = done.operation.receipt!;
  const acquisition: LpAcquisitionCommit = { request, fingerprint: p.acquisitionFingerprint, quote: p.acquisitionQuote, plan: p.plan, origin: null };
  const quote = admitted({ kind: 'operation', commit: { position: p, operationKey: op.operationKey, fingerprint: op.fingerprint,
    action: op.action, quote: op.quote, plan: op.plan, receiptKey: op.receiptKey } });
  const settlement: LpProtectedSettlementAdmission = { id: settlementId, userId, quoteAdmissionId: admissionId,
    operationId, positionId, positionRevision: p.revision, receipt: lpSnapshot(receipt),
    context: { operation: lpSnapshot(op), position: lpSnapshot(p), operationCreatedAt: time(2) }, admittedAt: time(11) };
  return { request, p, op, receipt, acquisition, quote, settlement };
}
describe('tenant same-client exact LP SQL store seam (not PostgreSQL execution)', () => {
  it('factory import/construct performs no SQL and wildcard is denied before checked-out action', async () => {
    const s = sqlFixture(); expect(s.calls).toEqual([]);
    await expect(s.store.transaction({ userId: '*' } as UserScope, async () => null)).rejects.toThrow('tenant'); expect(s.calls).toEqual([]);
  });
  it('writes rawscale decimal strings and admitted acquisition evidence+history on same owner-locked client', async () => {
    const c = await captured(); const s = sqlFixture({ quote: admitted({ kind: 'acquisition', commit: c.acquisition }) });
    const p = await s.store.transaction(scope, tx => tx.insertAcquisition(c.acquisition));
    expect(s.calls[0]!.sql).toContain('FOR UPDATE'); expect(s.inserted.position![8]).toBe('900.719925474099312345');
    expect(s.inserted.position![11]).toBe('1111.999096'); expect(JSON.parse(String(s.inserted.exact![5])).deposit.raw).toBe('900719925474099312345');
    expect(p.id).toBe(positionId); expect(s.calls.filter(call => call.sql.includes('lp_position_state_history'))).toHaveLength(2);
  });
  it('acquisition and copy retry read immutable snapshot, not current state or consent', async () => {
    const c = await captured(); const s = sqlFixture({ quote: admitted({ kind: 'acquisition', commit: c.acquisition }) });
    const initial = await s.store.transaction(scope, tx => tx.insertAcquisition(c.acquisition));
    s.state.position = { ...initial, revision: '9', state: 'closed' }; s.state.legacyState = 'closed'; s.state.legacyConsent = true;
    expect(await s.store.transaction(scope, tx => tx.acquisition(c.request.operationKey))).toEqual(initial);
    expect(await s.store.transaction(scope, tx => tx.copyPosition('sub', 'event'))).toEqual(initial);
    expect(await s.store.transaction(scope, tx => tx.position(initial.id))).toMatchObject({ revision: '9', state: 'closed', autoRebalance: true });
  });
  it('unlinked legacy copy reservations block budget assessment; linked exact acquisition is counted once', async () => {
    const blocked = sqlFixture({ legacyCopyCount: '1' });
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
  it('independently admitted receipt persisted before completion/position/closed history on same transaction', async () => {
    const c = await captured(); const s = sqlFixture({ quote: c.quote, settlement: c.settlement, position: c.p, operation: c.op });
    await s.store.transaction(scope, tx => tx.settle(c.op, c.p, c.receipt));
    const receiptIndex = s.calls.findIndex(call => call.sql.includes('INSERT INTO lp_exact_receipts'));
    const closeIndex = s.calls.findIndex(call => call.sql.includes("SET state='closed'"));
    expect(receiptIndex).toBeGreaterThan(0); expect(closeIndex).toBeGreaterThan(receiptIndex);
    expect(JSON.parse(String(s.inserted.settlement![2]))).toMatchObject({ state: 'closed', realizedMicroUsd: '50000', currentAmount: { raw: '0', scale: 18 } });
    expect(JSON.parse(String(s.inserted.done![2])).status).toBe('completed');
  });
  it('failure during position settlement rolls back prior receipt/completion at transaction seam', async () => {
    const c = await captured(); const s = sqlFixture({ quote: c.quote, settlement: c.settlement, position: c.p, operation: c.op, failUpdate: true });
    await expect(s.store.transaction(scope, tx => tx.settle(c.op, c.p, c.receipt))).rejects.toThrow('transaction injected failure');
    expect(s.inserted).toEqual({}); expect(s.state.position).toEqual(c.p); expect(s.state.operation).toEqual(c.op);
    expect(s.calls.some(call => call.sql.includes("SET state='closed'"))).toBe(false);
  });
  it('copy acquisition and legacy execution linkage are one admitted transaction with truthful exact amount/ratio', async () => {
    const c = await captured();
    const origin = { subscriptionId: 'sub', subscriptionRevision: 'revision', eventId: 'event', masterWalletAddress: 'solana:master', masterPositionId: 'solana:nft',
      masterEvidenceHash: 'hash', masterDepositMicroUsd: '2000000000', budgetMicroUsd: '1200000000' };
    const fingerprint = lpAcquisitionHash(c.request, origin);
    const acquisition = { ...c.acquisition, origin, fingerprint, quote: { ...c.acquisition.quote, intentHash: fingerprint } };
    const s = sqlFixture({ quote: admitted({ kind: 'acquisition', commit: acquisition }) });
    await s.store.transaction(scope, tx => tx.insertAcquisition(acquisition));
    expect(s.inserted.copy![3]).toBe(positionId); expect(s.inserted.copy![5]).toBe('2000.000000'); expect(s.inserted.copy![6]).toBe('1111.999096');
    expect(s.calls.find(call => call.sql.includes('INSERT INTO lp_copy_executions'))!.sql).toContain('$7::numeric/$6::numeric');
  });
  it('refuses an acquisition without a preexisting protected admission before financial writes', async () => {
    const c = await captured(), s = sqlFixture();
    await expect(s.store.transaction(scope, tx => tx.insertAcquisition(c.acquisition))).rejects.toThrow('independently stored quote unavailable');
    expect(s.inserted).toEqual({});
  });
  it('refuses settlement when locked canonical rows are missing', async () => {
    const c = await captured(), s = sqlFixture({ quote: c.quote, settlement: c.settlement });
    await expect(s.store.transaction(scope, tx => tx.settle(c.op, c.p, c.receipt))).rejects.toThrow('canonical settlement context mismatch');
    expect(s.inserted).toEqual({});
  });
  it('refuses settlement without an independent settlement admission before receipt writes', async () => {
    const c = await captured(), s = sqlFixture({ quote: c.quote, position: c.p, operation: c.op });
    await expect(s.store.transaction(scope, tx => tx.settle(c.op, c.p, c.receipt))).rejects.toThrow('independently stored settlement unavailable');
    expect(s.inserted).toEqual({});
  });
});
