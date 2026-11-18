import { describe, expect, it, vi } from 'vitest';
import { lpPaperFixture } from '../../../packages/db/src/lp-paper-fixture.js';
import { lpExactHash, lpSnapshot, type LpExactPlan } from '../../../packages/db/src/lp-exact.js';
import type { LpTenantTransaction } from '../../../packages/db/src/lp-paper-store.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';
import { lpCopySqlObserver } from './lp-copy-observer.js';

const userId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const scope = { userId } as UserScope;
const plan: Parameters<typeof lpPaperFixture>[0] = async (quote, strategy): Promise<LpExactPlan> => ({
  version: 2, protocol: quote.pool.protocol, strategy, poolEvidenceId: quote.pool.evidenceId,
  rungs: Array.from({ length: strategy.rungCount }, (_, index) => {
    const total = BigInt(quote.amountAfter.raw), count = BigInt(strategy.rungCount);
    return { priceLower: strategy.rangeLower, priceUpper: strategy.rangeUpper,
      allocation: { raw: (total / count + (index === strategy.rungCount - 1 ? total % count : 0n)).toString(), scale: quote.amountAfter.scale },
      binLower: index + 1, binUpper: index + 2 };
  })
});
async function fixture() {
  const f = lpPaperFixture(plan), fixtureScope = { userId: 'alice' } as UserScope;
  const acquired = await f.service.copyMint(fixtureScope, { subscriptionId: 'sub', eventId: 'mint-event', assetScale: 18 });
  const admission = await f.service.requestOperation(fixtureScope, { positionId: acquired.id, operationKey: 'close', action: 'close' });
  f.receipts.available = true;
  const completed = await f.service.process(fixtureScope, { operationId: admission.operation.id, chain: 'solana' });
  const acquisition = { ...lpSnapshot(acquired), id: positionId, userId };
  const position = { ...lpSnapshot(f.state.positions[acquired.id]!), id: positionId, userId };
  const receipt = { ...lpSnapshot(completed.operation.receipt!), positionId, userId };
  const state = {
    identity: [{ role: 'swat_app', session: 'swat_app', row_security: 'on', tenant: userId, bypass: 'off' }],
    owners: [{ id: userId }],
    positions: [{ position_id: positionId, user_id: userId, acquisition_data: acquisition, data: position,
      state: position.state, auto_rebalance: position.autoRebalance }],
    receipts: [{ user_id: userId, operation_id: operationId, position_id: positionId,
      receipt_key: receipt.receiptKey, provider_id: receipt.providerId, receipt_id: receipt.receiptId,
      receipt_hash: lpExactHash(receipt), data: receipt }]
  };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('current_user::text')) return { rows: state.identity };
    expect(values).toEqual(sql.includes('public.users') ? [userId] : [userId, positionId]);
    if (sql.includes('public.users')) return { rows: state.owners };
    if (sql.includes('public.lp_exact_positions')) return { rows: state.positions };
    if (sql.includes('public.lp_exact_receipts')) return { rows: state.receipts };
    throw new Error('unexpected fixture SQL');
  });
  let commit = async () => {}, committed = false;
  const transaction: LpTenantTransaction = async (s, action) => {
    expect(s).toEqual(scope);
    const result = await action({ query } as unknown as Parameters<Parameters<LpTenantTransaction>[1]>[0]);
    await commit(); committed = true;
    return result;
  };
  return { state, query, transaction, acquisition, position, receipt,
    setCommit: (callback: () => Promise<void>) => { commit = callback; }, committed: () => committed };
}

