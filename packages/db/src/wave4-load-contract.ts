import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalSourceBinding, sourceBindingDigest, sourceTokenQuantity,
  type SourceVerificationBinding } from './source-verification.js';
import { workerMoney, workerQuantity, type WorkerFinancialTotals } from './worker-valuation-corrections.js';

/** Inert comparison contracts. None of these values is a runtime capability. */
export interface LoadScope {
  readonly runId: string;
  readonly namespace: string;
  readonly network: string;
  readonly backendIdentity: string;
}
export interface LoadRawAmount { readonly raw: string; readonly scale: number }
export interface LoadFixture {
  readonly scope: LoadScope;
  readonly fixtureId: string;
  readonly userId: string;
  readonly kind: 'wallet' | 'token';
  readonly walletAddress: string;
  readonly tokenMint: string;
  readonly targetAccount: string;
  readonly binding: SourceVerificationBinding;
  /** Independent expected outcome amounts, never sizing/valuation authority. */
  readonly base: LoadRawAmount;
  readonly quoteBudget: LoadRawAmount;
  readonly quote: LoadRawAmount;
  readonly fee: LoadRawAmount;
  readonly requestDigest: string;
}
export interface LoadHttpAttempt {
  readonly attemptId: string;
  readonly fixtureId: string;
  readonly runId: string;
  readonly namespace: string;
  readonly userId: string;
  readonly requestDigest: string;
  readonly route: '/v1/me/wallets' | '/v1/me/tokens/backfill';
  readonly status: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}
export interface LoadProtectedCapturePort {
  assertInvocationWithClient(client: PoolClient, input: Readonly<{
    scope: LoadScope; fixture: LoadFixture; attempt: LoadHttpAttempt;
    principal: { readonly kind: 'user'; readonly userId: string }; stage: 'source' | 'fanout' | 'worker';
  }>): Promise<void>;
  /** Same-client protected durable correlation; commits with canonical obligation.
   * Replay must reference original identity, never create a new economic effect. */
  bindCanonicalWithClient(client: PoolClient, input: Readonly<{
    scope: LoadScope; fixtureId: string; attemptId: string; userId: string;
    sourceTradeId: string; signalId: string; executionId: string; jobId: string;
  }>): Promise<void>;
}
/** Independently exported protected admission, never manufactured from HTTP 2xx,
 * a queue result, a non-null execution id or an adapter callback return value. */
