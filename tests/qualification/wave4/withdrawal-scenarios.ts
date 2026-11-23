import {
  createWithdrawalService, withdrawalBudgets,
  type WithdrawalServicePorts, type SubmitWithdrawal
} from '@swat/db/dist/withdrawal-service.js';
import { createReducingService, type ReducingServicePorts } from '@swat/db/dist/reducing-service.js';
import { reducingBudgets, type ReducingIntent, type ReducingRequest } from '@swat/db/dist/reducing-contract.js';
import {
  financialBudgetKey, financialHash, WithdrawalProtocolError,
  type FinancialBudget, type FinancialReceipt, type FinancialRecord, type WithdrawalIntent,
  type WithdrawalRequest, type WithdrawalTransaction
} from '@swat/db/dist/withdrawal-contract.js';
import { withdrawalSqlStore } from '@swat/db/dist/withdrawal-store.js';

/** Source contracts only. Nothing opens a connection, captures a code, admits evidence or starts a runner. */
export const withdrawalSourceBoundary = Object.freeze({
  sourceImplemented: true,
  sqlServerAccepted: false,
  runtimeAccepted: false,
  liveCapabilityAccepted: false,
  productionReady: false,
  runtimeExecution: 'refused',
  joinedPipelineExecution: 'refused',
  package28Acceptance: 'unchanged-and-not-inherited'
} as const);

