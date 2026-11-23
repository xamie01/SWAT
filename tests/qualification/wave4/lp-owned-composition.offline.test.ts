import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOwnedLpPaperComposition, type LpOwnedCompositionPorts, type LpOwnedProtectedRecord,
  type LpOwnedPurpose, type PoolClient, type UserScope } from '../../../packages/db/src/lp-paper-owned.js';
import { lpAcquisitionHash, lpExactHash, lpSnapshot, type LpExactPosition, type LpExactOperation,
  type LpExactAcquisitionRequest, type LpExactPlan, type LpPaperQuote, type LpPaperReceipt } from '../../../packages/db/src/lp-exact.js';
import { lpOperationIntent } from '../../../packages/db/src/lp-paper-service.js';
import { lpAdmissionQuoteInput, lpAdmissionContextKey, type LpQuoteAdmissionContext } from '../../../packages/db/src/lp-paper-admission-contract.js';
import { lpDurableHistorySqlObserver } from './lp-durable-history-observer.js';

const userId = '11111111-1111-4111-8111-111111111111', positionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333', identityId = '44444444-4444-4444-8444-444444444444';
const admissionId = '55555555-5555-4555-8555-555555555555', subscriptionId = '66666666-6666-4666-8666-666666666666';
const scope = { userId } as UserScope;
function fixture() {
  const now = new Date(), t = now.toISOString();
  const binding = { userId, accountId: 'solana:account', chain: 'solana' as const, networkId: 'solana:offline' };
  const request: LpExactAcquisitionRequest = { operationKey: 'owned-acquire', chain: 'solana', poolAddress: 'solana:pool',
    depositAsset: 'solana:asset', deposit: { raw: '900719925474099312345', scale: 18 },
    strategy: { distribution: 'spot', rangeLower: 90, rangeUpper: 110, rungCount: 1 }, autoRebalance: false };
  const plan: LpExactPlan = { version: 2, protocol: 'meteora-dlmm', strategy: request.strategy, poolEvidenceId: 'pool-context',
    rungs: [{ priceLower: 90, priceUpper: 110, allocation: request.deposit, binLower: -1, binUpper: 1 }] };
  const q: LpPaperQuote = { version: 1, providerId: 'protected-provider', quoteId: 'owned-acquire-quote', userId,
    action: 'acquire', mode: 'paper', intentHash: lpAcquisitionHash(request),
    pool: { chain: 'solana', networkId: binding.networkId, protocol: 'meteora-dlmm', poolAddress: request.poolAddress,
      depositAsset: request.depositAsset, depositScale: 18, evidenceId: 'pool-context', observedAt: t,
      currentPrice: 100, binStep: 10, tickSpacing: null }, deposit: request.deposit,
    unitPriceUsd: { raw: '1000000', scale: 6 }, valueMicroUsd: '900719925', amountAfter: request.deposit,
    proceedsMicroUsd: '0', observedAt: t, expiresAt: new Date(now.getTime() + 60000).toISOString(), economics: null };
  const acquisitionContext: LpQuoteAdmissionContext = { kind: 'acquisition', commit: { request,
    fingerprint: q.intentHash, quote: q, plan, origin: null } };
  const initial: LpExactPosition = { id: positionId, userId, chain: 'solana', protocol: 'meteora-dlmm', poolAddress: request.poolAddress,
    depositAsset: request.depositAsset, acquisitionKey: request.operationKey, acquisitionFingerprint: q.intentHash, mode: 'paper',
    deposit: request.deposit, depositMicroUsd: q.valueMicroUsd, acquisitionQuote: q, copyOrigin: null,
    currentAmount: request.deposit, plan, revision: '0', state: 'active', autoRebalance: false,
    cumulativeFeesMicroUsd: '0', cumulativeCostsMicroUsd: '0', realizedMicroUsd: null, lastReceiptKey: null };
  const closeQuote: LpPaperQuote = { ...q, quoteId: 'owned-close-quote', action: 'close', intentHash: lpOperationIntent(initial, 'close'),
    amountAfter: { raw: '0', scale: 18 }, proceedsMicroUsd: q.valueMicroUsd };
  const receiptKey = `lp-receipt-${lpExactHash([userId, 'owned-close', closeQuote.intentHash])}`;
  const operation: LpExactOperation = { id: operationId, userId, positionId, operationKey: 'owned-close', fingerprint: closeQuote.intentHash,
    action: 'close', positionRevision: '0', amountBefore: request.deposit, quote: closeQuote, plan: null,
    receiptKey, status: 'pending', receipt: null };
  const operationContext: LpQuoteAdmissionContext = { kind: 'operation', commit: { position: initial, operationKey: operation.operationKey,
    fingerprint: operation.fingerprint, action: 'close', quote: closeQuote, plan: null, receiptKey } };
  const receipt: LpPaperReceipt = { version: 1, providerId: q.providerId, receiptId: 'owned-receipt', receiptKey, userId,
    positionId, positionRevision: '0', mode: 'paper', action: 'close', networkId: binding.networkId, chain: 'solana',
    protocol: initial.protocol, poolAddress: initial.poolAddress, depositAsset: initial.depositAsset,
    quoteId: closeQuote.quoteId, quoteHash: lpExactHash(closeQuote), amountBefore: request.deposit,
    amountAfter: closeQuote.amountAfter, proceedsMicroUsd: closeQuote.proceedsMicroUsd, collectedFeesMicroUsd: '100001',
    executionCostsMicroUsd: '50002', settledAt: t, finality: 'paper-settled' };
  const subRow = { id: subscriptionId, user_id: userId, master_wallet_address: 'solana:master', chain: 'solana', venue: 'meteora-dlmm',
    budget: '1000.000000', cap: '1000.000000', status: 'active', created_at: new Date(now.getTime() - 1000), updated_at: new Date(now.getTime() - 1000) };
  const subscription = { id: subscriptionId, userId, masterWalletAddress: subRow.master_wallet_address,
    chain: 'solana' as const, venue: 'meteora-dlmm' as const, budgetMicroUsd: '1000000000', capMicroUsd: '1000000000', status: 'active' as const,
    createdAt: subRow.created_at.toISOString(), revision: lpExactHash({ status: subRow.status, budget: subRow.budget,
      cap: subRow.cap, updatedAt: subRow.updated_at.toISOString() }) };
  const authorities = Object.fromEntries(['initialization','secret','quote','receipt','master','risk','quote-context','settlement-context']
    .map(p => [p, { identityId, providerId: p === 'master' ? 'protected-master' : p === 'risk' ? 'protected-risk' : q.providerId }])) as LpOwnedCompositionPorts['authorities'];
  const records = new Map<string, LpOwnedProtectedRecord<unknown>>();
  function seed(purpose: LpOwnedPurpose, selector: string, payload: unknown) {
    records.set(`${purpose}:${selector}`, { id: admissionId, identityId, providerId: authorities[purpose].providerId,
      binding, purpose, selector, payload: lpSnapshot(payload), payloadHash: lpExactHash(payload), admittedAt: t,
      expiresAt: new Date(now.getTime() + 300000).toISOString(), revokedAt: null });
  }
  seed('initialization', 'initialized', { subscription, poolCapBps: 10000 });
  seed('secret', 'secret-reference', { secretAdmissionId: admissionId, accountId: binding.accountId,
    actions: ['acquire','copy','rebalance','close','recover'] });
  seed('quote', q.quoteId, q); seed('quote', closeQuote.quoteId, closeQuote); seed('receipt', receipt.receiptId, receipt);
  seed('quote-context', lpAdmissionContextKey(acquisitionContext), acquisitionContext);
  seed('quote-context', lpAdmissionContextKey(operationContext), operationContext);
  seed('settlement-context', operationId, { operation, position: initial, operationCreatedAt: t });
  const state = { position: null as LpExactPosition | null, acquisition: null as LpExactPosition | null,
    op: null as LpExactOperation | null, receiptRows: [] as any[], history: [] as any[], quotes: [] as any[], settlements: [] as any[],
    runtimeAllowed: true, admitterAllowed: true, runtimeCommitFailure: false, admissionCommitFailure: false,
    historyOverflow: false, receiptAvailable: true, protectedReads: [] as string[], queries: [] as { role: string; sql: string; values: unknown[] }[],
    mutation: null as (() => void) | null, cap: '100.000000', subscription: subRow };
  const query = (role: 'runtime' | 'admitter') => async (sql: string, values: unknown[] = []) => {
    state.queries.push({ role, sql, values: lpSnapshot(values) });
    if (sql.includes('lp-owned:runtime-identity') || sql.includes('lp-history:identity')) return { rows: [{ role: state.runtimeAllowed ? 'swat_app' : 'attacker',
      session: 'swat_app', row_security: 'on', tenant: userId, bypass: 'off', now: t }] };
    if (sql.includes('lp-admission:restricted')) return { rows: [{ allowed: role === 'admitter' && state.admitterAllowed }] };
    if (sql.includes('lp-admission:clock')) return { rows: [{ now: t }] };
    if (/SELECT id FROM (public\.)?users/.test(sql)) return { rows: [{ id: userId }] };
    if (sql.includes('FROM lp_copy_subscriptions')) return { rows: [state.subscription] };
    if (sql.includes('max_pool_allocation_pct')) return { rows: [{ cap: state.cap }] };
    if (sql.includes('AS unassessed')) return { rows: [{ total: '0', pool: '0', unassessed: '0' }] };
    if (sql.includes('lp-admission:write-quote')) {
      const context = JSON.parse(values[5] as string);
      const row = { id: admissionId, user_id: userId, input: JSON.parse(values[2] as string), quote: JSON.parse(values[3] as string),
        quote_hash: values[4], context, context_key: values[6], admitted_at: t };
      state.quotes.push(row); return { rows: [row] };
    }
    if (sql.includes('lp-admission:quote')) return { rows: state.quotes.filter(r => r.context_key === values[5]) };
    if (sql.includes('lp-admission:operation-time')) return { rows: state.op ? [{ created_at: t }] : [] };
    if (sql.includes('lp-admission:write-settlement')) {
      const row = { id: admissionId, user_id: userId, quote_admission_id: admissionId, operation_id: operationId,
        position_id: positionId, position_revision: '0', receipt: JSON.parse(values[5] as string), context: JSON.parse(values[6] as string), admitted_at: t };
      state.settlements.push(row); return { rows: [row] };
    }
    if (sql.includes('lp-admission:settlement')) return { rows: state.settlements };
    if (sql.includes('lp-history:operations')) return { rows: state.op ? [{ id: state.op.id, user_id: userId, position_id: positionId,
      operation_key: state.op.operationKey, receipt_key: state.op.receiptKey, status: state.op.status, data: state.op,
      created_at: t, completed_at: state.op.status === 'completed' ? t : null }] : [] };
    if (sql.includes('lp-history:receipts')) return { rows: state.receiptRows };
    if (sql.includes('lp-history:states')) return { rows: state.historyOverflow ? Array.from({ length: 20 }, () => state.history[0]) : state.history };
    if (sql.includes('lp-history:copies')) return { rows: [] };
    if (sql.includes('lp_exact_positions e')) {
      const p = sql.includes('acquisition_key') || sql.includes('master_event_id') ? state.acquisition : state.position;
      return { rows: p ? [{ position_id: positionId, user_id: userId, data: p, acquisition_data: state.acquisition,
        state: state.position!.state, auto_rebalance: state.position!.autoRebalance }] : [] };
    }
    if (sql.startsWith('SELECT data FROM lp_exact_operations')) {
      if (!state.op || sql.includes("status='pending'") && state.op.status !== 'pending') return { rows: [] };
      return { rows: [{ data: state.op }] };
    }
    if (sql.includes('gen_random_uuid')) return { rows: [{ id: operationId }] };
    if (sql.startsWith('INSERT INTO lp_positions')) return { rows: [{ id: positionId }] };
    if (sql.startsWith('INSERT INTO lp_exact_positions')) { state.position = JSON.parse(values[5] as string); state.acquisition = lpSnapshot(state.position); return { rows: [] }; }
    if (sql.startsWith('INSERT INTO lp_exact_operations')) { state.op = JSON.parse(values[5] as string); return { rows: [] }; }
    if (sql.startsWith('INSERT INTO lp_exact_receipts')) {
      state.receiptRows.push({ user_id: userId, operation_id: operationId, position_id: positionId, receipt_key: values[3],
        provider_id: values[4], receipt_id: values[5], receipt_hash: values[6], data: JSON.parse(values[7] as string), accepted_at: t }); return { rows: [] };
    }
    if (sql.startsWith('UPDATE lp_exact_operations')) { state.op = JSON.parse(values[2] as string); return { rows: [] }; }
    if (sql.startsWith('UPDATE lp_exact_positions')) { state.position = JSON.parse(values[2] as string); return { rows: [] }; }
    if (sql.startsWith('UPDATE lp_positions')) return { rows: [] };
    if (sql.startsWith('INSERT INTO lp_position_state_history')) {
      state.history.push({ id: String(state.history.length + 1), position_id: positionId, from_state: values[1], to_state: values[2], reason: values[3], changed_at: t }); return { rows: [] };
    }
    throw new Error('Unscripted canonical LP SQL: ' + sql);
  };
  const runtimeClient = { query: query('runtime') } as unknown as PoolClient;
  const admitterClient = { query: query('admitter') } as unknown as PoolClient;
  const runtime: LpOwnedCompositionPorts['runtimeTransaction'] = async (_s, action) => {
    const before = lpSnapshot({ position: state.position, acquisition: state.acquisition, op: state.op, receiptRows: state.receiptRows, history: state.history });
    try { const result = await action(runtimeClient); if (state.runtimeCommitFailure) throw new Error('uncertain runtime COMMIT'); return result; }
    catch (e) { Object.assign(state, before); throw e; }
  };
  const admission: LpOwnedCompositionPorts['admissionTransaction'] = async (_s, action) => {
    const before = lpSnapshot({ quotes: state.quotes, settlements: state.settlements });
    try { const result = await action(admitterClient); if (state.admissionCommitFailure) throw new Error('uncertain admission COMMIT'); return result; }
    catch (e) { Object.assign(state, before); throw e; }
  };
  const ports: LpOwnedCompositionPorts = { binding, authorities, runtimeTransaction: runtime, admissionTransaction: admission,
    initializationSelector: 'initialized', secretSelector: 'secret-reference', protectedSource: { read: async <T>(_client: PoolClient, _b: unknown, purpose: LpOwnedPurpose, selector: string) => {
      state.protectedReads.push(`${purpose}:${selector}`); const row = records.get(`${purpose}:${selector}`);
      return row ? lpSnapshot(row) as LpOwnedProtectedRecord<T> : null;
    } },
    mode: async () => 'paper', plan: async () => { state.mutation?.(); return lpSnapshot(plan); }, enqueue: async () => {},
    master: { providerId: 'protected-master', read: async () => null }, copyRisk: { providerId: 'protected-risk', assess: async () => null },
    protocol: { providerId: q.providerId, networks: { solana: binding.networkId }, quote: async input => lpSnapshot(input.action === 'acquire' ? q : closeQuote),
      receipt: async () => state.receiptAvailable ? lpSnapshot(receipt) : null } };
  return { ports, state, records, request, initial, operation, receipt, plan, q, runtime, runtimeClient, seed, subscription,
    service: createOwnedLpPaperComposition(ports), observe: lpDurableHistorySqlObserver(runtime) };
}
function runtimeWrites(f: ReturnType<typeof fixture>) { return f.state.queries.filter(q => q.role === 'runtime' && /^(INSERT|UPDATE)/.test(q.sql)); }

