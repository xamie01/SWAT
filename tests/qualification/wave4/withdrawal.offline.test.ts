import { describe, expect, it } from 'vitest';
import { createWithdrawalService, type WithdrawalEligibility, type WithdrawalServicePorts } from '../../../packages/db/src/withdrawal-service.js';
import { createReducingService, type ReducingServicePorts } from '../../../packages/db/src/reducing-service.js';
import { reducingIntent, reducingRemainder, decimalToRaw, rawToDecimal,
  type ReducingIntent, type ReducingExposure, type ReducingRequest, type ReducingVenueMapping } from '../../../packages/db/src/reducing-contract.js';
import { financialHash, withdrawalIntent, type FinancialReceipt, type FinancialStatus,
  type WithdrawalIntent, type WithdrawalRequest, type WithdrawalSqlClient, type WithdrawalTransaction } from '../../../packages/db/src/withdrawal-contract.js';
import {
  blockedWithdrawalCapabilities, financialSourceJournal, qualifyReducingAdmission, qualifyReducingAdmissionRefusal,
  qualifyUnadmittedReceipt, qualifyWithdrawalCoolingRefusal, qualifyWithdrawalOneUse,
  qualifyWithdrawalOtpRequest, qualifyWithdrawalSubmitRefusal, withdrawalSourceBoundary,
  type FinancialReservationProjection, type WithdrawalSourceResult
} from './withdrawal-scenarios.js';