describe('LP copy SQL observer with injected SQL transcript; no PostgreSQL execution', () => {
  it('exports independent acquisition, current position and durable hashed receipt after transaction completion', async () => {
    const f = await fixture();
    const result = await lpCopySqlObserver(f.transaction)(scope, positionId);
    expect(result).toEqual({ acquisition: f.acquisition, position: f.position,
      receipts: [{ operationId, hash: lpExactHash(f.receipt), data: f.receipt }] });
    expect(f.committed()).toBe(true);
    expect(f.query.mock.calls[1]![0]).toContain('FOR UPDATE');
    expect(f.query.mock.calls[3]![0]).toContain('ORDER BY operation_id LIMIT 2');
    expect(result.position).not.toBe(f.state.positions[0]!.data);
  });
  it('accepts an initial receiptless position without inventing settlement evidence', async () => {
    const f = await fixture(); f.state.positions[0]!.data = lpSnapshot(f.acquisition);
    f.state.positions[0]!.state = 'active'; f.state.receipts = [];
    const result = await lpCopySqlObserver(f.transaction)(scope, positionId);
    expect(result.position).toEqual(f.acquisition); expect(result.receipts).toEqual([]);
  });
  it('requires a caller-owned transaction rather than an ambient fallback', () => {
    expect(() => lpCopySqlObserver(undefined as any)).toThrow('owned transaction required');
  });
  it.each([undefined, { userId: '*' }, { userId: 'alice' }, { userId: { toString: (): string => userId } }])('refuses noncanonical scope before transaction admission (%j)', async input => {
    const transaction = vi.fn();
    await expect(lpCopySqlObserver(transaction)(input as UserScope, positionId)).rejects.toThrow('canonical tenant');
    expect(transaction).not.toHaveBeenCalled();
  });
  it('refuses a noncanonical position before transaction admission', async () => {
    const transaction = vi.fn();
    await expect(lpCopySqlObserver(transaction)(scope, 'invalid')).rejects.toThrow('canonical tenant');
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    ['role', 'swat_migrator'], ['session', 'swat_migrator'], ['row_security', 'off'],
    ['tenant', '44444444-4444-4444-8444-444444444444'], ['bypass', 'on']
  ])('refuses substituted %s identity before owner or financial reads', async (field, value) => {
    const f = await fixture(); Object.assign(f.state.identity[0]!, { [field]: value });
    await expect(lpCopySqlObserver(f.transaction)(scope, positionId)).rejects.toThrow('authenticated tenant');
    expect(f.query).toHaveBeenCalledTimes(1); expect(f.committed()).toBe(false);
  });
  it('refuses ambiguous identity rows', async () => {
    const f = await fixture(); f.state.identity.push({ ...f.state.identity[0]! });
    await expect(lpCopySqlObserver(f.transaction)(scope, positionId)).rejects.toThrow('authenticated tenant');
  });
  it('refuses missing owner before financial reads', async () => {
    const f = await fixture(); f.state.owners = [];
    await expect(lpCopySqlObserver(f.transaction)(scope, positionId)).rejects.toThrow('owned tenant');
    expect(f.query).toHaveBeenCalledTimes(2);
  });
  it.each(['missing', 'foreign', 'compatibility', 'snapshot'] as const)('refuses %s position evidence', async field => {
    const f = await fixture(), p = f.state.positions[0]!;
    if (field === 'missing') f.state.positions = [];
    else if (field === 'foreign') p.user_id = '44444444-4444-4444-8444-444444444444';
    else if (field === 'compatibility') p.state = 'active';
    else p.acquisition_data.userId = 'foreign';
    await expect(lpCopySqlObserver(f.transaction)(scope, positionId)).rejects.toThrow(/owned exact|position disagree/);
    expect(f.query).toHaveBeenCalledTimes(3);
  });
  it.each(['hash', 'tenant', 'position', 'provider', 'receipt-id', 'operation'] as const)('refuses %s receipt substitution', async field => {
    const f = await fixture(), r = f.state.receipts[0]!;
    if (field === 'hash') r.receipt_hash = '0'.repeat(64);
    else if (field === 'tenant') r.user_id = 'foreign';
    else if (field === 'position') r.data.positionId = 'foreign';
    else if (field === 'provider') r.provider_id = 'foreign';
    else if (field === 'receipt-id') r.receipt_id = 'foreign';
    else r.operation_id = 'invalid';
    await expect(lpCopySqlObserver(f.transaction)(scope, positionId)).rejects.toThrow('receipt identity or hash');
    expect(f.committed()).toBe(false);
  });
  it('rejects coercible receipt operation identifiers without calling toString', async () => {
    const f = await fixture(), toString = vi.fn((): string => operationId);
    f.state.receipts[0]!.operation_id = { toString } as unknown as string;
    await expect(lpCopySqlObserver(f.transaction)(scope, positionId)).rejects.toThrow('receipt identity or hash');
    expect(toString).not.toHaveBeenCalled();
  });
  it('captures tenant scope before the first await and never follows caller mutation', async () => {
    const f = await fixture(), mutable = { userId };
    const pending = lpCopySqlObserver(f.transaction)(mutable as UserScope, positionId);
    mutable.userId = '44444444-4444-4444-8444-444444444444';
    const observed = await pending;
    expect(observed.position.userId).toBe(userId);
    expect(f.query.mock.calls[1]![1]).toEqual([userId]);
  });
  it('refuses additional receipts in this bounded one-close scenario', async () => {
    const f = await fixture(); f.state.receipts.push(lpSnapshot(f.state.receipts[0]!));
    await expect(lpCopySqlObserver(f.transaction)(scope, positionId)).rejects.toThrow('additional receipts');
  });
  it('does not release observations before the supplied commit resolves', async () => {
    const f = await fixture(); let release = () => {};
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.setCommit(() => barrier);
    let returned = false;
    const pending = lpCopySqlObserver(f.transaction)(scope, positionId).then(result => { returned = true; return result; });
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledTimes(4));
    expect(returned).toBe(false); release(); await pending; expect(returned).toBe(true);
  });
  it('propagates failed transaction completion rather than returning a captured journal', async () => {
    const f = await fixture(); f.setCommit(async () => { throw new Error('synthetic commit uncertainty'); });
    await expect(lpCopySqlObserver(f.transaction)(scope, positionId)).rejects.toThrow('commit uncertainty');
    expect(f.committed()).toBe(false);
  });
});
