import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { UserScope } from '../../../packages/db/src/tenancy.js';
import {
  lpAcquisitionHash, lpExactHash, lpSnapshot, type LpExactPosition, type LpExactOperation,
  type LpExactAcquisitionRequest, type LpExactPlan, type LpPaperQuote, type LpPaperReceipt
} from '../../../packages/db/src/lp-exact.js';
import {
  createLpPaperService, lpOperationIntent, lpResultAfterReceipt, type LpAcquisitionCommit,
  type LpOperationCommit, type LpInjectedProtocolPort
} from '../../../packages/db/src/lp-paper-service.js';
import {
  lpAdmissionQuoteInput, lpAdmissionContextKey, lpProjectProtectedPosition, requireLpQuoteContext, requireLpSettlementContext,
  type LpProtectedQuoteAdmission, type LpProtectedSettlementAdmission, type LpQuoteAdmissionContext
} from '../../../packages/db/src/lp-paper-admission-contract.js';
import {
  createLpPaperAdmissionWriter, lpPaperAdmissionLookup, type LpAdmitterTransaction, type LpTrustedAdmissionSource
} from '../../../packages/db/src/lp-paper-admission-store.js';
import { createLpPaperSqlStore, type LpTenantTransaction } from '../../../packages/db/src/lp-paper-store.js';
type PoolClient = Parameters<Parameters<LpTenantTransaction>[1]>[0];