export type WithdrawalQualificationPorts = Omit<WithdrawalServicePorts, 'store'>;
export type ReducingQualificationPorts = Omit<ReducingServicePorts, 'store'>;
export interface WithdrawalSourceAssertion { readonly name: string; readonly passed: true }
export interface WithdrawalSourceResult {
  readonly scenario: string;
  readonly state: 'source-contract-observed' | 'blocked-on-external-capability';
  readonly boundary: typeof withdrawalSourceBoundary;
  readonly assertions: readonly WithdrawalSourceAssertion[];
  readonly blocked: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
}
interface JournalCounts {
  authorizations: string; consumed: string; failures: string; outbox: string; bound_outbox: string;
  attempts: string; applications: string; admitted_receipts: string;
}
export interface FinancialReservationProjection {
  readonly budget_key: string; readonly purpose: 'funding' | 'exposure';
  readonly chain: string; readonly network: string; readonly mode: string;
  readonly account_id: string; readonly asset_id: string; readonly asset_scale: number;
  readonly amount_raw: string; readonly fee_raw: string; readonly reserved_raw: string;
}
export interface FinancialSourceJournal<I extends WithdrawalIntent | ReducingIntent> {
  readonly record: FinancialRecord<I>;
  readonly counts: JournalCounts;
  readonly reservations: readonly FinancialReservationProjection[];
}
function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Withdrawal qualification source refused: ${reason}`);
}
function observed(scenario: string, names: readonly string[], evidence: Readonly<Record<string, unknown>>): WithdrawalSourceResult {
  return { scenario, state: 'source-contract-observed', boundary: withdrawalSourceBoundary,
    assertions: names.map(name => ({ name, passed: true })),
    blocked: ['real-sql-role-rls-trigger-and-concurrency-acceptance-not-observed',
      'protected-deployed-capability-provenance-not-established-by-injection'], evidence };
}
function blocked(scenario: string, reasons: readonly string[], evidence: Readonly<Record<string, unknown>> = {}): WithdrawalSourceResult {
  return { scenario, state: 'blocked-on-external-capability', boundary: withdrawalSourceBoundary,
    assertions: [], blocked: reasons, evidence };
}
async function expectProtocolRefusal(action: () => Promise<unknown>, code: string): Promise<void> {
  try { await action(); }
  catch (error) {
    // Infrastructure errors, fixture errors and unexpected protocol refusals must not pass a negative scenario.
    check(error instanceof WithdrawalProtocolError && error.code === code, `expected ${code}`);
    return;
  }
  throw new Error(`Withdrawal qualification source refused: expected ${code}, operation succeeded`);
}

/** Uses only the caller's tenant transaction; reads no OTP code/digest, secret, quote or receipt body. */
export async function financialSourceJournal<I extends WithdrawalIntent | ReducingIntent>(
  transaction: WithdrawalTransaction, userId: string, intentId: string
): Promise<FinancialSourceJournal<I>> {
  return transaction(userId, async client => {
    const record = await withdrawalSqlStore.byId<I>(client, userId, intentId);
    check(record, 'journal intent unavailable');
    const counts = (await client.query<JournalCounts>(`SELECT
      (SELECT count(*)::text FROM public.withdrawal_authorizations WHERE user_id=$1 AND intent_id=$2) AS authorizations,
      (SELECT count(*)::text FROM public.withdrawal_authorizations WHERE user_id=$1 AND intent_id=$2 AND consumed_at IS NOT NULL) AS consumed,
      (SELECT COALESCE(sum(failures),0)::text FROM public.withdrawal_authorizations WHERE user_id=$1 AND intent_id=$2) AS failures,
      (SELECT count(*)::text FROM public.withdrawal_reducing_outbox WHERE user_id=$1 AND intent_id=$2) AS outbox,
      (SELECT count(*)::text FROM public.withdrawal_reducing_outbox WHERE user_id=$1 AND intent_id=$2 AND intent_hash=$3) AS bound_outbox,
      (SELECT count(*)::text FROM public.withdrawal_reducing_attempts WHERE user_id=$1 AND intent_id=$2) AS attempts,
      (SELECT count(*)::text FROM public.withdrawal_reducing_applications WHERE user_id=$1 AND intent_id=$2) AS applications,
      (SELECT count(*)::text FROM public.withdrawal_reducing_receipts WHERE user_id=$1 AND intent_id=$2) AS admitted_receipts
      /* qualification:financial-journal */`, [userId, intentId, record.intentHash])).rows[0];
    check(counts, 'journal counts unavailable');
    const reservations = (await client.query<FinancialReservationProjection>(`SELECT
      budget_key,purpose,chain,network,mode,account_id,asset_id,asset_scale,
      amount_raw::text,fee_raw::text,reserved_raw::text
      FROM public.withdrawal_reducing_reservations WHERE user_id=$1 AND intent_id=$2 ORDER BY budget_key
      /* qualification:financial-reservations */`, [userId, intentId])).rows;
    return { record, counts, reservations };
  });
}
function requireReservedBudgets(rows: readonly FinancialReservationProjection[], budgets: FinancialBudget[]): void {
  check(rows.length === budgets.length, 'unexpected reservation count');
  for (const budget of budgets) {
    const row = rows.find(candidate => candidate.budget_key === financialBudgetKey(budget));
    check(row && row.purpose === budget.purpose && row.chain === budget.chain && row.network === budget.network
      && row.mode === budget.mode && row.account_id === budget.accountId && row.asset_id === budget.assetId
      && row.asset_scale === budget.assetScale && row.amount_raw === budget.amountRaw && row.fee_raw === budget.feeRaw
      && row.reserved_raw === (BigInt(budget.amountRaw) + BigInt(budget.feeRaw)).toString(), 'exact denomination/account reservation mismatch');
  }
}
function requireQueued<I extends WithdrawalIntent | ReducingIntent>(journal: FinancialSourceJournal<I>): void {
  check(journal.record.status === 'queued' && !journal.record.terminal && journal.record.completedRaw === '0', 'admission must not settle');
  check(journal.counts.outbox === '1' && journal.counts.bound_outbox === '1', 'one exact intent-bound outbox required');
  check(journal.counts.attempts === '0' && journal.counts.applications === '0' && journal.counts.admitted_receipts === '0',
    'source admission must not manufacture execution, receipts or accounting');
}

/** Calls the real service twice, but never captures, returns or reissues the delivered code. */
export async function qualifyWithdrawalOtpRequest(ports: WithdrawalQualificationPorts, userId: string, request: WithdrawalRequest) {
  const service = createWithdrawalService({ ...ports, store: withdrawalSqlStore });
  const first = await service.requestOtp(userId, request);
  const replay = await service.requestOtp(userId, request);
  check(!first.replay && replay.replay, 'fresh request plus immutable retry required');
  check(first.authorizationId === replay.authorizationId && first.authorizationExpiresAt === replay.authorizationExpiresAt
    && financialHash(first.intent) === financialHash(replay.intent), 'OTP request retry substituted authorization or intent');
  check(!('code' in first) && !('digest' in first), 'OTP projection must not expose secrets');
  const journal = await financialSourceJournal<WithdrawalIntent>(ports.transaction, userId, first.intent.id);
  check(journal.counts.authorizations === '1' && journal.counts.consumed === '0' && journal.counts.outbox === '0'
    && journal.reservations.length === 0 && journal.record.status === 'awaiting-authorization', 'OTP request queued or reserved funds');
  const result = first.delivery === 'sent' && replay.delivery === 'sent'
    ? observed('withdrawal-otp-request-replay', ['one authorization identity across retry', 'request neither reserves nor queues',
      'service projection excludes code and digest'], { intentId: first.intent.id, authorizationId: first.authorizationId })
    : blocked('withdrawal-otp-request-replay', ['withdrawal-otp-delivery-unconfirmed'], { delivery: first.delivery });
  return { authorization: first, result };
}

/**
 * SubmitWithdrawal is the actual production submission contract, not a capture port or a success flag.
 * Caller must obtain it through its existing protected delivery/submit path. This source cannot supply that path.
 * Exact consumed-code retry is intentionally idempotent; one-use means one consumption/reservation/outbox, not retry denial.
 */
export async function qualifyWithdrawalOneUse(ports: WithdrawalQualificationPorts, userId: string, input: SubmitWithdrawal): Promise<WithdrawalSourceResult> {
  const service = createWithdrawalService({ ...ports, store: withdrawalSqlStore });
  const first = await service.submit(userId, input);
  const before = await financialSourceJournal<WithdrawalIntent>(ports.transaction, userId, first.id);
  const replay = await service.submit(userId, input);
  const after = await financialSourceJournal<WithdrawalIntent>(ports.transaction, userId, first.id);
  requireQueued(after);
  check(after.counts.authorizations === '1' && after.counts.consumed === '1', 'authorization must be consumed once');
  requireReservedBudgets(after.reservations, withdrawalBudgets(first.intent));
  check(financialHash(first) === financialHash(replay) && financialHash(before) === financialHash(after), 'consumed OTP retry changed durable admission');
  return observed('withdrawal-otp-one-use-outbox', ['one consumed authorization and one intent-bound outbox',
    'exact principal and separate fee budgets', 'consumed exact-code retry leaves admission unchanged', 'no attempt or settlement created'],
  { intentId: first.id, journalHash: financialHash(after), reservationCount: after.reservations.length });
}

export type WithdrawalSubmitRefusal = 'withdrawal-otp-invalid' | 'withdrawal-otp-locked'
  | 'withdrawal-authorization-expired' | 'withdrawal-otp-delivery-unconfirmed' | 'withdrawal-cooling-off'
  | 'withdrawal-ownership-or-mode-changed' | 'withdrawal-balance-stale' | 'withdrawal-balance-insufficient';
export async function qualifyWithdrawalSubmitRefusal(ports: WithdrawalQualificationPorts, userId: string,
  input: SubmitWithdrawal, code: WithdrawalSubmitRefusal): Promise<WithdrawalSourceResult> {
  const service = createWithdrawalService({ ...ports, store: withdrawalSqlStore });
  const before = await financialSourceJournal<WithdrawalIntent>(ports.transaction, userId, input.intentId);
  await expectProtocolRefusal(() => service.submit(userId, input), code);
  const after = await financialSourceJournal<WithdrawalIntent>(ports.transaction, userId, input.intentId);
  if (code === 'withdrawal-otp-invalid' && /^[0-9]{6,10}$/.test(input.otp)
    && before.counts.consumed === '0' && BigInt(before.counts.failures) < 5n) {
    check(BigInt(after.counts.failures) === BigInt(before.counts.failures) + 1n, 'bad-code failure increment must commit');
    check(financialHash({ ...before, counts: { ...before.counts, failures: after.counts.failures } }) === financialHash(after),
      'bad-code failure changed financial state');
  } else check(financialHash(before) === financialHash(after), 'refusal changed financial journal');
  return observed(`withdrawal-submit-refuses-${code}`, ['exact production protocol refusal', 'no unauthorized financial admission'],
    { intentId: input.intentId, refusal: code, journalHash: financialHash(after) });
}

export async function qualifyWithdrawalCoolingRefusal(ports: WithdrawalQualificationPorts, userId: string,
  request: WithdrawalRequest): Promise<WithdrawalSourceResult> {
  const service = createWithdrawalService({ ...ports, store: withdrawalSqlStore });
  await expectProtocolRefusal(() => service.requestOtp(userId, request), 'withdrawal-cooling-off');
  await ports.transaction(userId, async client => {
    check(await withdrawalSqlStore.byKey<WithdrawalIntent>(client, userId, 'withdrawal', request.requestKey) === null,
      'cooling refusal did not roll back fresh intent');
  });
  return observed('withdrawal-cooling-before-otp', ['production 24-hour cooling gate refuses before issuance', 'fresh rejected intent rolls back'],
    { refusal: 'withdrawal-cooling-off' });
}

export async function qualifyReducingAdmission(ports: ReducingQualificationPorts, userId: string,
  request: ReducingRequest): Promise<WithdrawalSourceResult> {
  const service = createReducingService({ ...ports, store: withdrawalSqlStore });
  const first = await service.request(userId, request);
  const before = await financialSourceJournal<ReducingIntent>(ports.transaction, userId, first.id);
  const replay = await service.request(userId, request);
  const after = await financialSourceJournal<ReducingIntent>(ports.transaction, userId, first.id);
  requireQueued(after);
  requireReservedBudgets(after.reservations, reducingBudgets(first.intent));
  check(after.counts.authorizations === '0' && financialHash(first) === financialHash(replay)
    && financialHash(before) === financialHash(after), 'reducing retry changed admission');
  check(first.intent.side === (first.intent.positionSide === 'LONG' ? 'SELL' : 'BUY'), 'reducing side not derived from position');
  return observed('reducing-exact-admission', ['position-side-derived reducing direction', 'exact separate exposure and fee reservations',
    'one unchanged admission/outbox across retry', 'no receipt or accounting invented'],
  { intentId: first.id, journalHash: financialHash(after), venue: first.intent.venue });
}

export type ReducingAdmissionRefusal = 'reducing-independent-collateral-mapping-unavailable' | 'reducing-venue-mapping-scope-mismatch'
  | 'reducing-venue-mapping-stale' | 'reducing-would-cross-zero' | 'reducing-stale-revision'
  | 'reducing-exposure-stale' | 'reducing-ownership-or-mode-changed' | 'reducing-exposure-or-fee-reserved';
export async function qualifyReducingAdmissionRefusal(ports: ReducingQualificationPorts, userId: string,
  request: ReducingRequest, code: ReducingAdmissionRefusal): Promise<WithdrawalSourceResult> {
  const service = createReducingService({ ...ports, store: withdrawalSqlStore });
  await expectProtocolRefusal(() => service.request(userId, request), code);
  await ports.transaction(userId, async client => {
    check(await withdrawalSqlStore.byKey<ReducingIntent>(client, userId, 'reducing', request.requestKey) === null,
      'reducing refusal did not roll back fresh intent');
  });
  if (code === 'reducing-independent-collateral-mapping-unavailable') {
    const refusal = observed('reducing-perps-mapping-refusal', ['real reducing service refuses missing/unadmitted independent mapping',
      'fresh admission rolled back without outbox'], { refusal: code });
    return { ...refusal, state: 'blocked-on-external-capability', blocked: [...refusal.blocked,
      'restricted-independent-deployed-perps-collateral-mapping-writer-unavailable',
      'canonical-realized-pnl-collateral-and-margin-journal-unavailable'] };
  }
  return observed(`reducing-admission-refuses-${code}`, ['exact production protocol refusal', 'fresh rejected intent rolls back'], { refusal: code });
}

/**
 * Negative admission boundary only. A hostile receipt projection is NOT authenticated verifier output.
 * Existing attempt must come from the SQL store. No attempt/fence/admission/application is fabricated here.
 */
export async function qualifyUnadmittedReceipt(transaction: WithdrawalTransaction, userId: string, intentId: string,
  receipt: FinancialReceipt): Promise<WithdrawalSourceResult> {
  const before = await financialSourceJournal<WithdrawalIntent | ReducingIntent>(transaction, userId, intentId);
  const refused = await transaction(userId, async client => {
    const record = await withdrawalSqlStore.byId<WithdrawalIntent | ReducingIntent>(client, userId, intentId);
    check(record, 'receipt boundary intent unavailable');
    const current = await withdrawalSqlStore.getAttempt(client, record);
    if (!current) return false;
    check(!record.terminal && !current.terminal && current.state === 'uncertain', 'existing nonterminal uncertain attempt required');
    check(receipt.intentId === record.id && receipt.intentHash === record.intentHash && receipt.attemptId === current.id
      && receipt.clientOrderId === current.clientOrderId, 'hostile receipt must target the existing exact attempt');
    await expectProtocolRefusal(() => withdrawalSqlStore.admittedReceipt(client, record, current, receipt),
      'independent-receipt-admission-unavailable');
    return true;
  });
  const after = await financialSourceJournal<WithdrawalIntent | ReducingIntent>(transaction, userId, intentId);
  check(financialHash(before) === financialHash(after), 'unadmitted receipt changed durable journal');
  if (!refused) return blocked('financial-unadmitted-receipt', ['existing-production-uncertain-attempt-unavailable',
    'source-must-not-manufacture-authorized-dispatch-fence']);
  const result = observed('financial-unadmitted-receipt', ['actual SQL-store admission check refuses unadmitted receipt',
    'uncertain attempt, reservations and financial progress unchanged'], { intentId, journalHash: financialHash(after) });
  return { ...result, state: 'blocked-on-external-capability', blocked: [...result.blocked,
    'authenticated-provider-reconciliation-and-independent-restricted-receipt-writer-unavailable'] };
}

/** These are dependencies, not supported scenarios or successful acceptance assertions. */
export function blockedWithdrawalCapabilities(): readonly WithdrawalSourceResult[] {
  return [
    blocked('protected-otp-capture-and-delivery', ['protected-existing-otp-key-verified-recipient-and-principal-channel-backing-not-approved',
      'concrete-source-otp-and-capture-do-not-establish-deployed-authority',
      'source-will-not-log-capture-or-return-otp-secrets']),
    blocked('outbox-dispatch-uncertain-reconciliation', ['pool-free-owned-runner-source-does-not-authorize-runtime-execution',
      'provider-authenticated-attempt-bound-atomic-deadline-transfer-authority-unavailable',
      'authenticated-receipt-verifier-and-independent-restricted-admission-writer-unavailable',
      'permanent-provider-no-future-acceptance-tombstone-required-for-terminal-zero-fill',
      'no-crash-worker-queue-or-provider-execution-authorized']),
    blocked('reducing-exact-receipt-accounting-collateral', ['pool-free-canonical-perps-settler-source-does-not-establish-deployed-role-function-backing',
      'immutable-financial-intent-attempt-to-canonical-spot-lot-execution-receipt-linkage-source-gap',
      'canonical-withdrawal-and-spot-independent-ledger-admission-writer-source-backing-gap',
      'independent-deployed-perps-collateral-denomination-account-mapping-unavailable',
      'canonical-every-fill-realized-pnl-collateral-margin-and-fee-journal-unavailable',
      'same-client-receipt-accounting-application-and-deferred-commit-acceptance-unobserved'])
  ];
}

/** Joined owned source APIs are separate from public/domain catalogue acceptance. */
export { createWithdrawalOwnedComposition, withdrawalOwnedBoundary } from './withdrawal-owned-composition.js';
export { createReducingOwnedComposition, reducingOwnedBoundary } from './reducing-owned-composition.js';