// Inert SQL transcript only. No SQL server, connection, RLS, trigger, provider, network, queue or process.
// OTP hashing below is deliberately deterministic/nonsecret, not a deployed keyed OTP implementation.
const clock = '2026-11-17T12:00:00.000Z';
const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const otpCode = '123456';
const quantityRaw = '900719925474099312345';
type Intent = WithdrawalIntent | ReducingIntent;
interface IntentRow {
  id: string; user_id: string; kind: Intent['kind']; request_key: string; intent: Intent; intent_hash: string;
  status: FinancialStatus; completed_raw: string; terminal: boolean; created_at: string; cancellation_reason: null;
}
interface AuthorizationRow {
  id: string; user_id: string; intent_id: string; intent_hash: string; digest: string; expires_at: string;
  failures: number; delivery_state: 'pending' | 'sent' | 'failed'; consumed_at: string | null;
}
interface ReservationRow extends FinancialReservationProjection { user_id: string; intent_id: string }
interface AttemptRow {
  id: string; user_id: string; intent_id: string; intent_hash: string; client_order_id: string;
  state: 'uncertain'; completed_raw: string; completed_fee_raw: string; terminal: boolean;
}
interface OutboxRow { user_id: string; intent_id: string; intent_hash: string }
interface FixtureState {
  intents: IntentRow[]; authorizations: AuthorizationRow[]; reservations: ReservationRow[];
  outbox: OutboxRow[]; attempts: AttemptRow[];
}
interface Trace { readonly marker: string; readonly values: readonly unknown[]; readonly client: WithdrawalSqlClient }
function requireFixture(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Inert fixture contract: ${message}`);
}
function text(value: unknown): string { requireFixture(typeof value === 'string', 'string SQL parameter required'); return value; }
function integer(value: unknown): number { requireFixture(typeof value === 'number' && Number.isSafeInteger(value), 'integer SQL parameter required'); return value; }
function object(value: unknown): Record<string, unknown> {
  requireFixture(value !== null && typeof value === 'object' && !Array.isArray(value), 'intent object required');
  return Object.fromEntries(Object.entries(value));
}
/** Decode transport JSON through actual intent builders, without casting any protected authority. */
function decodeIntent(value: unknown): Intent {
  const json: unknown = JSON.parse(text(value));
  const body = object(json);
  const chain = body.chain, mode = body.mode;
  requireFixture(chain === 'solana' || chain === 'polygon' || chain === 'robinhood-chain', 'chain required');
  requireFixture(mode === 'paper' || mode === 'live', 'mode required');
  const common: Pick<WithdrawalRequest, 'requestKey' | 'chain' | 'mode' | 'network' | 'assetId' | 'assetScale'
    | 'maxFeeRaw' | 'feeAssetId' | 'feeAssetScale' | 'feeFundingAccountId'> = { requestKey: text(body.requestKey), chain, mode, network: text(body.network), assetId: text(body.assetId),
    assetScale: integer(body.assetScale), maxFeeRaw: text(body.maxFeeRaw), feeAssetId: text(body.feeAssetId),
    feeAssetScale: integer(body.feeAssetScale), feeFundingAccountId: text(body.feeFundingAccountId) };
  if (body.kind === 'withdrawal') return withdrawalIntent(text(body.userId), { ...common,
    sourceWalletId: text(body.sourceWalletId), destination: text(body.destination), amountRaw: text(body.amountRaw) }, text(body.expiresAt));
  const venue = body.venue, positionSide = body.positionSide;
  requireFixture(body.kind === 'reducing' && (venue === 'spot' || venue === 'polymarket-perps')
    && (positionSide === 'LONG' || positionSide === 'SHORT'), 'reducing intent required');
  return reducingIntent(text(body.userId), { ...common, venue, positionSide, positionId: text(body.positionId),
    accountId: text(body.accountId), quantityRaw: text(body.quantityRaw), limitPriceExact: text(body.limitPriceExact),
    expectedRevision: text(body.expectedRevision) }, text(body.expiresAt));
}
function inertSqlFixture() {
  let state: FixtureState = { intents: [], authorizations: [], reservations: [], outbox: [], attempts: [] };
  let now = clock, serial = 0, active = false;
  let failMarker: string | null = null;
  let consumeConflict = false;
  const trace: Trace[] = [], events: string[] = [];
  function execute(marker: string, values: unknown[], tenant: string): object[] {
    const ownedIntent = () => state.intents.filter(row => row.user_id === tenant);
    const ownedAuthorizations = () => state.authorizations.filter(row => row.user_id === tenant && row.user_id === values[0] && row.intent_id === values[1]);
    switch (marker) {
      case 'financial:clock': return [{ observed_at: now }];
      case 'financial:request-lock': case 'financial:budget-lock': return [];
      case 'financial:by-key': return ownedIntent().filter(row => row.user_id === values[0] && row.kind === values[1] && row.request_key === values[2]);
      case 'financial:by-id': return ownedIntent().filter(row => row.user_id === values[0] && row.id === values[1]);
      case 'financial:create': {
        const intent = decodeIntent(values[3]);
        requireFixture(intent.userId === tenant && intent.userId === values[0] && intent.kind === values[1]
          && intent.requestKey === values[2] && financialHash(intent) === values[4], 'intent tenant/hash binding');
        requireFixture(!ownedIntent().some(row => row.kind === intent.kind && row.request_key === intent.requestKey), 'duplicate intent');
        const row: IntentRow = { id: `intent-${++serial}`, user_id: tenant, kind: intent.kind, request_key: intent.requestKey,
          intent, intent_hash: financialHash(intent), status: 'awaiting-authorization', completed_raw: '0', terminal: false,
          created_at: now, cancellation_reason: null };
        state.intents.push(row); return [row];
      }
      case 'financial:reserved': return [{ reserved_raw: state.reservations
        .filter(row => row.user_id === tenant && row.user_id === values[0] && row.budget_key === values[1] && row.intent_id !== values[2])
        .reduce((sum, row) => sum + BigInt(row.reserved_raw), 0n).toString() }];
      case 'financial:reserve': {
        const purpose = values[3];
        requireFixture(purpose === 'funding' || purpose === 'exposure', 'reservation purpose');
        requireFixture(values[1] === tenant && !state.reservations.some(row => row.intent_id === values[0] && row.budget_key === values[2]), 'reservation tenant/uniqueness');
        state.reservations.push({ intent_id: text(values[0]), user_id: tenant, budget_key: text(values[2]), purpose,
          chain: text(values[4]), network: text(values[5]), mode: text(values[6]), account_id: text(values[7]), asset_id: text(values[8]),
          asset_scale: integer(values[9]), amount_raw: text(values[10]), fee_raw: text(values[11]),
          reserved_raw: (BigInt(text(values[10])) + BigInt(text(values[11]))).toString() }); return [];
      }
      case 'financial:outbox': {
        requireFixture(values[1] === tenant && !state.outbox.some(row => row.intent_id === values[0]), 'outbox tenant/uniqueness');
        state.outbox.push({ intent_id: text(values[0]), user_id: tenant, intent_hash: text(values[2]) }); return [];
      }
      case 'financial:queue': {
        const row = ownedIntent().find(candidate => candidate.id === values[0] && candidate.user_id === values[1] && candidate.status === 'awaiting-authorization');
        if (!row) return []; row.status = 'queued'; return [row];
      }
      case 'withdrawal:issue': {
        requireFixture(values[0] === tenant, 'OTP tenant');
        const row: AuthorizationRow = { id: `authorization-${++serial}`, user_id: tenant, intent_id: text(values[1]),
          intent_hash: text(values[2]), digest: text(values[3]), expires_at: text(values[4]), failures: 0, delivery_state: 'pending', consumed_at: null };
        state.authorizations.push(row); return [row];
      }
      case 'withdrawal:authorization': return ownedAuthorizations();
      case 'withdrawal:delivery': {
        const row = state.authorizations.find(candidate => candidate.user_id === tenant && candidate.user_id === values[0]
          && candidate.id === values[1] && candidate.delivery_state === 'pending' && !candidate.consumed_at);
        requireFixture(values[2] === 'sent' || values[2] === 'failed', 'delivery state');
        if (row) row.delivery_state = values[2]; return [];
      }
      case 'withdrawal:failure': {
        const row = state.authorizations.find(candidate => candidate.user_id === tenant && candidate.user_id === values[0] && candidate.id === values[1] && !candidate.consumed_at);
        if (row) row.failures++; return [];
      }
      case 'withdrawal:consume': {
        if (consumeConflict) return [];
        const row = state.authorizations.find(candidate => candidate.user_id === tenant && candidate.user_id === values[0]
          && candidate.id === values[1] && candidate.intent_id === values[2] && candidate.intent_hash === values[3]
          && candidate.digest === values[4] && !candidate.consumed_at && candidate.failures < 5
          && candidate.delivery_state === 'sent' && candidate.expires_at > now);
        if (!row) return []; row.consumed_at = now; return [row];
      }
      case 'financial:attempt': return state.attempts.filter(row => row.user_id === tenant && row.intent_id === values[0] && row.user_id === values[1]);
      // Negative fixtures can never admit receipts or mappings and have no accounting/application implementation.
      case 'financial:admitted-receipt': case 'reducing:venue-mapping': return [];
      case 'qualification:financial-journal': {
        const authorizations = ownedAuthorizations();
        const outbox = state.outbox.filter(row => row.user_id === tenant && row.user_id === values[0] && row.intent_id === values[1]);
        return [{ authorizations: String(authorizations.length), consumed: String(authorizations.filter(row => row.consumed_at !== null).length),
          failures: authorizations.reduce((sum, row) => sum + BigInt(row.failures), 0n).toString(), outbox: String(outbox.length),
          bound_outbox: String(outbox.filter(row => row.intent_hash === values[2]).length),
          attempts: String(state.attempts.filter(row => row.user_id === tenant && row.user_id === values[0] && row.intent_id === values[1]).length),
          applications: '0', admitted_receipts: '0' }];
      }
      case 'qualification:financial-reservations': return state.reservations
        .filter(row => row.user_id === tenant && row.user_id === values[0] && row.intent_id === values[1])
        .map(({ user_id: _userId, intent_id: _intentId, ...row }) => row)
        .sort((a, b) => a.budget_key < b.budget_key ? -1 : a.budget_key > b.budget_key ? 1 : 0);
      default: throw new Error(`Unimplemented inert SQL marker: ${marker}`);
    }
  }
  const transaction: WithdrawalTransaction = async <T>(tenant: string, action: (client: WithdrawalSqlClient) => Promise<T>): Promise<T> => {
    requireFixture(!active, 'fixture is intentionally sequential, not a concurrent database');
    active = true;
    const before = structuredClone(state);
    const client: WithdrawalSqlClient = {
      async query<Row>(sql: string, values: unknown[] = []): Promise<{ rows: Row[] }> {
        const marker = /\/\* ([a-z-]+:[a-z-]+) \*\//.exec(sql)?.[1];
        requireFixture(marker, 'recognized SQL marker required');
        trace.push({ marker, values: structuredClone(values), client }); events.push(marker);
        if (marker === failMarker) throw new Error('inert injected persistence failure');
        // Generic query transport projection only, never a cast to quote/receipt/secret/execution authority.
        return { rows: structuredClone(execute(marker, values, tenant)) as Row[] };
      }
    };
    events.push(`begin:${tenant}`);
    try {
      const value = await action(client);
      if (failMarker === 'commit') throw new Error('inert injected commit failure');
      events.push(`commit:${tenant}`); return value;
    } catch (error) {
      state = before; events.push(`rollback:${tenant}`); throw error;
    } finally { active = false; }
  };
  return { transaction, trace, events, snapshot: () => structuredClone(state), get now() { return now; },
    advance: (ms: number) => { now = new Date(Date.parse(now) + ms).toISOString(); },
    fail: (marker: string | null) => { failMarker = marker; }, conflict: () => { consumeConflict = true; },
    // Inert negative precondition only: not authorized dispatch or a production uncertain-attempt factory.
    seedUncertainNegative: (intentId: string) => {
      const row = state.intents.find(candidate => candidate.id === intentId);
      requireFixture(row?.status === 'queued', 'queued negative-fixture intent');
      row.status = 'uncertain';
      state.attempts.push({ id: 'negative-attempt', user_id: row.user_id, intent_id: row.id, intent_hash: row.intent_hash,
        client_order_id: 'negative-fixed-order', state: 'uncertain', completed_raw: '0', completed_fee_raw: '0', terminal: false });
    } };
}
function setupWithdrawal() {
  const db = inertSqlFixture();
  const request: WithdrawalRequest = { requestKey: 'withdrawal-offline-1', chain: 'polygon', network: 'offline-polygon-137',
    assetId: 'USDC', assetScale: 6, sourceWalletId: 'offline-source-wallet', destination: `0x${'a'.repeat(40)}`,
    amountRaw: quantityRaw, maxFeeRaw: '10', feeAssetId: 'MATIC', feeAssetScale: 18, feeFundingAccountId: 'offline-fee-wallet', mode: 'paper' };
  let overrides: Partial<WithdrawalEligibility> = {}, delivery: 'sent' | 'failed' | 'unknown' = 'sent';
  let issued = 0, delivered = 0;
  const locks: { kind: 'eligibility' | 'funding'; client: WithdrawalSqlClient }[] = [];
  const ports: WithdrawalServicePorts = { transaction: db.transaction,
    lockEligibility: async (client, intent) => {
      locks.push({ kind: 'eligibility', client });
      return { ...intent, destinationVerifiedAt: '2026-11-15T12:00:00.000Z', availableRaw: '900719925474099999999',
        observedAt: db.now, validUntil: new Date(Date.parse(db.now) + 60_000).toISOString(),
        custodyRevision: 'inert-custody-r1', balanceProof: 'inert-not-custody-authority', ...overrides };
    },
    lockFunding: async (client, tenant, budget) => {
      locks.push({ kind: 'funding', client });
      return { ...budget, userId: tenant, availableRaw: budget.amountRaw === '0' ? '1000' : overrides.availableRaw ?? '900719925474099999999',
        observedAt: db.now, validUntil: new Date(Date.parse(db.now) + 60_000).toISOString(), proof: 'inert-not-funding-authority' };
    },
    otp: {
      issue: async intentHash => { issued++; return { code: otpCode, digest: financialHash(['nonsecret-offline', intentHash, otpCode]) }; },
      digest: async (intentHash, code) => financialHash(['nonsecret-offline', intentHash, code]),
      deliver: async (tenant, code, intent) => {
        delivered++; db.events.push('fixture:deliver');
        expect(tenant).toBe(userId); expect(intent.userId).toBe(userId); expect(code).toBe(otpCode);
        expect(db.events[db.events.length - 2]).toBe(`commit:${userId}`);
        if (delivery === 'unknown') throw new Error('inert delivery uncertainty');
        return delivery === 'sent';
      }
    } };
  return { db, request, ports, locks, issued: () => issued, delivered: () => delivered,
    evidence: (value: Partial<WithdrawalEligibility>) => { overrides = value; },
    delivery: (value: typeof delivery) => { delivery = value; } };
}
function setupReducing(venue: 'spot' | 'polymarket-perps' = 'spot', positionSide: 'LONG' | 'SHORT' = 'LONG') {
  const db = inertSqlFixture();
  const request: ReducingRequest = { requestKey: 'reducing-offline-1', chain: 'polygon', network: 'offline-polygon-137', venue,
    positionId: 'offline-position', accountId: 'offline-inventory-account', assetId: 'offline-position-asset', assetScale: 18,
    mode: 'paper', positionSide, quantityRaw, maxFeeRaw: '10', feeAssetId: 'MATIC', feeAssetScale: 18,
    feeFundingAccountId: 'offline-native-fee-account', limitPriceExact: '65000.000000000000000001', expectedRevision: 'offline-r1' };
  let overrides: Partial<ReducingExposure> = {};
  const ports: ReducingServicePorts = { transaction: db.transaction,
    lockExposure: async (_client, intent) => ({ ...intent, heldRaw: quantityRaw, revision: request.expectedRevision,
      observedAt: db.now, validUntil: new Date(Date.parse(db.now) + 60_000).toISOString(), proof: 'inert-not-exposure-authority', ...overrides }),
    lockFunding: async (_client, tenant, budget) => ({ ...budget, userId: tenant, availableRaw: '1000', observedAt: db.now,
      validUntil: new Date(Date.parse(db.now) + 60_000).toISOString(), proof: 'inert-not-funding-authority' }) };
  return { db, request, ports, evidence: (value: Partial<ReducingExposure>) => { overrides = value; } };
}
function requireSourceOnly(result: WithdrawalSourceResult): void {
  expect(result.boundary).toEqual(withdrawalSourceBoundary);
  expect(result.boundary.runtimeAccepted).toBe(false);
  expect(result.boundary.sqlServerAccepted).toBe(false);
  expect(result.blocked.length).toBeGreaterThan(0);
}
async function authorize(s: ReturnType<typeof setupWithdrawal>) {
  const { authorization, result } = await qualifyWithdrawalOtpRequest(s.ports, userId, s.request);
  requireSourceOnly(result);
  return { intentId: authorization.intent.id, authorizationId: authorization.authorizationId, otp: otpCode };
}

describe('S5 withdrawal SQL-store source contracts; inert offline services only, not SQL/server acceptance', () => {
  it('uses the actual service/store to issue once, deliver after commit and preserve request retry identity without exposing the code', async () => {
    const s = setupWithdrawal(), input = await authorize(s);
    expect(s.issued()).toBe(1); expect(s.delivered()).toBe(1);
    const snapshot = s.db.snapshot();
    expect(snapshot.authorizations).toHaveLength(1); expect(snapshot.outbox).toHaveLength(0); expect(snapshot.reservations).toHaveLength(0);
    expect(input.intentId).toBe(snapshot.intents[0]?.id);
    const locking = s.db.trace.filter(row => row.marker === 'financial:budget-lock');
    expect(locking).toHaveLength(2);
    expect(s.locks.every(row => row.client === locking[0]?.client)).toBe(true);
  });

  it('consumes once with exact principal/fee reservations and one outbox, leaving consumed-code replay unchanged', async () => {
    const s = setupWithdrawal(), input = await authorize(s);
    const result = await qualifyWithdrawalOneUse(s.ports, userId, input);
    requireSourceOnly(result);
    expect(result.assertions).toHaveLength(4);
    expect(s.db.snapshot().reservations.map(row => [row.asset_id, row.amount_raw, row.fee_raw, row.reserved_raw])).toEqual([
      ['MATIC', '0', '10', '10'], ['USDC', quantityRaw, '0', quantityRaw]
    ]);
    const writes = s.db.trace.filter(row => ['financial:reserve', 'withdrawal:consume', 'financial:outbox', 'financial:queue'].includes(row.marker));
    expect(writes.map(row => row.marker)).toEqual(['financial:reserve', 'financial:reserve', 'withdrawal:consume', 'financial:outbox', 'financial:queue']);
    expect(writes.every(row => row.client === writes[0]?.client)).toBe(true);
    expect(s.db.snapshot().attempts).toHaveLength(0);
  });

  it('combines only identical principal/fee denomination and account, using exact BigInt sums', async () => {
    const s = setupWithdrawal();
    const request: WithdrawalRequest = { ...s.request, feeAssetId: s.request.assetId, feeAssetScale: s.request.assetScale,
      feeFundingAccountId: s.request.sourceWalletId };
    const { authorization } = await qualifyWithdrawalOtpRequest(s.ports, userId, request);
    await qualifyWithdrawalOneUse(s.ports, userId, { intentId: authorization.intent.id, authorizationId: authorization.authorizationId, otp: otpCode });
    expect(s.db.snapshot().reservations).toHaveLength(1);
    expect(s.db.snapshot().reservations[0]?.reserved_raw).toBe((BigInt(quantityRaw) + 10n).toString());
  });

  it('commits five failed OTP attempts, locks before the sixth and never queues or consumes', async () => {
    const s = setupWithdrawal(), input = await authorize(s);
    for (let attempt = 0; attempt < 5; attempt++) {
      requireSourceOnly(await qualifyWithdrawalSubmitRefusal(s.ports, userId, { ...input, otp: '654321' }, 'withdrawal-otp-invalid'));
    }
    requireSourceOnly(await qualifyWithdrawalSubmitRefusal(s.ports, userId, input, 'withdrawal-otp-locked'));
    expect(s.db.snapshot().authorizations[0]?.failures).toBe(5);
    expect(s.db.snapshot().authorizations[0]?.consumed_at).toBeNull(); expect(s.db.snapshot().outbox).toHaveLength(0);
  });

  it('a wrong consumed-code retry cannot change the queued outbox or consume another authorization', async () => {
    const s = setupWithdrawal(), input = await authorize(s);
    await qualifyWithdrawalOneUse(s.ports, userId, input);
    requireSourceOnly(await qualifyWithdrawalSubmitRefusal(s.ports, userId, { ...input, otp: '654321' }, 'withdrawal-otp-invalid'));
    expect(s.db.snapshot().authorizations[0]?.failures).toBe(0); expect(s.db.snapshot().outbox).toHaveLength(1);
  });

  it.each(['failed', 'unknown'] as const)('refuses %s delivery rather than treating injected delivery state as accepted authority', async delivery => {
    const s = setupWithdrawal(); s.delivery(delivery);
    const { authorization, result } = await qualifyWithdrawalOtpRequest(s.ports, userId, s.request);
    expect(result.state).toBe('blocked-on-external-capability'); requireSourceOnly(result);
    requireSourceOnly(await qualifyWithdrawalSubmitRefusal(s.ports, userId,
      { intentId: authorization.intent.id, authorizationId: authorization.authorizationId, otp: otpCode }, 'withdrawal-otp-delivery-unconfirmed'));
    expect(s.issued()).toBe(1); expect(s.delivered()).toBe(1);
  });

  it('rejects changed immutable request fields under the same request key without reissuing an OTP', async () => {
    const s = setupWithdrawal(); await authorize(s);
    await expect(createWithdrawalService(s.ports).requestOtp(userId, { ...s.request, amountRaw: '1' }))
      .rejects.toMatchObject({ code: 'withdrawal-request-key-conflict' });
    expect(s.issued()).toBe(1); expect(s.delivered()).toBe(1);
  });

  it('a foreign principal cannot submit the owner intent through the production service', async () => {
    const s = setupWithdrawal(), input = await authorize(s), before = s.db.snapshot();
    await expect(createWithdrawalService(s.ports).submit(otherUserId, input)).rejects.toMatchObject({ code: 'withdrawal-intent-not-found' });
    expect(s.db.snapshot()).toEqual(before); // Fixture filtering only, NOT real RLS evidence.
  });

  it('refuses OTP expiry at the exact database-clock boundary without reserving funds', async () => {
    const s = setupWithdrawal(), input = await authorize(s); s.db.advance(300_000);
    requireSourceOnly(await qualifyWithdrawalSubmitRefusal(s.ports, userId, input, 'withdrawal-authorization-expired'));
    expect(s.db.snapshot().reservations).toHaveLength(0);
  });

  it('refuses disabled cooling policy and refuses a destination verified less than 24 hours ago before OTP issue', async () => {
    const s = setupWithdrawal();
    expect(() => createWithdrawalService({ ...s.ports, coolingOffMs: 0 })).toThrow('withdrawal-cooling-policy-invalid');
    s.evidence({ destinationVerifiedAt: '2026-11-16T12:00:00.001Z' });
    requireSourceOnly(await qualifyWithdrawalCoolingRefusal(s.ports, userId, s.request));
    expect(s.issued()).toBe(0); expect(s.delivered()).toBe(0); expect(s.db.snapshot().intents).toHaveLength(0);
    expect(s.db.events).toContain(`rollback:${userId}`);
  });

  it('accepts the inert exact 24-hour boundary but rechecks changed destination cooling at submission', async () => {
    const s = setupWithdrawal(); s.evidence({ destinationVerifiedAt: '2026-11-16T12:00:00.000Z' });
    const input = await authorize(s); s.evidence({ destinationVerifiedAt: s.db.now });
    requireSourceOnly(await qualifyWithdrawalSubmitRefusal(s.ports, userId, input, 'withdrawal-cooling-off'));
    expect(s.db.snapshot().authorizations[0]?.consumed_at).toBeNull();
  });

  it('production service revalidation refuses changed cooling on queued admission without constructing an effect runner', async () => {
    const s = setupWithdrawal(), input = await authorize(s); await qualifyWithdrawalOneUse(s.ports, userId, input);
    const record = await createWithdrawalService(s.ports).status(userId, input.intentId);
    requireFixture(record, 'queued withdrawal projection');
    const before = s.db.snapshot(); s.evidence({ destinationVerifiedAt: s.db.now });
    await expect(s.ports.transaction(userId, client => createWithdrawalService(s.ports).revalidate(client, record, s.db.now, false)))
      .rejects.toMatchObject({ code: 'withdrawal-cooling-off' });
    expect(s.db.snapshot()).toEqual(before); expect(s.db.snapshot().attempts).toHaveLength(0);
    // This exercises the service port, not runner placement of the check at an actual dispatch fence.
  });

  it.each([
    ['mode change', { mode: 'live' }, 'withdrawal-ownership-or-mode-changed'],
    ['stale balance', { observedAt: '2026-11-17T11:59:29.999Z' }, 'withdrawal-balance-stale'],
    ['insufficient balance', { availableRaw: '1' }, 'withdrawal-balance-insufficient']
  ] as const)('rechecks %s under the actual service before consuming or queueing', async (_label, evidence, code) => {
    const s = setupWithdrawal(), input = await authorize(s); s.evidence(evidence);
    requireSourceOnly(await qualifyWithdrawalSubmitRefusal(s.ports, userId, input, code));
    expect(s.db.snapshot().reservations).toHaveLength(0); expect(s.db.snapshot().outbox).toHaveLength(0);
  });

  it.each(['withdrawal:consume', 'financial:outbox', 'financial:queue', 'commit'])('rolls back consumption, reservations and outbox on inert %s failure', async marker => {
    const s = setupWithdrawal(), input = await authorize(s), before = s.db.snapshot(); s.db.fail(marker);
    await expect(createWithdrawalService(s.ports).submit(userId, input)).rejects.toThrow('inert injected');
    expect(s.db.snapshot()).toEqual(before);
    s.db.fail(null); requireSourceOnly(await qualifyWithdrawalOneUse(s.ports, userId, input));
  });

  it('a zero-row consume conflict rolls back both exact reservation inserts', async () => {
    const s = setupWithdrawal(), input = await authorize(s), before = s.db.snapshot(); s.db.conflict();
    await expect(createWithdrawalService(s.ports).submit(userId, input)).rejects.toMatchObject({ code: 'withdrawal-authorization-consume-conflict' });
    expect(s.db.snapshot()).toEqual(before);
  });

  it('OTP issuance commit failure never delivers a code and rolls back the authorization', async () => {
    const s = setupWithdrawal(); s.db.fail('commit');
    await expect(createWithdrawalService(s.ports).requestOtp(userId, s.request)).rejects.toThrow('inert injected commit failure');
    expect(s.issued()).toBe(1); expect(s.delivered()).toBe(0); expect(s.db.snapshot().authorizations).toHaveLength(0);
  });

  it('executes the actual store unadmitted-receipt refusal against an inert uncertain precondition without minting a receipt', async () => {
    const s = setupWithdrawal(), input = await authorize(s); await qualifyWithdrawalOneUse(s.ports, userId, input);
    s.db.seedUncertainNegative(input.intentId);
    const snapshot = s.db.snapshot(), attempt = snapshot.attempts[0], intent = snapshot.intents[0];
    requireFixture(attempt && intent, 'negative attempt precondition');
    const hostileReceipt: FinancialReceipt = { receiptId: 'hostile-unadmitted', providerIdentity: 'not-authenticated', proof: 'not-a-proof',
      intentId: intent.id, intentHash: intent.intent_hash, attemptId: attempt.id, clientOrderId: attempt.client_order_id,
      cumulativeRaw: quantityRaw, feeRaw: '5', feeAssetId: s.request.feeAssetId, feeAssetScale: s.request.feeAssetScale,
      feeFundingAccountId: s.request.feeFundingAccountId, terminal: true, outcome: 'fill', observedAt: s.db.now };
    const result = await qualifyUnadmittedReceipt(s.ports.transaction, userId, input.intentId, hostileReceipt);
    requireSourceOnly(result); expect(result.state).toBe('blocked-on-external-capability');
    expect(s.db.snapshot()).toEqual(snapshot);
    expect(s.db.trace.some(row => row.marker === 'financial:admitted-receipt')).toBe(true);
    expect((await financialSourceJournal(s.ports.transaction, userId, input.intentId)).record.status).toBe('uncertain');
  });

  it('does not manufacture an uncertain attempt when receipt qualification has only queued admission', async () => {
    const s = setupWithdrawal(), input = await authorize(s); await qualifyWithdrawalOneUse(s.ports, userId, input);
    const intent = s.db.snapshot().intents[0]; requireFixture(intent, 'queued intent');
    const hostileReceipt: FinancialReceipt = { receiptId: 'hostile', providerIdentity: 'not-authenticated', proof: 'not-a-proof',
      intentId: intent.id, intentHash: intent.intent_hash, attemptId: 'not-an-attempt', clientOrderId: 'not-an-order', cumulativeRaw: '0',
      feeRaw: '0', feeAssetId: s.request.feeAssetId, feeAssetScale: s.request.feeAssetScale,
      feeFundingAccountId: s.request.feeFundingAccountId, terminal: true, outcome: 'absent-final', observedAt: s.db.now };
    const result = await qualifyUnadmittedReceipt(s.ports.transaction, userId, input.intentId, hostileReceipt);
    expect(result.assertions).toHaveLength(0); expect(result.blocked).toContain('existing-production-uncertain-attempt-unavailable');
    expect(s.db.snapshot().attempts).toHaveLength(0);
  });
});

describe('S5 reducing admission and fail-closed collateral dependencies; no canonical accounting claim', () => {
  it('executes real spot reducing admission with exact separate exposure/native-fee budgets and idempotent outbox', async () => {
    const s = setupReducing(), result = await qualifyReducingAdmission(s.ports, userId, s.request);
    requireSourceOnly(result);
    expect(s.db.snapshot().reservations.map(row => [row.purpose, row.amount_raw, row.fee_raw])).toEqual([
      ['exposure', quantityRaw, '0'], ['funding', '0', '10']
    ]);
    expect(s.db.snapshot().intents[0]?.intent).toMatchObject({ positionSide: 'LONG', side: 'SELL', quantityRaw,
      limitPriceExact: '65000.000000000000000001' });
    expect(s.db.snapshot().outbox).toHaveLength(1);
  });

  it.each([
    ['over-close', { heldRaw: '1' }, 'reducing-would-cross-zero'],
    ['stale revision', { revision: 'offline-r2' }, 'reducing-stale-revision'],
    ['stale exposure', { observedAt: '2026-11-17T11:59:29.999Z' }, 'reducing-exposure-stale'],
    ['changed mode', { mode: 'live' }, 'reducing-ownership-or-mode-changed']
  ] as const)('real reducing service refuses %s without an outbox or residual reservation', async (_label, evidence, code) => {
    const s = setupReducing(); s.evidence(evidence);
    requireSourceOnly(await qualifyReducingAdmissionRefusal(s.ports, userId, s.request, code));
    expect(s.db.snapshot().intents).toHaveLength(0); expect(s.db.snapshot().outbox).toHaveLength(0);
    expect(s.db.snapshot().reservations).toHaveLength(0);
  });

  it('uses the production reducing service to refuse competing exact exposure reservation', async () => {
    const s = setupReducing(); await qualifyReducingAdmission(s.ports, userId, s.request);
    requireSourceOnly(await qualifyReducingAdmissionRefusal(s.ports, userId, { ...s.request, requestKey: 'competing' }, 'reducing-exposure-or-fee-reserved'));
    expect(s.db.snapshot().intents).toHaveLength(1); expect(s.db.snapshot().outbox).toHaveLength(1);
  });

  it.each(['LONG', 'SHORT'] as const)('perps %s remains blocked without independently admitted collateral mapping even with zero fees', async positionSide => {
    const s = setupReducing('polymarket-perps', positionSide);
    const result = await qualifyReducingAdmissionRefusal(s.ports, userId, { ...s.request, maxFeeRaw: '0' }, 'reducing-independent-collateral-mapping-unavailable');
    requireSourceOnly(result); expect(result.state).toBe('blocked-on-external-capability');
    expect(s.db.snapshot().outbox).toHaveLength(0);
  });

  it('a well-shaped inert mapping projection cannot replace restricted durable admission or infer collateral from native fee labels', async () => {
    const s = setupReducing('polymarket-perps');
    const ports: ReducingServicePorts = { ...s.ports, lockVenueMapping: async (_client, record): Promise<ReducingVenueMapping> => ({
      mappingId: 'unadmitted-mapping', revision: 'not-deployed', userId: record.userId, positionId: record.intent.positionId,
      accountId: record.intent.accountId, venue: record.intent.venue, chain: record.intent.chain, network: record.intent.network,
      mode: record.intent.mode, assetId: record.intent.assetId, assetScale: record.intent.assetScale,
      collateralAssetId: 'USDC', collateralAssetScale: 6, collateralAccountId: 'unadmitted-collateral-account', observedAt: s.db.now,
      validUntil: new Date(Date.parse(s.db.now) + 60_000).toISOString(), proof: 'not-independent-evidence' }) };
    const result = await qualifyReducingAdmissionRefusal(ports, userId, s.request, 'reducing-independent-collateral-mapping-unavailable');
    requireSourceOnly(result); expect(s.db.trace.some(row => row.marker === 'reducing:venue-mapping')).toBe(true);
    expect(s.db.snapshot().intents).toHaveLength(0);
  });

  it('executes exact production LONG/SHORT remainder and decimal helpers without Number economics or a canonical ledger claim', () => {
    expect(reducingRemainder('LONG', 'SELL', quantityRaw, '45')).toBe('900719925474099312300');
    expect(reducingRemainder('SHORT', 'BUY', quantityRaw, quantityRaw)).toBe('0');
    expect(() => reducingRemainder('LONG', 'BUY', quantityRaw, '1')).toThrow('reducing-direction-increases-exposure');
    expect(() => reducingRemainder('SHORT', 'BUY', quantityRaw, (BigInt(quantityRaw) + 1n).toString())).toThrow('reducing-would-cross-zero');
    expect(rawToDecimal(quantityRaw, 18)).toBe('900.719925474099312345');
    expect(decimalToRaw('900.719925474099312345', 18)).toBe(quantityRaw);
    expect(() => decimalToRaw('0.0000001', 6)).toThrow('position-scale-loss');
  });

  it('canonical receipt/accounting/collateral capabilities remain explicit dependencies, not injected success flags', () => {
    const results = blockedWithdrawalCapabilities();
    expect(results).toHaveLength(3);
    expect(results[0]?.blocked).toContain('concrete-source-otp-and-capture-do-not-establish-deployed-authority');
    expect(results[2]?.blocked).toContain('immutable-financial-intent-attempt-to-canonical-spot-lot-execution-receipt-linkage-source-gap');
    expect(results[2]?.blocked).toContain('canonical-withdrawal-and-spot-independent-ledger-admission-writer-source-backing-gap');
    for (const result of results) {
      requireSourceOnly(result); expect(result.state).toBe('blocked-on-external-capability'); expect(result.assertions).toHaveLength(0);
    }
    expect(withdrawalSourceBoundary).toMatchObject({ runtimeExecution: 'refused', joinedPipelineExecution: 'refused',
      package28Acceptance: 'unchanged-and-not-inherited', productionReady: false, liveCapabilityAccepted: false });
    expect(() => createReducingService({ ...setupReducing().ports, exposureMaxAgeMs: 0 })).toThrow('reducing-expiry-policy-invalid');
  });
});