const userId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const quoteAdmissionId = '44444444-4444-4444-8444-444444444444';
const settlementId = '55555555-5555-4555-8555-555555555555';
const scope = { userId } as UserScope;
const t = (n: number) => new Date(Date.UTC(2026, 10, 18, 0, 0, n)).toISOString();
function fixture() {
  const deposit = { raw: '900719925474099312345', scale: 18 };
  const request: LpExactAcquisitionRequest = { operationKey: 'acquire', chain: 'solana', poolAddress: 'solana:pool',
    depositAsset: 'solana:asset', deposit, strategy: { distribution: 'spot', rangeLower: 90, rangeUpper: 110, rungCount: 1 }, autoRebalance: false };
  const plan: LpExactPlan = { version: 2, protocol: 'meteora-dlmm', strategy: request.strategy, poolEvidenceId: 'pool',
    rungs: [{ priceLower: 90, priceUpper: 110, allocation: deposit, binLower: -1, binUpper: 1 }] };
  const acquisitionQuote: LpPaperQuote = { version: 1, providerId: 'independent-provider', quoteId: 'acquire-quote', userId,
    intentHash: lpAcquisitionHash(request), action: 'acquire', mode: 'paper',
    pool: { chain: 'solana', protocol: 'meteora-dlmm', networkId: 'solana:offline', poolAddress: 'solana:pool', depositAsset: 'solana:asset',
      depositScale: 18, evidenceId: 'pool', observedAt: t(0), currentPrice: 100, binStep: 10, tickSpacing: null },
    deposit, unitPriceUsd: { raw: '1000000', scale: 6 }, valueMicroUsd: '900719925', amountAfter: deposit,
    proceedsMicroUsd: '0', observedAt: t(0), expiresAt: t(30), economics: null };
  const acquisition: LpAcquisitionCommit = { request, fingerprint: acquisitionQuote.intentHash, quote: acquisitionQuote, plan, origin: null };
  const position: LpExactPosition = { id: positionId, userId, chain: 'solana', protocol: 'meteora-dlmm', poolAddress: 'solana:pool',
    depositAsset: 'solana:asset', acquisitionKey: request.operationKey, acquisitionFingerprint: acquisition.fingerprint,
    acquisitionQuote, copyOrigin: null, deposit, depositMicroUsd: acquisitionQuote.valueMicroUsd, mode: 'paper', currentAmount: deposit,
    plan, revision: '0', state: 'active', autoRebalance: false, cumulativeFeesMicroUsd: '100', cumulativeCostsMicroUsd: '50',
    realizedMicroUsd: null, lastReceiptKey: null };
  const quote: LpPaperQuote = { ...acquisitionQuote, action: 'close', quoteId: 'close-quote',
    intentHash: lpOperationIntent(position, 'close'), amountAfter: { raw: '0', scale: 18 }, proceedsMicroUsd: '900719925' };
  const commit: LpOperationCommit = { position, operationKey: 'close', fingerprint: quote.intentHash, action: 'close', quote, plan: null,
    receiptKey: `lp-receipt-${lpExactHash([userId, 'close', quote.intentHash])}` };
  const operation: LpExactOperation = { id: operationId, userId, positionId, operationKey: commit.operationKey,
    fingerprint: commit.fingerprint, action: 'close', positionRevision: '0', amountBefore: deposit, quote, plan: null,
    receiptKey: commit.receiptKey, status: 'pending', receipt: null };
  const receipt: LpPaperReceipt = { version: 1, providerId: quote.providerId, receiptId: 'settlement', receiptKey: operation.receiptKey,
    userId, positionId, positionRevision: '0', mode: 'paper', action: 'close', networkId: quote.pool.networkId,
    chain: 'solana', protocol: 'meteora-dlmm', poolAddress: position.poolAddress, depositAsset: position.depositAsset,
    quoteId: quote.quoteId, quoteHash: lpExactHash(quote), amountBefore: deposit, amountAfter: quote.amountAfter,
    proceedsMicroUsd: quote.proceedsMicroUsd, collectedFeesMicroUsd: '100000', executionCostsMicroUsd: '50000', settledAt: t(10), finality: 'paper-settled' };
  const context: LpQuoteAdmissionContext = { kind: 'operation', commit: lpSnapshot(commit) };
  const admittedQuote: LpProtectedQuoteAdmission = { id: quoteAdmissionId, userId, input: lpAdmissionQuoteInput(userId, context),
    quote: lpSnapshot(quote), quoteHash: lpExactHash(quote), contextKey: lpAdmissionContextKey(context), context, admittedAt: t(1) };
  const admittedSettlement: LpProtectedSettlementAdmission = { id: settlementId, quoteAdmissionId, operationId, userId, positionId,
    positionRevision: '0', receipt: lpSnapshot(receipt), context: { operation: lpSnapshot(operation), position: lpSnapshot(position), operationCreatedAt: t(2) },
    admittedAt: t(11) };
  const acquisitionContext: LpQuoteAdmissionContext = { kind: 'acquisition', commit: lpSnapshot(acquisition) };
  const admittedAcquisition: LpProtectedQuoteAdmission = { id: quoteAdmissionId, userId, input: lpAdmissionQuoteInput(userId, acquisitionContext),
    quote: lpSnapshot(acquisitionQuote), quoteHash: lpExactHash(acquisitionQuote), contextKey: lpAdmissionContextKey(acquisitionContext),
    context: acquisitionContext, admittedAt: t(1) };
  const protocol: LpInjectedProtocolPort = { providerId: quote.providerId, networks: { solana: quote.pool.networkId },
    quote: async input => lpSnapshot(input.action === 'acquire' ? acquisitionQuote : quote), receipt: async () => lpSnapshot(receipt) };
  return { request, acquisition, acquisitionContext, admittedAcquisition, position, commit, operation, quote, receipt,
    context, admittedQuote, admittedSettlement, protocol };
}
type Fixture = ReturnType<typeof fixture>;
/** Explicit preexisting admissions, never candidate-certification. This is not a PostgreSQL/RLS emulator. */
function db(f: Fixture) {
  const state = {
    q: lpSnapshot(f.admittedQuote) as LpProtectedQuoteAdmission | null,
    s: lpSnapshot(f.admittedSettlement) as LpProtectedSettlementAdmission | null,
    p: lpSnapshot(f.position) as LpExactPosition | null,
    op: lpSnapshot(f.operation) as LpExactOperation | null,
    now: t(12), created: t(2), allowed: true, owner: true, priorAcquisition: null as LpExactPosition | null,
    legacyState: null as LpExactPosition['state'] | null, legacyConsent: null as boolean | null,
    conflict: false, commitFailure: false, calls: [] as string[], writes: [] as string[], commits: 0
  };
  const quoteRow = () => state.q && ({ id: state.q.id, user_id: state.q.userId, input: state.q.input, quote: state.q.quote,
    context: state.q.context, context_key: state.q.contextKey, quote_hash: state.q.quoteHash, admitted_at: state.q.admittedAt });
  const settlementRow = () => state.s && ({ id: state.s.id, user_id: state.s.userId, quote_admission_id: state.s.quoteAdmissionId,
    operation_id: state.s.operationId, position_id: state.s.positionId, position_revision: state.s.positionRevision,
    receipt: state.s.receipt, context: state.s.context, admitted_at: state.s.admittedAt });
  const client = { query: async (sql: string, values: unknown[] = []) => {
    state.calls.push(sql);
    let rows: unknown[] = [];
    if (/^(INSERT|UPDATE)/.test(sql)) state.writes.push(sql);
    if (sql.includes('lp-admission:clock')) rows = [{ now: state.now }];
    else if (sql.includes('lp-admission:restricted')) rows = [{ allowed: state.allowed }];
    else if (sql.includes('lp-admission:operation-time')) rows = state.op ? [{ created_at: state.created }] : [];
    else if (sql.includes('lp-admission:quote')) rows = quoteRow() ? [quoteRow()] : [];
    else if (sql.includes('lp-admission:settlement')) rows = settlementRow() ? [settlementRow()] : [];
    else if (sql.includes('lp-admission:write-quote')) rows = !state.conflict && quoteRow() ? [quoteRow()] : [];
    else if (sql.includes('lp-admission:write-settlement')) rows = !state.conflict && settlementRow() ? [settlementRow()] : [];
    else if (sql.startsWith('SELECT id FROM users')) rows = state.owner ? [{ id: userId }] : [];
    else if (sql.includes('lp_exact_positions e')) {
      const p = sql.includes('acquisition_key') ? state.priorAcquisition : state.p;
      rows = p ? [{ data: lpSnapshot(p), acquisition_data: lpSnapshot(p), state: state.legacyState ?? p.state, auto_rebalance: state.legacyConsent ?? p.autoRebalance }] : [];
    } else if (sql.startsWith('SELECT data FROM lp_exact_operations')) {
      const op = state.op;
      rows = op && (!sql.includes('operation_key') || values[1] === op.operationKey) ? [{ data: lpSnapshot(op) }] : [];
    } else if (sql.includes('max_pool_allocation_pct')) rows = [{ cap: '100.00' }];
    else if (sql.includes('AS unassessed')) rows = [{ total: '0', pool: '0', unassessed: '0' }];
    else if (sql.includes('gen_random_uuid')) rows = [{ id: operationId }];
    else if (sql.startsWith('INSERT INTO lp_positions')) rows = [{ id: positionId }];
    else if (sql.startsWith('INSERT INTO lp_exact_positions')) state.p = JSON.parse(values[5] as string);
    else if (sql.startsWith('INSERT INTO lp_exact_operations')) state.op = JSON.parse(values[5] as string);
    else if (sql.startsWith('UPDATE lp_exact_operations')) state.op = JSON.parse(values[2] as string);
    else if (sql.startsWith('UPDATE lp_exact_positions')) state.p = JSON.parse(values[2] as string);
    return { rows };
  } } as unknown as PoolClient;
  const run: LpTenantTransaction = async (_scope, action) => {
    const prior = { p: lpSnapshot(state.p), op: lpSnapshot(state.op), writes: state.writes.length };
    try {
      const output = await action(client);
      if (state.commitFailure) throw new Error('checked commit failed');
      state.commits++; return output;
    } catch (error) { state.p = prior.p; state.op = prior.op; throw error; }
  };
  return { state, client, run, store: createLpPaperSqlStore(run) };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
function trusted(f: Fixture): Mutable<LpTrustedAdmissionSource> {
  return { protocol: f.protocol, quoteContext: async () => lpSnapshot(f.context),
    settlementContext: async () => lpSnapshot(f.admittedSettlement.context!) };
}

describe('Wave4 protected LP source boundary; offline only', () => {
  it('requires owned client and a separate writer transaction with trusted callbacks; no ambient fallback', async () => {
    expect(() => createLpPaperAdmissionWriter(undefined as never, trusted(fixture()))).toThrow('separate transaction');
    expect(() => createLpPaperAdmissionWriter(async () => null as never, {} as never)).toThrow('trusted source');
    await expect(lpPaperAdmissionLookup.now(undefined as never)).rejects.toThrow('owned transaction client');
  });
  it('compares full preexisting record equality, returns detached records and executes only SELECT', async () => {
    const f = fixture(), d = db(f);
    const result = await lpPaperAdmissionLookup.settlement(d.client, f.operation, f.position, f.receipt);
    expect(result).toEqual(f.admittedSettlement); expect(result).not.toBe(d.state.s);
    expect(result.receipt).not.toBe(d.state.s!.receipt); expect(d.state.writes).toEqual([]);
    expect(d.state.calls.every(sql => sql.startsWith('SELECT'))).toBe(true);
  });
  it.each(['fees', 'costs', 'proceeds', 'quoteHash', 'provider', 'network'] as const)('rejects hostile %s despite a freshly recomputed hash', async field => {
    const f = fixture(), d = db(f), r: Mutable<LpPaperReceipt> = { ...f.receipt };
    if (field === 'fees') r.collectedFeesMicroUsd = '999999999';
    if (field === 'costs') r.executionCostsMicroUsd = '0';
    if (field === 'proceeds') r.proceedsMicroUsd = '999999999';
    if (field === 'quoteHash') r.quoteHash = '0'.repeat(64);
    if (field === 'provider') r.providerId = 'attacker';
    if (field === 'network') r.networkId = 'attacker';
    expect(lpExactHash(r)).toMatch(/^[a-f0-9]{64}$/);
    await expect(d.store.transaction(scope, tx => tx.settle(f.operation, f.position, r))).rejects.toThrow('complete settlement');
    expect(d.state.writes).toEqual([]);
  });
  it.each(['tenant', 'revision', 'context', 'missing-context', 'future', 'expired', 'null-economics', 'stored-hash', 'context-key'] as const)('refuses %s protected quote record before operation writes', async field => {
    const f = fixture(), d = db(f), q: Mutable<LpProtectedQuoteAdmission> = lpSnapshot(f.admittedQuote);
    if (field === 'tenant') q.userId = settlementId;
    if (field === 'revision') q.input = { ...q.input, positionRevision: '1' };
    if (field === 'context') q.context = { kind: 'operation', commit: { ...f.commit, receiptKey: 'hostile' } };
    if (field === 'missing-context') delete (q as { context?: unknown }).context;
    if (field === 'future') q.admittedAt = t(20);
    if (field === 'expired') d.state.now = t(31);
    if (field === 'stored-hash') q.quoteHash = '0'.repeat(64);
    if (field === 'context-key') q.contextKey = 'operation:hostile';
    if (field === 'null-economics') q.quote = { ...q.quote, economics: undefined as never };
    d.state.q = q;
    await expect(d.store.transaction(scope, tx => tx.insertOperation(f.commit))).rejects.toThrow();
    expect(d.state.writes).toEqual([]);
  });
  it.each(['position', 'operation', 'revision', 'chronology', 'future', 'missing-context'] as const)('refuses %s settlement source binding before receipt INSERT', async field => {
    const f = fixture(), d = db(f), s: Mutable<LpProtectedSettlementAdmission> = lpSnapshot(f.admittedSettlement);
    if (field === 'position') s.positionId = settlementId;
    if (field === 'operation') s.operationId = settlementId;
    if (field === 'revision') s.positionRevision = '1';
    if (field === 'chronology') s.context = { ...s.context!, operationCreatedAt: t(0) };
    if (field === 'future') s.admittedAt = t(20);
    if (field === 'missing-context') delete (s as { context?: unknown }).context;
    d.state.s = s;
    await expect(d.store.transaction(scope, tx => tx.settle(f.operation, f.position, f.receipt))).rejects.toThrow();
    expect(d.state.writes).toEqual([]);
  });
  it.each(['acquisition', 'operation', 'settlement'] as const)('cold SQL %s with no admission fails closed before every write', async kind => {
    const f = fixture(), d = db(f); d.state.q = null; d.state.s = null;
    const result = d.store.transaction<LpExactPosition | LpExactOperation>(scope, async tx => kind === 'acquisition' ? tx.insertAcquisition(f.acquisition)
      : kind === 'operation' ? tx.insertOperation(f.commit) : tx.settle(f.operation, f.position, f.receipt));
    await expect(result).rejects.toThrow('stored quote unavailable'); expect(d.state.writes).toEqual([]);
    expect(d.state.calls[0]).toContain('users WHERE id=$1 FOR UPDATE'); expect(d.state.commits).toBe(0);
  });
  it('quote alone is not a settlement admission and cannot insert a receipt', async () => {
    const f = fixture(), d = db(f); d.state.s = null;
    await expect(d.store.transaction(scope, tx => tx.settle(f.operation, f.position, f.receipt))).rejects.toThrow('stored settlement unavailable');
    expect(d.state.writes).toEqual([]);
  });
  it('locks and verifies current position/operation rather than trusting a stale caller snapshot', async () => {
    const f = fixture(), d = db(f); d.state.p = { ...f.position, revision: '1' };
    await expect(d.store.transaction(scope, tx => tx.insertOperation(f.commit))).rejects.toThrow('current operation context');
    await expect(d.store.transaction(scope, tx => tx.settle(f.operation, f.position, f.receipt))).rejects.toThrow('canonical settlement context');
    expect(d.state.writes).toEqual([]);
  });
  it('requires exact acquisition context, not a matching admitted valuation alone', async () => {
    const f = fixture(), d = db(f); d.state.q = f.admittedAcquisition;
    const c = { ...f.acquisition, request: { ...f.request, operationKey: 'changed' } };
    await expect(d.store.transaction(scope, tx => tx.insertAcquisition(c))).rejects.toThrow('context');
    expect(d.state.writes).toEqual([]);
  });
  it('receipt is first write; completion and exact numeric economics use the same owner-locked client', async () => {
    const f = fixture(), d = db(f);
    const done = await d.store.transaction(scope, tx => tx.settle(f.operation, f.position, f.receipt));
    expect(done.status).toBe('completed'); expect(d.state.p).toEqual(lpResultAfterReceipt(f.position, f.operation, f.receipt));
    expect(d.state.p!.realizedMicroUsd).toBe('50050');
    expect(d.state.writes[0]).toContain('INSERT INTO lp_exact_receipts');
    expect(d.state.writes[1]).toContain('UPDATE lp_exact_operations');
    expect(d.state.writes[2]).toContain('UPDATE lp_exact_positions');
    expect(d.state.commits).toBe(1);
    await expect(d.store.transaction(scope, tx => tx.settle(f.operation, f.position, f.receipt))).rejects.toThrow('canonical settlement context');
    expect(d.state.writes.filter(sql => sql.includes('INSERT INTO lp_exact_receipts'))).toHaveLength(1);
  });
  it('does not return success when the owned transaction COMMIT fails', async () => {
    const f = fixture(), d = db(f); d.state.commitFailure = true;
    await expect(d.store.transaction(scope, tx => tx.settle(f.operation, f.position, f.receipt))).rejects.toThrow('checked commit failed');
    expect(d.state.p).toEqual(f.position); expect(d.state.op).toEqual(f.operation); expect(d.state.commits).toBe(0);
  });
  it.each(['role', 'tenant', 'missing-source', 'wrong-provider', 'wrong-network', 'mutated-context'] as const)('restricted writer refuses %s without admission INSERT', async kind => {
    const f = fixture(), d = db(f), source = trusted(f);
    if (kind === 'role' || kind === 'tenant') d.state.allowed = false;
    if (kind === 'missing-source') source.quoteContext = async () => null;
    if (kind === 'wrong-provider') source.protocol = { ...f.protocol, providerId: 'attacker' };
    if (kind === 'wrong-network') source.protocol = { ...f.protocol, networks: { solana: 'attacker' } };
    if (kind === 'mutated-context') source.quoteContext = async () => ({ kind: 'operation', commit: { ...f.commit, fingerprint: '0'.repeat(64) } });
    const writer = createLpPaperAdmissionWriter(d.run as LpAdmitterTransaction, source);
    await expect(writer.quote(scope, 'trusted-source-selector')).rejects.toThrow(); expect(d.state.writes).toEqual([]);
  });
  it('writer lookup on replay compares the existing full independent receipt rather than overwriting hostile fees', async () => {
    const f = fixture(), d = db(f); d.state.conflict = true;
    const source = trusted(f); source.protocol = { ...f.protocol, receipt: async () => ({ ...f.receipt, collectedFeesMicroUsd: '999999999' }) };
    const writer = createLpPaperAdmissionWriter(d.run as LpAdmitterTransaction, source);
    await expect(writer.settlement(scope, operationId)).rejects.toThrow('complete settlement');
    expect(d.state.writes).toHaveLength(1); expect(d.state.writes[0]).toContain('DO NOTHING');
    expect(d.state.s).toEqual(f.admittedSettlement); expect(d.state.commits).toBe(0);
  });
  it('restricted writer rejects a stale revision and operation chronology from its trusted context before INSERT', async () => {
    const f = fixture(), d = db(f), source = trusted(f);
    source.settlementContext = async () => ({ ...f.admittedSettlement.context!, operationCreatedAt: t(0) });
    await expect(createLpPaperAdmissionWriter(d.run, source).settlement(scope, operationId)).rejects.toThrow('chronology');
    expect(d.state.writes).toEqual([]);
    source.quoteContext = async () => ({ kind: 'operation', commit: { ...f.commit, position: { ...f.position, revision: '1' } } });
    await expect(createLpPaperAdmissionWriter(d.run, source).quote(scope, 'trusted-selector')).rejects.toThrow('context');
    expect(d.state.writes).toEqual([]);
  });
  it('restricted writer replay is append-only and preserves a preexisting equal quote record', async () => {
    const f = fixture(), d = db(f); d.state.conflict = true;
    const writer = createLpPaperAdmissionWriter(d.run, trusted(f));
    expect(await writer.quote(scope, 'trusted-selector')).toEqual(f.admittedQuote);
    expect(d.state.q).toEqual(f.admittedQuote); expect(d.state.writes).toHaveLength(1);
    expect(d.state.writes[0]).toContain('DO NOTHING'); expect(d.state.writes[0]).not.toContain('DO UPDATE');
  });
  it('restricted writer uses DB-returned times and full source context; no caller admittedAt argument', async () => {
    const f = fixture(), d = db(f);
    const writer = createLpPaperAdmissionWriter(d.run as LpAdmitterTransaction, trusted(f));
    expect(await writer.quote(scope, 'trusted-source-selector')).toEqual(f.admittedQuote);
    const insert = d.state.writes[0]!;
    expect(insert).not.toContain('admitted_at'); expect(insert).toContain('quote_hash');
    expect(insert).toContain('context'); expect(insert).toContain('DO NOTHING');
  });
  it('keeps full context guards mandatory for SQL while older comparison-only callers cannot certify candidates', () => {
    const f = fixture();
    expect(() => requireLpQuoteContext({ ...f.admittedQuote, context: undefined }, f.context)).toThrow('context');
    const context = { ...f.admittedSettlement.context!, operationCreatedAt: t(0) };
    expect(() => requireLpSettlementContext({ ...f.admittedSettlement, context }, f.admittedQuote,
      context)).toThrow('chronology');
  });
});

describe('repaired context identities and current-position projection; offline only', () => {
  it('admits distinct acquisition operation keys with the same economic intent, with exact independent context and replay', async () => {
    const f = fixture();
    const second: LpAcquisitionCommit = { ...f.acquisition, request: { ...f.request, operationKey: 'acquire-second' } };
    expect(lpAcquisitionHash(second.request)).toBe(f.acquisition.fingerprint);
    const secondContext: LpQuoteAdmissionContext = { kind: 'acquisition', commit: second };
    expect(lpAdmissionContextKey(secondContext)).not.toBe(lpAdmissionContextKey(f.acquisitionContext));
    for (const context of [f.acquisitionContext, secondContext]) {
      const d = db(f), q = context.commit.quote;
      d.state.q = { ...f.admittedAcquisition, quote: q, quoteHash: lpExactHash(q), input: lpAdmissionQuoteInput(userId, context),
        context, contextKey: lpAdmissionContextKey(context) };
      const source = trusted(f); source.quoteContext = async () => lpSnapshot(context);
      source.protocol = { ...f.protocol, quote: async () => lpSnapshot(q) };
      const writer = createLpPaperAdmissionWriter(d.run, source);
      expect((await writer.quote(scope, 'independent-selector')).contextKey).toBe(lpAdmissionContextKey(context));
      d.state.conflict = true;
      expect((await writer.quote(scope, 'independent-selector')).context).toEqual(context);
      expect(d.state.writes[0]).toContain('ON CONFLICT(user_id,context_key)');
      expect(await d.store.transaction(scope, tx => tx.insertAcquisition(context.kind === 'acquisition' ? context.commit : f.acquisition)))
        .toMatchObject({ acquisitionKey: context.kind === 'acquisition' ? context.commit.request.operationKey : '' });
    }
    const d = db(f); d.state.q = f.admittedAcquisition;
    await expect(lpPaperAdmissionLookup.quote(d.client, userId, secondContext)).rejects.toThrow();
    expect(d.state.writes).toEqual([]);
  });
  it('uses legacy near-edge state and opted-in consent as the canonical full operation/settlement context', async () => {
    const f = fixture(), d = db(f); d.state.legacyState = 'near_edge'; d.state.legacyConsent = true;
    const projected = lpProjectProtectedPosition(f.position, 'near_edge', true);
    const context: LpQuoteAdmissionContext = { kind: 'operation', commit: { ...f.commit, position: projected } };
    d.state.q = { ...f.admittedQuote, context };
    d.state.s = { ...f.admittedSettlement, context: { ...f.admittedSettlement.context!, position: projected } };
    expect(await d.store.transaction(scope, tx => tx.position(positionId))).toEqual(projected);
    expect((await d.store.transaction(scope, tx => tx.insertOperation({ ...f.commit, position: projected }))).status).toBe('pending');
    d.state.writes.length = 0;
    expect((await d.store.transaction(scope, tx => tx.settle(f.operation, projected, f.receipt))).status).toBe('completed');
    expect(d.state.p!.autoRebalance).toBe(true);
    expect(d.state.writes[0]).toContain('INSERT INTO lp_exact_receipts');
  });
  it('rejects stale raw JSON contexts and legacy consent changes after protected admission before writes', async () => {
    const f = fixture(), d = db(f); d.state.legacyState = 'near_edge'; d.state.legacyConsent = true;
    const projected = lpProjectProtectedPosition(f.position, 'near_edge', true);
    await expect(d.store.transaction(scope, tx => tx.insertOperation({ ...f.commit, position: projected }))).rejects.toThrow('context');
    await expect(d.store.transaction(scope, tx => tx.settle(f.operation, projected, f.receipt))).rejects.toThrow('context');
    expect(d.state.writes).toEqual([]);
  });
  it('never reopens closed exact inventory through a legacy active-state overlay', async () => {
    const f = fixture(), d = db(f);
    d.state.p = lpResultAfterReceipt(f.position, f.operation, f.receipt); d.state.legacyState = 'active';
    await expect(d.store.transaction(scope, tx => tx.position(positionId))).rejects.toThrow('cannot reopen');
    expect(d.state.writes).toEqual([]);
  });
  it('rejects explicit null chronology in trusted settlement context before admission writes', async () => {
    const f = fixture(), d = db(f), source = trusted(f);
    source.settlementContext = async () => ({ ...f.admittedSettlement.context!, operationCreatedAt: null as never });
    await expect(createLpPaperAdmissionWriter(d.run, source).settlement(scope, operationId)).rejects.toThrow();
    expect(d.state.writes).toEqual([]);
  });
  it('does not coerce NULL database chronology into the Unix epoch', async () => {
    const f = fixture(), d = db(f);
    d.state.now = null as never;
    await expect(lpPaperAdmissionLookup.now(d.client)).rejects.toThrow('database clock unavailable');
    d.state.now = t(12); d.state.created = null as never;
    await expect(lpPaperAdmissionLookup.settlement(d.client, f.operation, f.position, f.receipt)).rejects.toThrow('chronology');
    expect(d.state.writes).toEqual([]);
  });
  it('refreshes legacy rung allocations and strategy alongside an admitted rebalance plan', async () => {
    const f = fixture(), d = db(f);
    const quote: LpPaperQuote = { ...f.quote, action: 'rebalance', intentHash: lpOperationIntent(f.position, 'rebalance'),
      amountAfter: f.position.currentAmount, proceedsMicroUsd: '0', economics: { basis: 'incremental-rebalance', windowStart: t(0),
        windowEnd: t(30), extraFeesMicroUsd: '100000', inventoryChangeMicroUsd: '0', impermanentLossMicroUsd: '0', gasMicroUsd: '0', repositionMicroUsd: '0' } };
    const plan = { ...f.position.plan, strategy: { ...f.position.plan.strategy, rangeLower: 95, rangeUpper: 115 },
      rungs: [{ ...f.position.plan.rungs[0]!, priceLower: 95, priceUpper: 115 }] };
    const op: LpExactOperation = { ...f.operation, action: 'rebalance', fingerprint: quote.intentHash, quote, plan };
    const receipt: LpPaperReceipt = { ...f.receipt, action: 'rebalance', quoteHash: lpExactHash(quote), amountAfter: quote.amountAfter, proceedsMicroUsd: '0' };
    const context: LpQuoteAdmissionContext = { kind: 'operation', commit: { ...f.commit, action: 'rebalance', fingerprint: quote.intentHash, quote, plan } };
    d.state.op = op;
    d.state.q = { ...f.admittedQuote, quote, quoteHash: lpExactHash(quote), input: lpAdmissionQuoteInput(userId, context), context };
    d.state.s = { ...f.admittedSettlement, receipt, context: { ...f.admittedSettlement.context!, operation: op } };
    await d.store.transaction(scope, tx => tx.settle(op, f.position, receipt));
    expect(d.state.writes.find(sql => sql.startsWith('UPDATE lp_positions'))).toContain('rung_allocations=$6::jsonb,strategy_type=$7');
  });
});

describe('strict service atop protected production SQL store', () => {
  function service(f: Fixture, d: ReturnType<typeof db>) {
    return createLpPaperService({ store: d.store, protocol: f.protocol, mode: async () => 'paper', now: () => new Date(t(12)),
      plan: async () => f.acquisition.plan });
  }
  it('a valid injected acquisition quote is not admission; service refuses before financial writes', async () => {
    const f = fixture(), d = db(f); d.state.q = null;
    await expect(service(f, d).acquire(scope, f.request)).rejects.toThrow('stored quote unavailable'); expect(d.state.writes).toEqual([]);
  });
  it('valid injected close quote cannot create a canonical operation without independent admission', async () => {
    const f = fixture(), d = db(f); d.state.q = null; d.state.op = null;
    await expect(service(f, d).requestOperation(scope, { positionId, operationKey: 'close', action: 'close' })).rejects.toThrow('stored quote unavailable');
    expect(d.state.writes).toEqual([]);
  });
  it('valid provider receipt is not authority without independently persisted actual fees/costs', async () => {
    const f = fixture(), d = db(f); d.state.s = null;
    await expect(service(f, d).process(scope, { operationId, chain: 'solana' })).rejects.toThrow('stored settlement unavailable'); expect(d.state.writes).toEqual([]);
  });
  it('preserves completed service replay without provider calls or repeat mutation', async () => {
    const f = fixture(), d = db(f); const done = { ...f.operation, status: 'completed' as const, receipt: f.receipt };
    d.state.op = done; d.state.p = lpResultAfterReceipt(f.position, f.operation, f.receipt); d.state.q = null; d.state.s = null;
    f.protocol.receipt = async () => { throw new Error('provider must not be called'); };
    expect((await service(f, d).process(scope, { operationId, chain: 'solana' })).operation).toEqual(done);
    expect(d.state.writes).toEqual([]);
  });
  it('preserves immutable acquisition replay and rejects changed intent without certifying old evidence', async () => {
    const f = fixture(), d = db(f); d.state.priorAcquisition = f.position; d.state.q = null;
    expect(await service(f, d).acquire(scope, f.request)).toEqual(f.position);
    await expect(service(f, d).acquire(scope, { ...f.request, deposit: { raw: '1', scale: 18 } })).rejects.toThrow('replay conflict');
    expect(d.state.writes).toEqual([]);
  });
});

describe('SQL085 source containment, not installed catalog/runtime acceptance', () => {
  const sql = readFileSync(new URL('../../../packages/db/sql/085_lp_protected_paper_admission.sql', import.meta.url), 'utf8');
  const refusal = readFileSync(new URL('../../../packages/db/sql/084_wave4_lp_runtime_privileges.sql', import.meta.url), 'utf8');
  it('does not provision roles, alter ownership, grant membership or expose a definer authority function', () => {
    expect(sql).not.toMatch(/CREATE\s+ROLE|ALTER\s+ROLE|OWNER\s+TO|SECURITY\s+DEFINER/i);
    expect(sql).toContain("rolname='swat_lp_admitter'"); expect(sql).toContain('rolsuper OR rolbypassrls'); expect(sql).not.toContain('NOT(rolcanlogin');
    expect(sql).toContain("session_user<>'swat_lp_admitter'"); expect(sql).toContain('pg_catalog.pg_auth_members');
    expect(sql).not.toMatch(/GRANT\s+INSERT[^;]+TO\s+swat_app/i);
    expect(refusal).toContain("RAISE EXCEPTION '084 application refused");
  });
  it('pins two-phase direct-session activation without treating NOLOGIN as authentication', () => {
    const adapter = readFileSync(new URL('../../../packages/db/src/lp-paper-admission-store.ts', import.meta.url), 'utf8');
    expect(sql).toContain('externally authorized ephemeral LOGIN');
    expect(adapter).toContain("current_user='swat_lp_admitter' AND session_user='swat_lp_admitter'");
    expect(adapter).not.toContain('NOT(rolcanlogin'); expect(adapter).toContain('Never SET ROLE');
    expect(sql).toContain('has_schema_privilege(current_user'); expect(sql).toContain('has_database_privilege(current_user');
  });
  it('pins operation-key identity, exact digest checks, canonical projection and NULL-safe chronology', () => {
    expect(sql).toContain('UNIQUE(user_id,context_key)'); expect(sql).not.toContain('UNIQUE(user_id,intent_hash)');
    expect(sql).toContain("context_key='acquisition:'||NEW.acquisition_key");
    expect(sql).toContain("context_key='operation:'||NEW.operation_key");
    expect(sql).toContain('quote_canonical::jsonb IS NOT DISTINCT FROM quote');
    expect(sql).toContain("sha256(convert_to(quote_canonical,'UTF8'))");
    expect(sql).toContain('at_time IS NULL'); expect(sql).toContain('created IS NULL');
    expect(sql).toContain('public.lp085_current_position'); expect(sql).toContain("'autoRebalance',consent");
    expect(sql).toContain('NEW.rung_allocations IS DISTINCT FROM');
    expect(sql).toContain('closed exact inventory cannot reopen');
    // Sealed083 allows projected state/consent to be committed ONLY alongside revision-bound settlement.
    const sealed = readFileSync(new URL('../../../packages/db/sql/083_lp_exact_paper_operations.sql', import.meta.url), 'utf8');
    expect(sealed).toContain("-'state'-'autoRebalance'");
    expect(sealed).toContain("(NEW.data->>'revision')::numeric <> (OLD.data->>'revision')::numeric+1");
  });
  it('defines tenant-composite append-only full payloads, DB-controlled times and SELECT-only runtime admissions', () => {
    expect(sql).toContain('PRIMARY KEY(user_id,id)'); expect(sql).toContain('FOREIGN KEY(user_id,quote_admission_id)');
    expect(sql).toContain('input jsonb NOT NULL, quote jsonb NOT NULL, context jsonb NOT NULL');
    expect(sql).toContain("TG_OP<>'INSERT'"); expect(sql).toContain('NEW.admitted_at:=now_time');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY'); expect(sql).toContain('FOR INSERT TO swat_lp_admitter');
    expect(sql).toContain('GRANT SELECT ON public.%I TO swat_app,swat_lp_admitter');
    expect(sql).not.toContain('is_rls_bypassed()');
  });
  it('requires independent joins on acquisition, operation, receipt, completion and exact/legacy financial UPDATE including old receipts', () => {
    for (const name of ['lp085_base_acquisition','lp085_exact_acquisition','lp085_operation','lp085_receipt','lp085_completion','lp085_exact_position','lp085_legacy_update']) {
      expect(sql).toContain(`CREATE TRIGGER ${name}`);
    }
    expect(sql).toContain('s.receipt IS DISTINCT FROM r'); expect(sql).toContain('s.context');
    expect(sql).toContain('including old materialized receipts'); expect(sql).toContain('NEW.data IS DISTINCT FROM expected');
    expect(sql).toContain('public.lp085_micro(s.receipt'); expect(sql).toContain("jsonb_typeof(j) IS DISTINCT FROM 'object'");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(public\.)?lp_protected_(quote|settlement)_admissions/i);
  });
});