describe('LP strict owned callable factory through actual protected SQL leaves; inert IO only', () => {
  it('requires distinct owned transactions and every external approved identity before reading IO', () => {
    const f = fixture();
    expect(() => createOwnedLpPaperComposition({ ...f.ports, admissionTransaction: f.ports.runtimeTransaction })).toThrow('distinct');
    expect(() => createOwnedLpPaperComposition({ ...f.ports, authorities: {} as never })).toThrow('externally approved');
    expect(() => createOwnedLpPaperComposition({ ...f.ports, master: undefined as never })).toThrow('mandatory');
    expect(f.state.queries).toEqual([]);
  });
  it('reuses canonical protected writer/store acquisition operation settlement and independent durable history', async () => {
    const f = fixture(); expect(await f.service.acquire(scope, f.request)).toEqual(f.initial);
    const pending = await f.service.requestOperation(scope, { positionId, operationKey: 'owned-close', action: 'close' });
    expect(pending.operation.status).toBe('pending'); expect(f.state.receiptRows).toEqual([]);
    const done = await f.service.process(scope, { operationId, chain: 'solana' });
    expect(done.operation.status).toBe('completed'); expect(f.state.position!.realizedMicroUsd).toBe('49999');
    const observed = await f.observe(scope, positionId);
    expect(observed.acquisition).toEqual(f.initial); expect(observed.position.currentAmount).toEqual({ raw: '0', scale: 18 });
    expect(observed.operations).toHaveLength(1); expect(observed.receipts).toHaveLength(1); expect(observed.history).toHaveLength(3);
    expect(observed.receipts[0]!.data).toEqual(f.receipt);
    expect(f.state.queries.filter(q => /lp-admission:write-/.test(q.sql)).every(q => q.role === 'admitter')).toBe(true);
    const writes = runtimeWrites(f); const receiptIndex = writes.findIndex(q => q.sql.startsWith('INSERT INTO lp_exact_receipts'));
    expect(writes[receiptIndex + 1]!.sql).toContain('UPDATE lp_exact_operations');
    expect(writes[receiptIndex + 2]!.sql).toContain('UPDATE lp_exact_positions');
    const count = writes.length; await f.service.process(scope, { operationId, chain: 'solana' });
    expect(await f.service.acquire(scope, f.request)).toEqual(f.initial); expect(runtimeWrites(f)).toHaveLength(count);
    expect(f.service.capabilities()).toMatchObject({ runtimeAccepted: false, sourceComplete: false, protectedBackingInstalled: false });
    expect(f.service.capabilities().sourceGaps).toHaveLength(3);
  });
  it.each(['initialization','secret','quote','quote-context'] as const)('identity strings and callbacks cannot supply missing %s protected source backing', async purpose => {
    const f = fixture(); for (const key of f.records.keys()) if (key.startsWith(purpose + ':')) f.records.delete(key);
    await expect(f.service.acquire(scope, f.request)).rejects.toThrow(/independently protected/); expect(runtimeWrites(f)).toEqual([]);
  });
  it.each(['identityId','providerId','account','network','tenant','hash','future','expired','revoked'] as const)('refuses %s protected admission substitution before financial SQL writes', async field => {
    const f = fixture(), key = 'secret:secret-reference', r = f.records.get(key)!;
    f.records.set(key, { ...r, ...(field === 'identityId' ? { identityId: subscriptionId } : field === 'providerId' ? { providerId: 'attacker' }
      : field === 'account' ? { binding: { ...r.binding, accountId: 'solana:foreign' } } : field === 'network' ? { binding: { ...r.binding, networkId: 'solana:foreign' } }
      : field === 'tenant' ? { binding: { ...r.binding, userId: subscriptionId } } : field === 'hash' ? { payloadHash: '0'.repeat(64) }
      : field === 'future' ? { admittedAt: '2099-01-01T00:00:00.000Z' } : field === 'expired' ? { expiresAt: '2000-01-01T00:00:00.000Z' }
      : { revokedAt: '2026-01-01T00:00:00.000Z' as never }) });
    await expect(f.service.acquire(scope, f.request)).rejects.toThrow(); expect(runtimeWrites(f)).toEqual([]);
  });
  it('refuses missing SQL initialization rather than inventing an allowed runtime writer', async () => {
    const f = fixture(); f.state.subscription = null as never;
    // Inert SQL has no subscription row, matching the production store API.
    const original = f.runtimeClient.query.bind(f.runtimeClient);
    f.runtimeClient.query = (async (sql: string, values?: unknown[]) => sql.includes('FROM lp_copy_subscriptions') ? { rows: [] } : original(sql, values)) as never;
    await expect(f.service.initialization(scope)).rejects.toThrow('initialization SQL writer unavailable'); expect(runtimeWrites(f)).toEqual([]);
  });
  it.each(['secret','initialization','cap'] as const)('rechecks %s after planning under the final canonical owner lock', async kind => {
    const f = fixture(); f.state.mutation = () => {
      if (kind === 'cap') f.state.cap = '50.000000';
      else f.records.delete(`${kind}:${kind === 'secret' ? 'secret-reference' : 'initialized'}`);
    };
    await expect(f.service.acquire(scope, f.request)).rejects.toThrow(); expect(runtimeWrites(f)).toEqual([]);
  });
  it.each(['runtime','admitter','runtimeCommit','admissionCommit'] as const)('refuses %s failure without returning accepted capital', async kind => {
    const f = fixture(); if (kind === 'runtime') f.state.runtimeAllowed = false; if (kind === 'admitter') f.state.admitterAllowed = false;
    if (kind === 'runtimeCommit') f.state.runtimeCommitFailure = true; if (kind === 'admissionCommit') f.state.admissionCommitFailure = true;
    await expect(f.service.acquire(scope, f.request)).rejects.toThrow(); expect(f.state.position).toBeNull();
  });
  it('receipt availability and a queue recovery result never manufacture settlement admission', async () => {
    const f = fixture(); await f.service.acquire(scope, f.request);
    await f.service.requestOperation(scope, { positionId, operationKey: 'owned-close', action: 'close' });
    f.state.receiptAvailable = false; expect(await f.service.recover(scope)).toEqual({ queued: 1, deferred: 0 });
    expect((await f.service.process(scope, { operationId, chain: 'solana' })).receiptPending).toBe(true);
    expect(f.state.position!.revision).toBe('0'); expect(f.state.receiptRows).toEqual([]);
    f.state.receiptAvailable = true; f.records.delete('settlement-context:' + operationId);
    await expect(f.service.process(scope, { operationId, chain: 'solana' })).rejects.toThrow('independently protected');
    expect(f.state.receiptRows).toEqual([]);
  });
  it.each(['fee','revision','inventory','chronology'] as const)('full protected settlement %s substitution refuses economic writes', async field => {
    const f = fixture(); await f.service.acquire(scope, f.request);
    await f.service.requestOperation(scope, { positionId, operationKey: 'owned-close', action: 'close' });
    const before = runtimeWrites(f).length;
    if (field === 'fee') f.seed('receipt', f.receipt.receiptId, { ...f.receipt, collectedFeesMicroUsd: '999999999' });
    if (field === 'revision') f.state.position = { ...f.state.position!, revision: '1' };
    if (field === 'inventory') f.state.position = { ...f.state.position!, currentAmount: { raw: '1', scale: 18 } };
    if (field === 'chronology') {
      const key = 'settlement-context:' + operationId, r = f.records.get(key)!;
      f.seed('settlement-context', operationId, { ...(r.payload as object), operationCreatedAt: '2000-01-01T00:00:00.000Z' });
    }
    await expect(f.service.process(scope, { operationId, chain: 'solana' })).rejects.toThrow();
    expect(runtimeWrites(f)).toHaveLength(before); expect(f.state.receiptRows).toEqual([]);
  });
  it.each(['missing', 'network', 'hash'] as const)('canonical copy rejects %s protected master evidence before capital SQL', async kind => {
    const f = fixture(), event = { providerId: 'protected-master', eventId: 'owned-mint', chain: 'solana' as const,
      networkId: f.ports.binding.networkId, protocol: 'meteora-dlmm' as const, masterWalletAddress: 'solana:master',
      masterPositionId: 'solana:master-position', poolAddress: 'solana:pool', depositAsset: 'solana:asset',
      action: 'mint' as const, finality: 'finalized' as const, provenance: 'injected-mint-event' as const,
      openedAt: f.q.observedAt, observedAt: f.q.observedAt, masterDepositMicroUsd: '100000000', strategy: f.request.strategy };
    if (kind !== 'missing') f.seed('master', event.eventId, kind === 'network' ? { ...event, networkId: 'solana:foreign' } : event);
    if (kind === 'hash') {
      const r = f.records.get('master:' + event.eventId)!; f.records.set('master:' + event.eventId, { ...r, payloadHash: '0'.repeat(64) });
    }
    const service = createOwnedLpPaperComposition({ ...f.ports, master: { providerId: event.providerId, read: async () => event } });
    await expect(service.copyMint(scope, { subscriptionId, eventId: event.eventId, assetScale: 18 })).rejects.toThrow();
    expect(runtimeWrites(f)).toEqual([]);
  });
  it.each(['missing', 'approval', 'revision', 'provider'] as const)('canonical copy rejects %s independently protected risk backing', async kind => {
    const f = fixture(), event = { providerId: 'protected-master', eventId: 'owned-mint', chain: 'solana' as const,
      networkId: f.ports.binding.networkId, protocol: 'meteora-dlmm' as const, masterWalletAddress: 'solana:master',
      masterPositionId: 'solana:master-position', poolAddress: 'solana:pool', depositAsset: 'solana:asset',
      action: 'mint' as const, finality: 'finalized' as const, provenance: 'injected-mint-event' as const,
      openedAt: f.q.observedAt, observedAt: f.q.observedAt, masterDepositMicroUsd: '100000000', strategy: f.request.strategy };
    const copyRequest = { ...f.request, operationKey: `copy-${lpExactHash([userId, subscriptionId, event.eventId])}`,
      deposit: { raw: '100000000000000000000', scale: 18 } };
    const origin = { subscriptionId, subscriptionRevision: f.subscription.revision, eventId: event.eventId,
      masterWalletAddress: event.masterWalletAddress, masterPositionId: event.masterPositionId, masterEvidenceHash: lpExactHash(event),
      masterDepositMicroUsd: event.masterDepositMicroUsd, budgetMicroUsd: '100000000' };
    const probe: LpPaperQuote = { ...f.q, quoteId: 'owned-probe', intentHash: lpExactHash(['copy-price', subscriptionId, event.eventId]),
      deposit: { raw: '1000000000000000000', scale: 18 }, amountAfter: { raw: '1000000000000000000', scale: 18 }, valueMicroUsd: '1000000' };
    const follower: LpPaperQuote = { ...f.q, quoteId: 'owned-follower', intentHash: lpAcquisitionHash(copyRequest, origin),
      deposit: copyRequest.deposit, amountAfter: copyRequest.deposit, valueMicroUsd: '100000000' };
    const risk = { providerId: 'protected-risk', userId, subscriptionId, subscriptionRevision: f.subscription.revision,
      masterEvidenceHash: origin.masterEvidenceHash, intentHash: follower.intentHash, poolEvidenceId: follower.pool.evidenceId,
      approved: true, observedAt: f.q.observedAt };
    f.seed('master', event.eventId, event); f.seed('quote', probe.quoteId, probe); f.seed('quote', follower.quoteId, follower);
    if (kind !== 'missing') f.seed('risk', follower.intentHash, kind === 'approval' ? { ...risk, approved: false }
      : kind === 'revision' ? { ...risk, subscriptionRevision: 'foreign' } : { ...risk, providerId: 'foreign' });
    // Provider scripts do not insert/certify protected records: every expectation above is
    // installed before invoking the actual canonical copy body.
    const originalQuery = f.runtimeClient.query.bind(f.runtimeClient);
    f.runtimeClient.query = (async (sql: string, values?: unknown[]) => sql.includes('AS count FROM lp_copy_executions') ? { rows: [{ count: '0' }] }
      : sql.includes('AS spent FROM lp_exact_positions') ? { rows: [{ spent: '0' }] } : originalQuery(sql, values)) as never;
    const service = createOwnedLpPaperComposition({ ...f.ports,
      master: { providerId: event.providerId, read: async () => event }, copyRisk: { providerId: risk.providerId, assess: async () => risk },
      protocol: { ...f.ports.protocol, quote: async input => lpSnapshot(input.intentHash === probe.intentHash ? probe : follower) } });
    await expect(service.copyMint(scope, { subscriptionId, eventId: event.eventId, assetScale: 18 })).rejects.toThrow(/protected|admitted/);
    expect(f.state.protectedReads.some(k => k.startsWith('risk:'))).toBe(true); expect(runtimeWrites(f)).toEqual([]);
  });
  it('foreign scope and changed constructor provider/network cannot widen the factory', async () => {
    const f = fixture(); await expect(f.service.acquire({ userId: subscriptionId } as UserScope, f.request)).rejects.toThrow('foreign');
    expect(() => createOwnedLpPaperComposition({ ...f.ports, protocol: { ...f.ports.protocol, providerId: 'attacker' } })).toThrow('identities mismatch');
    expect(f.state.queries).toEqual([]);
  });
  it('bounded observer refuses overflow rather than weakening ONE-CLOSE with a sampled journal', async () => {
    const f = fixture(); await f.service.acquire(scope, f.request); f.state.historyOverflow = true;
    await expect(lpDurableHistorySqlObserver(f.runtime, 1)(scope, positionId)).rejects.toThrow('complete bound');
    const accepted = readFileSync(new URL('./lp-copy-observer.ts', import.meta.url), 'utf8');
    expect(accepted).toContain('rows.rows.length <= 1'); expect(accepted).toContain('LIMIT 2');
  });
});

