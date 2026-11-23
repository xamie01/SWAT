import { createHash } from 'node:crypto';

/** Independent qualification arithmetic. No production SUM, decimal helper,
 * fixture-certified snapshot, price cache, queue status or runtime authority. */
export interface PipelineExact { readonly raw: string; readonly scale: number }
export interface ExecutedPipelineScope {
  readonly runId: string; readonly network: string; readonly namespace: string;
  readonly chain: 'solana'; readonly userId: string; readonly targetAccount: string;
  readonly masterWalletAddress: string; readonly tokenMint: string;
}
export type ExecutedPipelineStage = 'buy' | 'sell' | 'reversal' | 'correction' | 'replay';
export interface ExecutedSource {
  readonly id: string; readonly chain: string; readonly walletAddress: string; readonly tokenMint: string;
  readonly direction: string; readonly quantity: string; readonly amountUsd: string | null;
  readonly priceUsd: string | null; readonly feeUsd: string | null; readonly eventAt: string;
  readonly confirmationState: string; readonly binding: Record<string, unknown> | null;
  readonly bindingDigest: string | null; readonly headEvidenceId: string | null;
  readonly headRevision: string | null; readonly headState: string | null; readonly applicationActive: boolean | null;
}
export interface ExecutedExecution {
  readonly id: string; readonly signalId: string | null; readonly sourceTradeId: string | null;
  readonly userId: string | null; readonly chain: string; readonly targetAccount: string; readonly tokenMint: string;
  readonly executionMode: string; readonly direction: string; readonly state: string; readonly clientOrderId: string;
  readonly requestedBase: string | null; readonly requestedQuote: string | null;
  readonly confirmedBase: string; readonly confirmedQuote: string | null; readonly quoteUnknown: string;
  readonly sourcePositionBefore: string | null; readonly sourceSellFraction: string | null;
}
export interface ExecutedOriginalEvidence {
  readonly id: string; readonly executionId: string; readonly userId: string | null; readonly sourceTradeId: string | null;
  readonly evidenceType: string; readonly evidenceId: string; readonly base: string; readonly quote: string | null;
  readonly nativeQuote: string | null; readonly quoteCurrency: string | null; readonly nativePrice: string | null;
  readonly price: string | null; readonly fee: string | null; readonly occurredAt: string;
  readonly completes: boolean; readonly confirmationState: string;
}
export interface ExecutedEffectiveEvidence {
  readonly id: string; readonly executionId: string; readonly base: string; readonly quote: string | null;
  readonly fee: string | null; readonly correctionId: string | null; readonly confirmationState: string;
}
/** Raw committed rows retain every scanned identity/history field. Numeric SQL
 * columns are selected as text; JSON snapshots must themselves use exact text. */