export interface LoadAdmission {
  readonly attemptId: string;
  readonly fixtureId: string;
  readonly runId: string;
  readonly namespace: string;
  readonly userId: string;
  readonly requestDigest: string;
  readonly outcome: 'admitted' | 'replay' | 'refused';
  readonly reason: string | null;
  readonly sourceTradeId: string | null;
  readonly signalId: string | null;
  readonly executionId: string | null;
  readonly jobId: string | null;
  readonly admittedAt: string;
}
export interface LoadFinancialReceipt {
  readonly receiptId: string;
  readonly snapshot: { readonly executionId: string; readonly userId: string; readonly tradeId: string;
    readonly fence: string; readonly totals: WorkerFinancialTotals & { readonly invalidCorrections: string };
    readonly accountingComplete: boolean };
}
export interface LoadDurableSnapshot {
  readonly scope: LoadScope;
  readonly sources: readonly { id: string; binding: SourceVerificationBinding; bindingDigest: string;
    accepted: boolean; evidenceId: string; finality: string; applicationActive: boolean }[];
  readonly executions: readonly { id: string; signalId: string; sourceTradeId: string; userId: string;
    targetAccount: string; chain: string; tokenMint: string; direction: string; executionMode: string; state: string;
    requestedBase: string | null; requestedQuote: string | null; confirmedBase: string;
    confirmedQuote: string | null; quoteUnknown: string }[];
  readonly deliveries: readonly { executionId: string; signalId: string; userId: string; targetAccount: string;
    executionMode: string; jobId: string; state: string; fence: string; descriptor: unknown }[];
  readonly workerAttempts: readonly { executionId: string; userId: string; fence: string;
    policyRevision: string; riskEpoch: string | null; state: string }[];
  readonly evidence: readonly { id: string; executionId: string; userId: string; sourceTradeId: string;
    evidenceId: string; evidenceType: string; confirmationState: string; completes: boolean;
    base: string; quote: string | null; fee: string | null; quoteCurrency: string | null;
    nativeQuote: string | null; nativePrice: string | null; effectiveQuote: string | null;
    effectiveFee: string | null; correctionId: string | null; applicationActive: boolean }[];
  readonly trades: readonly { id: string; executionId: string; userId: string; signalId: string;
    sourceTradeId: string; tokenMint: string; chain: string; direction: string; executionMode: string;
    base: string; quote: string | null; fee: string | null; status: string }[];
  readonly receipts: readonly LoadFinancialReceipt[];
  readonly applications: readonly { evidenceId: string; executionId: string; positionId: string;
    userId: string; targetAccount: string; tokenMint: string; chain: string; active: boolean }[];
  readonly positions: readonly { id: string; userId: string; targetAccount: string; tokenMint: string;
    chain: string; base: string; basis: string }[];
  readonly lots: readonly { id: string; positionId: string; userId: string; tokenMint: string; chain: string;
    masterWalletAddress: string; acquisitionExecutionId: string; acquisitionEvidenceId: string;
    acquisitionSourceTradeId: string; acquisitionMode: string; acquiredBase: string; remainingBase: string;
    acquiredBasis: string; remainingBasis: string }[];
  readonly risk: readonly { executionId: string; account: string; epoch: string; state: string; debit: string | null;
    liability: string | null; chain: string; executionMode: string }[];
  readonly capacity: readonly { sourceTradeId: string; executionMode: string; notional: string;
    chain: string; tokenMint: string; masterWalletAddress: string }[];
  readonly corrections: readonly { executionId: string; correctionId: string }[];
  readonly reductions: readonly { executionId: string; evidenceId: string; lotId: string }[];
}
export function loadCheck(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Load durable contract: ${reason}`);
}
export function loadUuid(value: unknown): asserts value is string {
  loadCheck(typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value), 'canonical UUID required');
}
export function loadText(value: unknown, maximum = 512): asserts value is string {
  loadCheck(typeof value === 'string' && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), 'bounded canonical text required');
}
export function loadTime(value: unknown): asserts value is string {
  loadCheck(typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value, 'canonical UTC time required');
}
export function loadScope(input: LoadScope): LoadScope {
  loadUuid(input?.runId); loadText(input.backendIdentity);
  loadCheck(input.namespace === `wave4-load-${input.runId}` && input.network === `solana:wave4-${input.runId}`,
    'exact run-bound namespace/network required');
  return Object.freeze({ runId: input.runId, namespace: input.namespace, network: input.network, backendIdentity: input.backendIdentity });
}
export function loadEqual(actual: unknown, expected: unknown, reason: string): void {
  loadCheck(loadJson(actual) === loadJson(expected), reason);
}
export function loadJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(loadJson).join(',')}]`;
  loadCheck(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    'inert JSON only; no functions, prototypes, floats, dates or authority objects');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${loadJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
export function loadDigest(value: unknown): string { return createHash('sha256').update(loadJson(value)).digest('hex'); }
export function loadReceiptDigest(snapshot: LoadFinancialReceipt['snapshot']): string {
  const t = snapshot.totals;
  // Actual production worker-settlement.ts snapshot insertion order (SQL080 includes invalidCorrections).
  return createHash('sha256').update(JSON.stringify({ executionId: snapshot.executionId, userId: snapshot.userId,
    tradeId: snapshot.tradeId, fence: snapshot.fence, totals: { base: t.base, quote: t.quote, debit: t.debit, fee: t.fee,
      unknown: t.unknown, quoteUnknown: t.quoteUnknown, completes: t.completes, evidenceCount: t.evidenceCount,
      invalidCorrections: t.invalidCorrections },
    accountingComplete: snapshot.accountingComplete })).digest('hex');
}
/** Exact conversion independently checks final decimals against raw units. */
export function loadAmount(input: LoadRawAmount, money = false): string {
  loadCheck(input && typeof input.raw === 'string' && input.raw.trim() === input.raw && /^(0|[1-9]\d{0,77})$/.test(input.raw)
    && Number.isSafeInteger(input.scale) && input.scale >= 0 && input.scale <= 18, 'canonical bounded raw/scale required');
  const divisor = 10n ** BigInt(input.scale), raw = BigInt(input.raw);
  const fraction = (raw % divisor).toString().padStart(input.scale, '0').replace(/0+$/, '');
  const value = `${raw / divisor}${fraction ? `.${fraction}` : ''}`;
  loadCheck((money ? workerMoney(value) : workerQuantity(value)) === value, 'production exact domain mismatch');
  return value;
}
export function loadUnits(value: string, money = false): bigint {
  loadCheck(typeof value === 'string' && (money ? workerMoney(value) : workerQuantity(value)) === value,
    'canonical exact decimal required');
  const [whole, fraction = ''] = value.split('.');
  loadCheck(fraction.length <= 18, 'exact scale exceeds worker accounting domain');
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
export function loadDecimal(value: bigint): string {
  loadCheck(value >= 0n, 'negative conservation');
  const fraction = (value % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return `${value / 10n ** 18n}${fraction ? `.${fraction}` : ''}`;
}
export function loadFixtureRequest(fixture: Pick<LoadFixture, 'scope' | 'fixtureId' | 'userId' | 'kind' | 'walletAddress' | 'tokenMint'>) {
  return { runId: fixture.scope.runId, namespace: fixture.scope.namespace, fixtureId: fixture.fixtureId,
    userId: fixture.userId, method: 'POST', route: fixture.kind === 'wallet' ? '/v1/me/wallets' : '/v1/me/tokens/backfill',
    body: fixture.kind === 'wallet' ? { address: fixture.walletAddress.slice(7), chain: 'solana' }
      : { tokenMint: fixture.tokenMint.slice(7), chain: 'solana' } };
}
export function captureLoadFixture(input: LoadFixture): LoadFixture {
  loadCheck(input && typeof input === 'object', 'fixture required');
  const fixture = JSON.parse(loadJson(input)) as LoadFixture;
  const scope = loadScope(fixture.scope);
  loadUuid(fixture.fixtureId); loadUuid(fixture.userId);
  loadCheck(['wallet', 'token'].includes(fixture.kind), 'wallet/token fixture required');
  for (const address of [fixture.walletAddress, fixture.tokenMint, fixture.targetAccount]) {
    loadCheck(typeof address === 'string' && /^solana:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address), 'canonical Solana fixture address required');
  }
  const binding = canonicalSourceBinding(fixture.binding);
  loadEqual(fixture.binding, binding, 'source binding must already be canonical');
  loadCheck(binding.chain === 'solana' && binding.network === scope.network && binding.walletAddress === fixture.walletAddress
    && binding.tokenMint === fixture.tokenMint && binding.side === 'buy'
    && binding.sourceEventId === `${scope.namespace}/${fixture.fixtureId}`
    && binding.transactionHash === binding.sourceEventId && binding.sourceEventType === 'transaction'
    && binding.sourceEventIndex === '0', 'contained run-bound acquisition binding required');
  sourceTokenQuantity(binding.rawQuantity, binding.quantityScale);
  loadCheck(loadUnits(loadAmount(fixture.base)) > 0n && loadUnits(loadAmount(fixture.quote, true), true) > 0n,
    'positive independent follower base/quote required');
  loadCheck(loadUnits(loadAmount(fixture.quoteBudget, true), true) > 0n
    && loadUnits(loadAmount(fixture.quote, true), true) <= loadUnits(loadAmount(fixture.quoteBudget, true), true),
    'independent expected fill quote cannot exceed independently expected trusted budget');
  loadAmount(fixture.fee, true);
  loadCheck(fixture.requestDigest === loadDigest(loadFixtureRequest(fixture)), 'exact authenticated request binding required');
  return Object.freeze({ ...fixture, scope, binding, base: Object.freeze(fixture.base), quoteBudget: Object.freeze(fixture.quoteBudget),
    quote: Object.freeze(fixture.quote), fee: Object.freeze(fixture.fee) });
}
export function loadFixtureBindingDigest(fixture: LoadFixture): string { return sourceBindingDigest(fixture.binding); }