describe('LP source owned integration graph containment, authored only until coordinator freeze', () => {
  it('loads actual leaf API with PG constructors trapped and no ambient or stale dist source', async () => {
    const script = `
      import { createRequire } from 'node:module';
      import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os'; import { join, resolve } from 'node:path';
      const require = createRequire(import.meta.url); const pg = require(require.resolve('pg', { paths: ['./packages/db'] }));
      let constructors = 0; const trap = name => class { constructor() { constructors++; throw new Error('Forbidden PG ' + name); } };
      pg.Pool = trap('Pool'); pg.Client = trap('Client');
      const temp = mkdtempSync(join(tmpdir(), 'swat-lp-owned-source-'));
      try {
        const config = join(temp, 'tsconfig.json'); writeFileSync(config, JSON.stringify({ compilerOptions: { baseUrl: resolve('.'), paths: {
          '@swat/db/dist/*.js': ['packages/db/src/*.ts'], '@swat/shared': ['packages/shared/src/index.ts'] } } }));
        process.env.TSX_TSCONFIG_PATH = config; const { tsImport } = await import('tsx/esm/api'); const loaded = new Set();
        const load = path => tsImport(path, { parentURL: import.meta.url, tsconfig: config, onImport: url => loaded.add(new URL(url).pathname) });
        const api = await load('./tests/qualification/wave4/lp-owned-composition.ts');
        const observer = await load('./tests/qualification/wave4/lp-durable-history-observer.ts');
        if (typeof api.createOwnedLpPaperComposition !== 'function' || typeof observer.lpDurableHistorySqlObserver !== 'function') throw new Error('Missing actual LP APIs');
        let refused = false; try { api.createOwnedLpPaperComposition({}); } catch (e) { refused = String(e).includes('distinct owned'); }
        if (!refused) throw new Error('Missing owned inputs accepted');
        for (const name of ['lp-paper-owned.ts','lp-paper-service.ts','lp-paper-store.ts','lp-paper-admission-store.ts','lp-paper-admission-contract.ts','lp-exact.ts']) {
          if (!loaded.has(resolve('packages/db/src', name))) throw new Error('Actual source leaf missing ' + name);
        }
        const forbidden = ['index.ts','client.ts','transaction.ts','tenancy.ts','lp-copy-trading.ts'].map(n => resolve('packages/db/src', n));
        if ([...loaded].some(p => forbidden.includes(p) || p.startsWith(resolve('packages/db/dist') + '/'))) throw new Error('Ambient/stale source graph');
        if (constructors !== 0) throw new Error('Owned graph constructed PG');
        let control = false; try { await load('./packages/db/src/lp-copy-trading.ts'); } catch (e) { control = String(e).includes('Forbidden PG Pool'); }
        if (!control || constructors !== 1) throw new Error('Real ambient positive control failed');
        console.log(JSON.stringify({ ownedConstructors: 0, control, runtimeAccepted: false }));
      } finally { rmSync(temp, { recursive: true, force: true }); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module','--eval',script], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)), timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgres://swat_app:offline@127.0.0.1:1/offline', DATABASE_READ_URL: '' } });
    expect(JSON.parse(stdout.trim())).toEqual({ ownedConstructors: 0, control: true, runtimeAccepted: false });
  }, 35000);
});