export type PipelineSqlRow = Readonly<Record<string, unknown>>;
export interface ExecutedPipelineSnapshot {
  readonly stage: ExecutedPipelineStage; readonly sources: readonly ExecutedSource[];
  readonly executions: readonly ExecutedExecution[]; readonly originals: readonly ExecutedOriginalEvidence[];
  readonly effective: readonly ExecutedEffectiveEvidence[];
  readonly providers: readonly PipelineSqlRow[]; readonly sourceBindings: readonly PipelineSqlRow[];
  readonly sourceEvidence: readonly PipelineSqlRow[]; readonly sourceHeads: readonly PipelineSqlRow[];
  readonly sourceHistory: readonly PipelineSqlRow[]; readonly sourceEconomicHistory: readonly PipelineSqlRow[];
  readonly sourceApplications: readonly PipelineSqlRow[]; readonly sourceScopes: readonly PipelineSqlRow[];
  readonly sourcePositions: readonly PipelineSqlRow[]; readonly signals: readonly PipelineSqlRow[];
  readonly batches: readonly PipelineSqlRow[]; readonly deliveries: readonly PipelineSqlRow[];
  readonly policies: readonly PipelineSqlRow[]; readonly attempts: readonly PipelineSqlRow[];
  readonly capabilities: readonly PipelineSqlRow[]; readonly paperValuations: readonly PipelineSqlRow[];
  readonly paperReceipts: readonly PipelineSqlRow[]; readonly valuationAuthorities: readonly PipelineSqlRow[];
  readonly trustedValuations: readonly PipelineSqlRow[]; readonly corrections: readonly PipelineSqlRow[];
  readonly financialReceipts: readonly PipelineSqlRow[]; readonly trades: readonly PipelineSqlRow[];
  readonly applications: readonly PipelineSqlRow[]; readonly positions: readonly PipelineSqlRow[];
  readonly lots: readonly PipelineSqlRow[]; readonly reductions: readonly PipelineSqlRow[];
  readonly allocations: readonly PipelineSqlRow[]; readonly riskPolicies: readonly PipelineSqlRow[];
  readonly risk: readonly PipelineSqlRow[]; readonly capacity: readonly PipelineSqlRow[];
}
export interface ExecutedPipelineJournal {
  readonly kind: 'canonical-executed-paper-pipeline'; readonly scope: ExecutedPipelineScope;
  readonly snapshots: readonly ExecutedPipelineSnapshot[];
  /** Always false: a source authoring/inert reconciliation is not execution qualification. */
  readonly runtimeAccepted: false; readonly sourceComplete: false; readonly liveCapabilityAccepted: false;
}
export function pipelineCheck(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`Executed pipeline: ${reason}`);
}
export function pipelineCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return JSON.stringify(value);
  pipelineCheck(value && typeof value === 'object', 'inert exact JSON required');
  pipelineCheck(Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value), 'plain JSON required');
  if (Array.isArray(value)) return `[${value.map(pipelineCanonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    pipelineCheck('value' in d && d.value !== undefined, 'accessor/undefined JSON refused');
    return `${JSON.stringify(key)}:${pipelineCanonical(d.value)}`;
  }).join(',')}}`;
}
export function pipelineEqual(a: unknown, b: unknown, reason: string): void {
  pipelineCheck(pipelineCanonical(a) === pipelineCanonical(b), reason);
}
export function exactPipelineDecimal(text: string): PipelineExact {
  pipelineCheck(typeof text === 'string' && text.length <= 334 && /^(0|[1-9]\d*)(?:\.\d+)?$/.test(text), 'exact nonnegative decimal required');
  const [whole, fraction = ''] = text.split('.');
  pipelineCheck(fraction.length <= 255, 'unsupported exact scale');
  return { raw: BigInt(`${whole}${fraction}`).toString(), scale: fraction.length };
}
export function pipelineExactText(value: PipelineExact): string {
  pipelineCheck(/^(0|[1-9]\d*)$/.test(value.raw) && Number.isSafeInteger(value.scale) && value.scale >= 0 && value.scale <= 510,
    'canonical raw-scale required');
  const digits = value.raw.padStart(value.scale + 1, '0');
  return value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`.replace(/0+$/, '').replace(/\.$/, '');
}
function aligned(a: PipelineExact, b: PipelineExact) {
  const scale = Math.max(a.scale, b.scale);
  return { a: BigInt(a.raw) * 10n ** BigInt(scale - a.scale), b: BigInt(b.raw) * 10n ** BigInt(scale - b.scale), scale };
}
function add(a: PipelineExact, b: PipelineExact): PipelineExact { const n = aligned(a, b); return { raw: (n.a + n.b).toString(), scale: n.scale }; }
function subtract(a: PipelineExact, b: PipelineExact): PipelineExact {
  const n = aligned(a, b); pipelineCheck(n.a >= n.b, 'negative inventory/basis'); return { raw: (n.a - n.b).toString(), scale: n.scale };
}
function compare(a: PipelineExact, b: PipelineExact): number { const n = aligned(a, b); return n.a < n.b ? -1 : n.a > n.b ? 1 : 0; }
function multiply(a: PipelineExact, b: PipelineExact): PipelineExact { return { raw: (BigInt(a.raw) * BigInt(b.raw)).toString(), scale: a.scale + b.scale }; }
function divide(a: PipelineExact, b: PipelineExact, scale: number, floor = false): PipelineExact {
  pipelineCheck(BigInt(b.raw) > 0n, 'division by zero');
  const numerator = BigInt(a.raw) * 10n ** BigInt(b.scale + scale), denominator = BigInt(b.raw) * 10n ** BigInt(a.scale);
  pipelineCheck(floor || numerator % denominator === 0n, 'basis outside exactly representable qualified scenario');
  return { raw: (numerator / denominator).toString(), scale };
}
const ZERO: PipelineExact = { raw: '0', scale: 0 };
function money(value: unknown): PipelineExact {
  pipelineCheck(typeof value === 'string', 'money must be exact text');
  const n = exactPipelineDecimal(value); pipelineCheck(n.scale <= 18 && value.split('.')[0]!.length <= 20, 'SQL080 money bounds'); return n;
}
function text(row: PipelineSqlRow, key: string): string { const v = row[key]; pipelineCheck(typeof v === 'string', `missing ${key}`); return v; }
function amount(row: PipelineSqlRow, key: string): PipelineExact { return money(row[key]); }
function one<T>(rows: readonly T[], predicate: (r: T) => boolean, reason: string): T {
  const found = rows.filter(predicate); pipelineCheck(found.length === 1, reason); return found[0]!;
}
function sameDecimal(a: unknown, b: PipelineExact, reason: string): void {
  pipelineCheck(typeof a === 'string' && compare(exactPipelineDecimal(a), b) === 0, reason);
}
export interface PipelinePaperTerms {
  readonly direction: 'buy' | 'sell'; readonly requestedBase: string | null; readonly requestedQuote: string | null;
  readonly baseDecimals: number; readonly priceUsd: string; readonly simulatedFeeBps: string; readonly simulatedFixedFeeUsd: string;
}
/** rawQuantity in protected valuation is SOURCE raw, not follower fill raw. */
export function foldProtectedPaperTerms(v: PipelinePaperTerms) {
  pipelineCheck(Number.isSafeInteger(v.baseDecimals) && v.baseDecimals >= 0 && v.baseDecimals <= 36, 'protected asset scale required');
  const price = money(v.priceUsd), bps = money(v.simulatedFeeBps), fixed = money(v.simulatedFixedFeeUsd);
  pipelineCheck(compare(price, ZERO) > 0 && compare(bps, exactPipelineDecimal('10000')) <= 0, 'positive price/bounded fee required');
  let base: PipelineExact;
  if (v.direction === 'buy') {
    pipelineCheck(v.requestedBase === null && v.requestedQuote !== null, 'buy must retain null base and exact quote budget');
    base = divide(money(v.requestedQuote), price, v.baseDecimals, true);
    pipelineCheck(compare(base, ZERO) > 0, 'quote budget rounds below one raw unit');
  } else {
    pipelineCheck(v.direction === 'sell' && v.requestedBase !== null && v.requestedQuote === null, 'sell must retain exact base only');
    base = divide(exactPipelineDecimal(v.requestedBase), exactPipelineDecimal('1'), v.baseDecimals);
  }
  const quote = multiply(base, price), fee = add(fixed, multiply(multiply(quote, bps), exactPipelineDecimal('0.0001')));
  for (const n of [quote, fee, add(quote, fee)]) money(pipelineExactText(n));
  return { fillRaw: base.raw, fillScale: base.scale, base: pipelineExactText(base), quote: pipelineExactText(quote),
    fee: pipelineExactText(fee), debit: pipelineExactText(add(quote, fee)), price: pipelineExactText(price) };
}
export function executedOriginalSnapshot(f: ExecutedOriginalEvidence) {
  return { id: f.id, executionId: f.executionId, userId: f.userId, sourceTradeId: f.sourceTradeId,
    evidenceType: f.evidenceType, evidenceId: f.evidenceId, baseQuantity: pipelineExactText(exactPipelineDecimal(f.base)),
    quoteQuantity: f.quote === null ? null : pipelineExactText(money(f.quote)),
    quoteNativeQuantity: f.nativeQuote === null ? null : pipelineExactText(exactPipelineDecimal(f.nativeQuote)),
    quoteCurrency: f.quoteCurrency, quoteNativeUsdPrice: f.nativePrice === null ? null : pipelineExactText(money(f.nativePrice)),
    priceUsd: f.price === null ? null : pipelineExactText(money(f.price)), feeUsd: f.fee === null ? null : pipelineExactText(money(f.fee)),
    occurredAt: f.occurredAt, completesExecution: f.completes };
}
function receiptDigest(snapshot: PipelineSqlRow): string {
  const totals = snapshot.totals as PipelineSqlRow;
  pipelineCheck(totals && typeof totals === 'object', 'receipt exact totals required');
  return createHash('sha256').update(JSON.stringify({ executionId: snapshot.executionId, userId: snapshot.userId,
    tradeId: snapshot.tradeId, fence: snapshot.fence, totals: { base: totals.base, quote: totals.quote, debit: totals.debit,
      fee: totals.fee, unknown: totals.unknown, quoteUnknown: totals.quoteUnknown, completes: totals.completes,
      evidenceCount: totals.evidenceCount }, accountingComplete: snapshot.accountingComplete })).digest('hex');
}
/** Exactly one acquisition, one partial source sell, source-only reversal, one
 * full immutable acquisition quote+fee correction, idempotent replay. Arbitrary
 * partial-fill/correction chains remain refused rather than guessed. */
export function reconcileExecutedPipelineJournal(journal: ExecutedPipelineJournal) {
  pipelineCheck(journal.kind === 'canonical-executed-paper-pipeline' && journal.runtimeAccepted === false
    && journal.sourceComplete === false && journal.liveCapabilityAccepted === false, 'source authoring cannot certify runtime acceptance');
  const scope = journal.scope;
  pipelineCheck(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(scope.runId)
    && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(scope.userId)
    && scope.network === `solana:wave4-${scope.runId}` && scope.namespace === `wave4/${scope.runId}/pipeline`
    && scope.chain === 'solana' && [scope.tokenMint, scope.targetAccount, scope.masterWalletAddress]
      .every(x => x.startsWith('solana:') && x.length > 7 && x.trim() === x), 'run-bound exact owned scope required');
  pipelineEqual(journal.snapshots.map(s => s.stage), ['buy','sell','reversal','correction','replay'], 'ordered five stages required');
  let previous: ExecutedPipelineSnapshot | null = null;
  for (const s of journal.snapshots) {
    const initial = s.stage === 'buy', reversed = ['reversal','correction','replay'].includes(s.stage);
    const corrected = ['correction','replay'].includes(s.stage);
    pipelineCheck(s.sources.length === (initial ? 1 : 2) && s.executions.length === s.sources.length
      && s.originals.length === s.executions.length && s.effective.length === s.originals.length, 'missing/extra canonical scoped row');
    for (const rows of [s.sources, s.executions, s.originals, s.effective]) pipelineCheck(new Set(rows.map(r => r.id)).size === rows.length, 'duplicate durable identity');
    const sourceBuy = one(s.sources, r => r.direction === 'buy', 'one buy source');
    let sourceQuantity = ZERO, sourceBasis = ZERO;
    for (const source of [...s.sources].sort((a,b) => a.eventAt.localeCompare(b.eventAt) || a.id.localeCompare(b.id))) {
      pipelineCheck(source.chain === scope.chain && source.walletAddress === scope.masterWalletAddress && source.tokenMint === scope.tokenMint
        && source.binding?.network === scope.network && source.binding.rawQuantity !== undefined && source.binding.quantityScale !== undefined
        && source.headState === source.confirmationState && source.headEvidenceId !== null, 'source immutable scope/head incomplete');
      const raw = { raw: source.binding.rawQuantity as string, scale: source.binding.quantityScale as number };
      sameDecimal(source.quantity, raw, 'source quantity not exact raw-scale binding');
      const head = one(s.sourceEvidence, r => r.evidence_id === source.headEvidenceId, 'source head evidence missing');
      pipelineCheck(head.source_trade_id === source.id && head.binding_digest === source.bindingDigest && head.finality === source.headState,
        'source head/evidence mismatch');
      const provider = one(s.providers, r => r.authority_id === head.authority_id, 'independent source provider missing');
      pipelineCheck(provider.enabled === true && provider.chain === scope.chain && provider.network === scope.network
        && provider.provider_id === head.provider_id && provider.identity_digest === head.provider_identity_digest
        && provider.verifier_version === head.verifier_version, 'provider evidence scope mismatch');
      if (source.direction === 'sell' && reversed) {
        pipelineCheck(source.headState === 'reversed' && source.applicationActive === false && typeof head.reverses_evidence_id === 'string', 'source reversal did not deactivate source only');
        const originalHead = one(s.sourceEvidence, r => r.evidence_id === head.reverses_evidence_id, 'reversal immutable predecessor missing');
        pipelineCheck(originalHead.source_trade_id === source.id && originalHead.authority_id === head.authority_id
          && BigInt(text(head,'revision')) > BigInt(text(originalHead,'revision')), 'source reversal revision/authority mismatch');
      } else {
        pipelineCheck(source.applicationActive === true && ['confirmed','finalized'].includes(source.confirmationState), 'source not accepted/applied');
        if (source.direction === 'buy') { sourceQuantity = add(sourceQuantity, raw); sourceBasis = add(sourceBasis,
          source.amountUsd === null ? multiply(raw, money(source.priceUsd)) : money(source.amountUsd)); }
        else { pipelineCheck(compare(sourceQuantity, raw) >= 0, 'unmatched source sell outside scenario');
          sourceBasis = divide(multiply(sourceBasis, subtract(sourceQuantity, raw)), sourceQuantity, 18); sourceQuantity = subtract(sourceQuantity, raw); }
      }
    }
    const sourcePosition = one(s.sourcePositions, () => true, 'one canonical wallet projection');
    sameDecimal(sourcePosition.balance, sourceQuantity, 'source quantity fold mismatch'); sameDecimal(sourcePosition.cost_basis_usd, sourceBasis, 'source basis fold mismatch');
    sameDecimal(sourcePosition.unmatched_reduction_quantity, ZERO, 'unmatched source reduction');
    let quantity = ZERO, basis = ZERO;
    const ordered = [...s.executions].sort((a,b) => a.direction === b.direction ? a.id.localeCompare(b.id) : a.direction === 'buy' ? -1 : 1);
    for (const e of ordered) {
      pipelineCheck(e.userId === scope.userId && e.chain === scope.chain && e.targetAccount === scope.targetAccount
        && e.tokenMint === scope.tokenMint && e.executionMode === 'paper' && e.state === 'confirmed' && e.quoteUnknown === '0', 'foreign/incomplete execution');
      const source = one(s.sources, r => r.id === e.sourceTradeId && r.direction === e.direction, 'execution source lineage');
      const original = one(s.originals, r => r.executionId === e.id, 'one immutable original fill');
      const effective = one(s.effective, r => r.id === original.id && r.executionId === e.id, 'one effective fill');
      pipelineCheck(original.userId === e.userId && original.sourceTradeId === e.sourceTradeId && original.evidenceType === 'paper_simulation'
        && original.completes && original.confirmationState === 'confirmed' && effective.confirmationState === 'confirmed'
        && original.nativeQuote === null && original.nativePrice === null && original.quoteCurrency === 'USD', 'original receipt scope/coverage');
      const valuation = one(s.paperValuations, r => r.executionId === e.id, 'independent persisted paper valuation required');
      pipelineCheck(valuation.userId === scope.userId && valuation.chain === scope.chain && valuation.tokenMint === scope.tokenMint
        && valuation.targetAccount === scope.targetAccount && valuation.sourceTradeId === source.id && valuation.network === scope.network
        && valuation.rawQuantity === source.binding!.rawQuantity && valuation.quantityScale === source.binding!.quantityScale
        && valuation.requestedBase === e.requestedBase && valuation.requestedQuote === e.requestedQuote, 'protected paper valuation/source/sizing mismatch');
      const expected = foldProtectedPaperTerms(valuation as unknown as PipelinePaperTerms);
      pipelineEqual([pipelineExactText(exactPipelineDecimal(original.base)), original.quote === null ? null : pipelineExactText(money(original.quote)),
        original.price === null ? null : pipelineExactText(money(original.price)), original.fee === null ? null : pipelineExactText(money(original.fee))],
      [expected.base,expected.quote,expected.price,expected.fee], 'original differs from protected raw-scale price/fee fold');
      sameDecimal(e.confirmedBase, exactPipelineDecimal(expected.base), 'confirmed inventory differs from protected fill');
      sameDecimal(effective.base, exactPipelineDecimal(original.base), 'correction changed immutable base');
      if (e.direction === 'buy') pipelineCheck(e.requestedBase === null && e.requestedQuote !== null, 'base-sized buy lie refused');
      const delivery = one(s.deliveries, r => r.execution_id === e.id, 'durable execution obligation');
      pipelineCheck(delivery.user_id === scope.userId && delivery.signal_id === e.signalId && delivery.target_account === scope.targetAccount
        && delivery.execution_mode === 'paper' && delivery.state === 'completed', 'delivery owner/state mismatch');
      const descriptor = delivery.descriptor as { data: Record<string, unknown>; options: Record<string, unknown> };
      pipelineCheck(descriptor?.data?.copyExecutionId === e.id && descriptor.data.sourceTradeId === source.id && descriptor.data.signalId === e.signalId
        && descriptor.data.userId === scope.userId && descriptor.data.requestedBaseQuantity === e.requestedBase
        && (descriptor.data.requestedQuoteQuantity === e.requestedQuote || (typeof descriptor.data.requestedQuoteQuantity === 'string'
          && e.requestedQuote !== null && compare(money(descriptor.data.requestedQuoteQuantity),money(e.requestedQuote)) === 0))
        && descriptor.data.masterWalletAddress === scope.masterWalletAddress && descriptor.data.tokenMint === scope.tokenMint
        && descriptor.data.executionMode === 'paper' && descriptor.data.targetAccount === scope.targetAccount
        && descriptor.options.jobId === delivery.job_id, 'immutable committed queue descriptor mismatch');
      const batch = one(s.batches, r => r.signal_id === e.signalId && r.source_trade_id === source.id, 'committed fanout cohort');
      pipelineCheck(batch.state === 'complete' && Array.isArray(batch.exclusion_snapshot)
        && batch.exclusion_snapshot.some((x: unknown) => (x as PipelineSqlRow).userId === null
          && (x as PipelineSqlRow).code === 'operator-obligation-domain-unsupported'), 'explicit durable operator exclusion');
      const attempt = one(s.attempts, r => r.execution_id === e.id, 'canonical worker attempt');
      pipelineCheck(attempt.user_id === scope.userId && attempt.state === 'settled' && attempt.fence === delivery.fence, 'worker fence/owner mismatch');
      const policy = one(s.policies, r => r.execution_id === e.id, 'captured policy');
      pipelineCheck(policy.user_id === scope.userId && policy.chain === scope.chain && policy.target_account === scope.targetAccount
        && policy.token_mint === scope.tokenMint && policy.master_wallet_address === scope.masterWalletAddress && policy.execution_mode === 'paper', 'captured policy scope');
      const capability = one(s.capabilities, r => r.execution_id === e.id, 'persisted runtime capability missing');
      pipelineCheck(capability.runtime_role === 'swat_app' && capability.revoked_at === null, 'capability absent/revoked');
      const paperReceipt = one(s.paperReceipts, r => r.executionId === e.id && r.workerFence === attempt.fence, 'independent protected paper receipt');
      pipelineCheck(paperReceipt.userId === scope.userId && paperReceipt.paperValuationEvidenceId === valuation.evidenceId
        && paperReceipt.paperValuationDigest === valuation.evidenceDigest && paperReceipt.policyRevision === attempt.policy_revision
        && paperReceipt.riskEpoch === attempt.risk_epoch, 'paper receipt provenance/fence');
      const correction = s.corrections.find(r => r.original_evidence_id === original.id);
      if (correction) {
        pipelineCheck(corrected && e.direction === 'buy' && correction.previous_correction_id === null && correction.authorized === true
          && correction.execution_id === e.id && correction.user_id === scope.userId && correction.lineage_source_trade_id === sourceBuy.id
          && correction.lineage_acquisition_evidence_id === null && correction.lineage_master_wallet_address === scope.masterWalletAddress,
        'immutable correction lineage/authorization');
        const snapshot = executedOriginalSnapshot(original);
        pipelineEqual(correction.original_snapshot, snapshot, 'correction original snapshot mutated');
        pipelineCheck(correction.original_digest === createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), 'immutable original digest');
        const trusted = one(s.trustedValuations, r => r.valuation_id === correction.valuation_id, 'independent trusted valuation');
        pipelineCheck(trusted.original_digest === correction.original_digest && trusted.original_evidence_id === original.id
          && trusted.execution_id === e.id && trusted.user_id === scope.userId && trusted.source_evidence_id === sourceBuy.headEvidenceId
          && trusted.lineage_source_trade_id === sourceBuy.id && trusted.lineage_master_wallet_address === scope.masterWalletAddress
          && trusted.revision === correction.revision && correction.quote_origin_valuation_id === trusted.valuation_id
          && correction.fee_origin_valuation_id === trusted.valuation_id, 'trusted correction original/source/field origins');
        const authority = one(s.valuationAuthorities, r => r.authority_id === trusted.authority_id, 'protected valuation authority');
        pipelineCheck(authority.enabled === true && authority.user_id === scope.userId && authority.chain === scope.chain
          && authority.network === scope.network && authority.provider_id === trusted.provider_id
          && authority.identity_digest === trusted.provider_identity_digest && authority.verifier_version === trusted.verifier_version,
        'valuation authority independent lineage');
        pipelineCheck(compare(amount(trusted,'quote_usd'),amount(authority,'max_quote_usd')) <= 0
          && compare(amount(trusted,'fee_usd'),amount(authority,'max_fee_usd')) <= 0, 'correction exceeds exact money clamp');
        pipelineEqual([effective.correctionId,effective.quote,effective.fee],
          [correction.correction_id,correction.effective_quote_usd,correction.effective_fee_usd], 'effective correction mismatch');
        pipelineEqual([correction.effective_quote_usd,correction.effective_fee_usd], [trusted.quote_usd,trusted.fee_usd], 'trusted full correction mismatch');
      } else pipelineEqual([effective.correctionId,effective.quote,effective.fee], [null,original.quote,original.fee], 'original/effective economics confused');
      const quote = money(effective.quote), fee = money(effective.fee), debit = add(quote,fee), base = exactPipelineDecimal(original.base);
      sameDecimal(e.confirmedQuote,quote,'execution effective quote');
      const app = one(s.applications, r => r.evidence_id === original.id, 'one canonical inventory application');
      pipelineCheck(app.execution_id === e.id && app.user_id === scope.userId && app.chain === scope.chain && app.token_mint === scope.tokenMint
        && app.target_account === scope.targetAccount && app.active === true, 'settled follower application erased by source reversal');
      const trade = one(s.trades, r => r.copy_execution_id === e.id, 'canonical trade');
      pipelineCheck(trade.user_id === scope.userId && trade.direction === e.direction && trade.execution_mode === 'paper'
        && trade.chain === scope.chain && trade.token_mint === scope.tokenMint && trade.source_trade_id === e.sourceTradeId
        && trade.signal_id === e.signalId && trade.status === 'filled', 'trade identity mismatch');
      sameDecimal(trade.token_amount,base,'trade inventory'); sameDecimal(trade.amount_usd,quote,'trade quote'); sameDecimal(trade.fee_usd,fee,'trade fee');
      const receipts = s.financialReceipts.filter(r => r.execution_id === e.id);
      pipelineCheck(receipts.length === (correction ? 2 : 1), 'append-only financial receipt coverage');
      for (const receipt of receipts) {
        const snapshot = receipt.snapshot as PipelineSqlRow;
        pipelineCheck(receipt.receipt_id === receiptDigest(snapshot) && snapshot.executionId === e.id && snapshot.userId === scope.userId
          && snapshot.tradeId === trade.id && snapshot.fence === attempt.fence && snapshot.accountingComplete === true,
        'financial receipt immutable hash/scope/fence');
      }
      const current = one(receipts, r => pipelineCanonical((r.snapshot as PipelineSqlRow).totals) === pipelineCanonical({ base: pipelineExactText(base),
        quote: pipelineExactText(quote), debit: pipelineExactText(debit), fee: pipelineExactText(fee), unknown:'0',quoteUnknown:'0',completes:true,evidenceCount:'1' }),
      'exact current independent financial totals');
      pipelineCheck(current.accounting_complete === true,'financial accounting incomplete');
      const capacity = one(s.capacity, r => r.source_trade_id === source.id && r.execution_mode === 'paper', 'master capacity cohort');
      sameDecimal(capacity.notional_usd,quote,'capacity must exclude fee but include effective quote');
      pipelineCheck(capacity.chain === scope.chain && capacity.token_mint === scope.tokenMint
        && capacity.master_wallet_address === scope.masterWalletAddress && capacity.unassessed_fill_count === '0', 'capacity scope/coverage');
      if (e.direction === 'buy') {
        const risk = one(s.risk, r => r.execution_id === e.id, 'buy retained risk');
        pipelineCheck(risk.account === scope.userId && risk.chain === scope.chain && risk.execution_mode === 'paper'
          && risk.policy_epoch === attempt.risk_epoch && risk.state === 'confirmed', 'risk authority scope/epoch');
        sameDecimal(risk.confirmed_usd,debit,'risk effective quote plus fee'); sameDecimal(risk.liability_usd,debit,'confirmed retained liability');
        quantity = add(quantity,base); basis = add(basis,debit);
      } else {
        pipelineCheck(attempt.risk_epoch === null && compare(quantity,base) >= 0, 'sell invented risk/inventory');
        basis = divide(multiply(basis,subtract(quantity,base)),quantity,18); quantity = subtract(quantity,base);
      }
    }
    pipelineCheck(s.risk.length === 1 && s.corrections.length === (corrected ? 1 : 0) && s.positions.length === 1 && s.lots.length === 1,
      'unexpected risk/correction/position/lot rows');
    const position = s.positions[0]!, lot = s.lots[0]!;
    pipelineCheck(position.user_id === scope.userId && position.chain === scope.chain && position.token_mint === scope.tokenMint
      && position.target_account === scope.targetAccount && lot.position_id === position.id && lot.user_id === scope.userId
      && lot.master_wallet_address === scope.masterWalletAddress && lot.acquisition_execution_id === ordered[0]!.id
      && lot.acquisition_evidence_id === one(s.originals,r=>r.executionId===ordered[0]!.id,'buy original').id
      && lot.source_trade_id === sourceBuy.id, 'owned acquisition lot lineage');
    sameDecimal(position.opening_quantity,ZERO,'unqualified opening inventory'); sameDecimal(position.opening_cost_basis_usd,ZERO,'unqualified opening basis');
    sameDecimal(position.confirmed_quantity,quantity,'independent position quantity fold'); sameDecimal(position.cost_basis_usd,basis,'independent sell/correction basis fold');
    sameDecimal(lot.remaining_quantity,quantity,'lot remaining quantity'); sameDecimal(lot.remaining_cost_basis_usd,basis,'lot corrected remaining basis');
    const buyEffective = one(s.effective,r=>r.executionId===ordered[0]!.id,'buy economics');
    sameDecimal(lot.acquired_quantity,exactPipelineDecimal(buyEffective.base),'lot original acquired quantity');
    sameDecimal(lot.acquired_cost_basis_usd,add(money(buyEffective.quote),money(buyEffective.fee)),'lot corrected acquisition debit');
    pipelineCheck(s.allocations.length === (initial ? 0 : 1) && s.reductions.length === (initial ? 0 : 1),'sell allocation/reduction coverage');
    if (!initial) {
      const sell = ordered[1]!, fill = one(s.originals,r=>r.executionId===sell.id,'sell fill'), allocation=s.allocations[0]!, reduction=s.reductions[0]!;
      pipelineCheck(allocation.execution_id===sell.id && allocation.lot_id===lot.id && allocation.user_id===scope.userId
        && allocation.acquisition_execution_id===ordered[0]!.id && allocation.acquisition_evidence_id===lot.acquisition_evidence_id
        && allocation.acquisition_source_trade_id===sourceBuy.id && allocation.master_wallet_address===scope.masterWalletAddress
        && allocation.chain===scope.chain && allocation.target_account===scope.targetAccount && allocation.token_mint===scope.tokenMint
        && allocation.execution_mode==='paper' && reduction.sell_execution_id===sell.id && reduction.sell_evidence_id===fill.id
        && reduction.lot_id===lot.id && reduction.user_id===scope.userId,'sell exact lot lineage');
      sameDecimal(allocation.requested_quantity,exactPipelineDecimal(sell.requestedBase!),'exact immutable allocation');
      sameDecimal(reduction.quantity,exactPipelineDecimal(fill.base),'exact consumed lot base');
    }
    if (previous) {
      pipelineEqual(s.originals.filter(r=>previous!.originals.some(p=>p.id===r.id)),previous.originals,'immutable original history changed');
      for(const receipt of previous.financialReceipts) one(s.financialReceipts,r=>pipelineCanonical(r)===pipelineCanonical(receipt),'financial history changed');
      if(reversed) for(const key of ['applications','attempts','allocations','reductions','deliveries','capabilities','paperValuations','paperReceipts','policies'] as const)
        pipelineEqual(s[key],previous[key],`${key} changed after settled source reversal`);
      if(s.stage==='reversal') for(const key of ['effective','trades','financialReceipts','positions','lots','risk','capacity','corrections'] as const)
        pipelineEqual(s[key],previous[key],`${key} incorrectly reversed follower economics`);
      if(s.stage==='replay') pipelineEqual({...s,stage:previous.stage},previous,'replay changed durable economic/history rows');
    }
    previous=s;
  }
  return { runtimeAccepted:false as const,sourceComplete:false as const,liveCapabilityAccepted:false as const,
    exactJournalDigest:createHash('sha256').update(pipelineCanonical(journal)).digest('hex'),stages:journal.snapshots.map(s=>s.stage),
    finalPosition:journal.snapshots[4]!.positions[0] };
}
