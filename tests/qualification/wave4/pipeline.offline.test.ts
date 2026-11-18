import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { exercisePaperPipeline, pipelinePreflightContract, pipelineSourceBlockers, requireExactPipelineJournal,
  type PipelineJournal, type PipelineSnapshot, type PipelineSourceJournal, type PipelineOriginalFill,
  type PipelineExecution, type PipelineFinancialReceipt, type PipelinePreflightSnapshot } from './pipeline.js';
import { sourceContentDigest, sourceBindingDigest, sourceEvidenceDigest,
  type SourceVerificationEvidence } from '../../../packages/db/src/source-verification.js';
import { workerOriginalEvidenceDigest } from '../../../packages/db/src/worker-valuation-corrections.js';

const runId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const scope = { runId, userId, network: `solana:wave4-${runId}`, chain: 'solana' as const,
  targetAccount: 'solana:wave4-owned-follower', masterWalletAddress: 'solana:wave4-master', tokenMint: 'solana:wave4-token' };
const at = '2026-11-18T12:00:00.000Z';
const acquired = '9007199254740993.125', sold = '1801439850948198.625', remaining = '7205759403792794.5';
function source(side: 'buy' | 'sell'): PipelineSourceJournal {
  const binding = { chain: scope.chain, network: scope.network, sourceEventType: 'transaction' as const,
    sourceEventId: `source-${side}`, sourceEventIndex: '0', transactionHash: `hash-${side}`,
    walletAddress: scope.masterWalletAddress, tokenMint: scope.tokenMint, side, rawQuantity: side === 'buy' ? '10000' : '2000',
    quantityScale: 3, eventAt: at, amountUsd: side === 'buy' ? '100' : '30', priceUsd: null, feeUsd: '0' };
  const content = `inert-${side}-receipt`;
  const first: SourceVerificationEvidence = { evidenceId: `source-evidence-${side}`, binding, finality: 'confirmed',
    blockHash: `block-${side}`, blockHeight: '1', revision: '1', reversesEvidenceId: null, observedAt: at,
    provenance: { providerId: `wave4-${runId}`, authorityId: 'inert-authority-not-a-grant', verifierVersion: 'inert-v1', receiptId: `receipt-${side}` },
    content, contentDigest: sourceContentDigest(content) };
  const reversed: SourceVerificationEvidence = { ...first, evidenceId: 'source-evidence-sell-reversed', finality: 'reversed',
    revision: '2', reversesEvidenceId: first.evidenceId, content: 'inert-reversal', contentDigest: sourceContentDigest('inert-reversal') };
  const evidence = side === 'buy' ? [first] : [first, reversed];
  return { sourceTradeId: `source-${side}`, binding, bindingDigest: sourceBindingDigest(binding), evidence, evidenceDigests: evidence.map(sourceEvidenceDigest) };
}
function fill(side: 'buy' | 'sell'): PipelineOriginalFill {
  return { id: `original-${side}`, executionId: `execution-${side}`, userId, sourceTradeId: `source-${side}`,
    evidenceType: 'paper_simulation', evidenceId: `paper-receipt-${side}`, baseQuantity: side === 'buy' ? acquired : sold,
    quoteQuantity: side === 'buy' ? '10' : '3', quoteNativeQuantity: null, quoteCurrency: 'USD', quoteNativeUsdPrice: null,
    priceUsd: null, feeUsd: side === 'buy' ? '0.01' : '0.005', occurredAt: at, completesExecution: true };
}
function execution(side: 'buy' | 'sell', corrected: boolean): PipelineExecution {
  return { id: `execution-${side}`, signalId: `signal-${side}`, sourceTradeId: `source-${side}`, userId,
    chain: scope.chain, tokenMint: scope.tokenMint, targetAccount: scope.targetAccount, masterWalletAddress: scope.masterWalletAddress,
    executionMode: 'paper', direction: side, state: 'confirmed', requestedBaseQuantity: side === 'buy' ? acquired : sold,
    requestedQuoteQuantity: null, confirmedBaseQuantity: side === 'buy' ? acquired : sold,
    confirmedQuoteQuantity: side === 'buy' ? corrected ? '20' : '10' : '3' };
}
function receipt(side: 'buy' | 'sell', corrected = false): PipelineFinancialReceipt {
  const snapshot: PipelineFinancialReceipt['snapshot'] = { executionId: `execution-${side}`, userId, tradeId: `trade-${side}`, fence: '7',
    totals: { base: side === 'buy' ? acquired : sold, quote: side === 'buy' ? corrected ? '20' : '10' : '3',
      debit: side === 'buy' ? corrected ? '20.02' : '10.01' : '3.005', fee: side === 'buy' ? corrected ? '0.02' : '0.01' : '0.005',
      unknown: '0', quoteUnknown: '0', completes: true, evidenceCount: '1' }, accountingComplete: true };
  return { receiptId: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), snapshot };
}
/** Literal expected economics are independent of the qualifier's arithmetic.
 * No provider, verifier, capability, SQL client, queue or effect is simulated. */
function journal(): PipelineJournal {
  const buySource = source('buy'), sellSource = source('sell'), originalBuy = fill('buy');
  const snapshots = (['buy', 'sell', 'reversal', 'correction', 'replay'] as const).map((stage): PipelineSnapshot => {
    const initial = stage === 'buy', corrected = stage === 'correction' || stage === 'replay';
    const reversed = stage === 'reversal' || corrected;
    const executions = initial ? [execution('buy', false)] : [execution('buy', corrected), execution('sell', false)];
    return { stage, sourceHeads: [
      { sourceTradeId: 'source-buy', evidenceId: 'source-evidence-buy', confirmationState: 'confirmed', applicationActive: true },
      ...initial ? [] : [{ sourceTradeId: 'source-sell', evidenceId: reversed ? 'source-evidence-sell-reversed' : 'source-evidence-sell',
        confirmationState: reversed ? 'reversed' as const : 'confirmed' as const, applicationActive: !reversed }]
    ], sourcePosition: { quantity: initial || reversed ? '10' : '8', costBasisUsd: initial || reversed ? '100' : '80', unmatchedReductionQuantity: '0' },
    executions, originalEvidence: initial ? [fill('buy')] : [fill('buy'), fill('sell')],
    effectiveEvidence: executions.map(e => ({ originalEvidenceId: `original-${e.direction}`, executionId: e.id,
      baseQuantity: e.confirmedBaseQuantity, quoteUsd: e.confirmedQuoteQuantity, feeUsd: e.direction === 'buy' ? corrected ? '0.02' : '0.01' : '0.005',
      correctionId: corrected && e.direction === 'buy' ? 'correction-buy' : null, confirmationState: 'confirmed' })),
    applications: executions.map(e => ({ evidenceId: `original-${e.direction}`, executionId: e.id, positionId: 'position-owned', userId,
      targetAccount: scope.targetAccount, chain: scope.chain, tokenMint: scope.tokenMint, active: true })),
    deliveries: executions.map(e => ({ executionId: e.id, signalId: e.signalId, sourceTradeId: e.sourceTradeId, userId,
      targetAccount: scope.targetAccount, executionMode: 'paper', jobId: `source-trade-${e.signalId}-u-${userId}`, state: 'completed', fence: '7',
      descriptor: { copyExecutionId: e.id, signalId: e.signalId, sourceTradeId: e.sourceTradeId, userId, chain: scope.chain,
        tokenMint: scope.tokenMint, targetAccount: scope.targetAccount, masterWalletAddress: scope.masterWalletAddress, executionMode: 'paper',
        direction: e.direction, requestedBaseQuantity: e.requestedBaseQuantity, requestedQuoteQuantity: e.requestedQuoteQuantity, exitLotId: null, score: 90 } })),
    attempts: executions.map(e => ({ executionId: e.id, userId, fence: '7', policyRevision: 'captured-policy-v1', riskEpoch: e.direction === 'buy' ? '4' : null, state: 'settled' })),
    trades: executions.map(e => ({ id: `trade-${e.direction}`, executionId: e.id, userId, direction: e.direction, executionMode: 'paper',
      tokenAmount: e.confirmedBaseQuantity, amountUsd: e.confirmedQuoteQuantity, feeUsd: e.direction === 'buy' ? corrected ? '0.02' : '0.01' : '0.005', status: 'filled' })),
    financialReceipts: [receipt('buy'), ...initial ? [] : [receipt('sell')], ...corrected ? [receipt('buy', true)] : []],
    risk: [{ executionId: 'execution-buy', userId, policyEpoch: '4', state: 'confirmed', confirmedUsd: corrected ? '20.02' : '10.01' }],
    capacity: executions.map(e => ({ sourceTradeId: e.sourceTradeId, executionMode: 'paper', notionalUsd: e.confirmedQuoteQuantity })),
    position: { id: 'position-owned', userId, targetAccount: scope.targetAccount, chain: scope.chain, tokenMint: scope.tokenMint,
      quantity: initial ? acquired : remaining, costBasisUsd: initial ? '10.01' : corrected ? '16.016' : '8.008' },
    lots: [{ id: 'lot-owned', positionId: 'position-owned', userId, masterWalletAddress: scope.masterWalletAddress,
      acquisitionExecutionId: 'execution-buy', acquisitionEvidenceId: 'original-buy', acquisitionSourceTradeId: 'source-buy', acquisitionMode: 'paper',
      acquiredQuantity: acquired, remainingQuantity: initial ? acquired : remaining, acquiredCostBasisUsd: corrected ? '20.02' : '10.01',
      remainingCostBasisUsd: initial ? '10.01' : corrected ? '16.016' : '8.008' }],
    allocations: initial ? [] : [{ executionId: 'execution-sell', lotId: 'lot-owned', userId, masterWalletAddress: scope.masterWalletAddress,
      acquisitionExecutionId: 'execution-buy', acquisitionEvidenceId: 'original-buy', acquisitionSourceTradeId: 'source-buy', requestedQuantity: sold }],
    reductions: initial ? [] : [{ executionId: 'execution-sell', evidenceId: 'original-sell', lotId: 'lot-owned', userId, quantity: sold }],
    corrections: corrected ? [{ correctionId: 'correction-buy', valuationId: 'valuation-buy', originalEvidenceId: 'original-buy',
      executionId: 'execution-buy', userId, revision: '1', previousCorrectionId: null, originalDigest: workerOriginalEvidenceDigest({ ...originalBuy }),
      originalSnapshot: originalBuy, lineageSourceTradeId: 'source-buy', lineageAcquisitionEvidenceId: null,
      lineageMasterWalletAddress: scope.masterWalletAddress, sourceEvidenceId: 'source-evidence-buy',
      effectiveQuoteUsd: '20', effectiveFeeUsd: '0.02', quoteOriginValuationId: 'valuation-buy', feeOriginValuationId: 'valuation-buy', authorized: true }] : [] };
  });
  return { scope, sources: [buySource, sellSource], snapshots, operatorExclusion: { userId: null, code: 'operator-obligation-domain-unsupported' } };
}
const denied: PipelinePreflightSnapshot = { authenticated_role: 'swat_app', runtime_role: 'swat_app', bypass: 'off', tenant: '', worker_execution: '',
  lookup: false, provider_write: false, capability_write: false, valuation_authority_write: false, valuation_write: false };

describe('Wave4 I3 source-only negative capability and exact inert durable reconciliation', () => {
  it('imports only pool-free runtime leaves, with production execution contracts erased', () => {
    const text = readFileSync(new URL('./pipeline.ts', import.meta.url), 'utf8');
    expect(text).not.toMatch(/\bimport\s*\(/);
    expect(text).not.toContain('exerciseDraftPaperPipeline');
    const runtimeImports = [...text.matchAll(/^import (?!type\b)[\s\S]*?from ['"]([^'"]+)['"];$/gm)].map(m => m[1]);
    expect(runtimeImports).toEqual(['node:crypto', '../../../packages/db/src/source-verification.js', '../../../packages/db/src/worker-valuation-corrections.js']);
    expect(text).not.toMatch(/as (?:PoolClient|CanonicalWorkerPorts|TrustedSourceVerifier)/);
  });
  it('unconditionally refuses even a hostile input without consulting any property', async () => {
    const input = new Proxy({}, { get() { throw new Error('input was consulted'); } });
    await expect(exercisePaperPipeline(input)).rejects.toThrow('Joined pipeline execution unavailable');
  });
  it.each([null, 'protected-capability-label', { userId }, { executionMode: 'live', verifier: 'approved' }])('cannot turn %j into protected composition', async input => {
    await expect(exercisePaperPipeline(input)).rejects.toThrow('unavailable');
  });
  it.each([false, true])('observes lookup=%s without qualifying composition or live authority', lookup => {
    const result = pipelinePreflightContract({ ...denied, lookup });
    expect(result.assertions.every(a => a.passed)).toBe(true);
    expect(result.blocked).toEqual(pipelineSourceBlockers);
    expect(result.evidence).toMatchObject({ runtimeLookupExecutable: lookup, runtimeAccepted: false, liveCapabilityAccepted: false, protectedCompositionAvailable: false });
  });
  it.each(['provider_write', 'capability_write', 'valuation_authority_write', 'valuation_write'] as const)('refuses runtime %s authority', field => {
    const result = pipelinePreflightContract({ ...denied, [field]: true });
    expect(result.assertions.some(a => !a.passed)).toBe(true);
    expect(result.blocked.length).toBeGreaterThan(0);
  });
  it.each([{ authenticated_role: 'swat_migrator' }, { runtime_role: 'swat_worker' }, { bypass: 'on' }, { tenant: userId }, { worker_execution: 'execution-buy' }])('refuses substituted preflight scope %j', change => {
    expect(pipelinePreflightContract({ ...denied, ...change }).assertions.some(a => !a.passed)).toBe(true);
  });
  it('refuses missing observation and checks all mutation privileges without invoking lookup', () => {
    expect(pipelinePreflightContract(null).assertions.every(a => !a.passed)).toBe(true);
    const text = readFileSync(new URL('./pipeline.ts', import.meta.url), 'utf8');
    expect(text.match(/'INSERT,UPDATE,DELETE'/g)).toHaveLength(4);
    expect(text).not.toMatch(/SELECT \* FROM public\.swat_claim_runtime_capability/);
  });
  it('reconciles literal huge exact buy/sell quantities, reversal and immutable correction, not counts', () => {
    const input = journal(), before = JSON.stringify(input);
    const result = requireExactPipelineJournal(input, structuredClone(input));
    expect(result).toMatchObject({ sourceOnly: true, runtimeAccepted: false, liveCapabilityAccepted: false,
      stages: ['buy', 'sell', 'reversal', 'correction', 'replay'], finalSourcePosition: { quantity: '10', costBasisUsd: '100' },
      finalFollowerPosition: { quantity: remaining, costBasisUsd: '16.016' } });
    expect(JSON.stringify(input)).toBe(before);
    expect(result.exactJournalDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  const corruptions: readonly [string, (input: PipelineJournal) => void][] = [
    ['original fill economics', j => { Object.assign(j.snapshots[3]!.originalEvidence[0]!, { quoteQuantity: '20' }); }],
    ['effective valuation', j => { Object.assign(j.snapshots[3]!.effectiveEvidence[0]!, { quoteUsd: '21' }); }],
    ['application identity', j => { Object.assign(j.snapshots[1]!.applications[1]!, { evidenceId: 'foreign' }); }],
    ['completed delivery tenant', j => { Object.assign(j.snapshots[1]!.deliveries[0]!, { userId: runId }); }],
    ['queue descriptor scope', j => { Object.assign(j.snapshots[1]!.deliveries[0]!.descriptor, { targetAccount: 'solana:foreign' }); }],
    ['worker fence', j => { Object.assign(j.snapshots[1]!.attempts[0]!, { fence: '8' }); }],
    ['receipt hash', j => { Object.assign(j.snapshots[1]!.financialReceipts[0]!, { receiptId: '0'.repeat(64) }); }],
    ['receipt economics', j => { Object.assign(j.snapshots[3]!.financialReceipts[2]!.snapshot.totals, { debit: '20' }); }],
    ['trade value', j => { Object.assign(j.snapshots[1]!.trades[0]!, { amountUsd: '0' }); }],
    ['risk liability', j => { Object.assign(j.snapshots[3]!.risk[0]!, { confirmedUsd: '20' }); }],
    ['capacity cohort', j => { Object.assign(j.snapshots[1]!.capacity[0]!, { sourceTradeId: 'foreign' }); }],
    ['position basis', j => { Object.assign(j.snapshots[3]!.position, { costBasisUsd: '16' }); }],
    ['acquisition lot', j => { Object.assign(j.snapshots[1]!.lots[0]!, { acquisitionEvidenceId: 'foreign' }); }],
    ['sell allocation master', j => { Object.assign(j.snapshots[1]!.allocations[0]!, { masterWalletAddress: 'solana:foreign' }); }],
    ['sell reduction', j => { Object.assign(j.snapshots[1]!.reductions[0]!, { quantity: '1' }); }],
    ['source reversal reference', j => { Object.assign(j.sources[1]!.evidence[1]!, { reversesEvidenceId: 'foreign' }); }],
    ['source projection', j => { Object.assign(j.snapshots[2]!.sourcePosition, { quantity: '8' }); }],
    ['correction original digest', j => { Object.assign(j.snapshots[3]!.corrections[0]!, { originalDigest: '0'.repeat(64) }); }],
    ['correction source lineage', j => { Object.assign(j.snapshots[3]!.corrections[0]!, { lineageSourceTradeId: 'source-sell' }); }],
    ['correction carried valuation', j => { Object.assign(j.snapshots[3]!.corrections[0]!, { feeOriginValuationId: 'foreign' }); }],
    ['correction revoked', j => { Object.assign(j.snapshots[3]!.corrections[0]!, { authorized: false }); }],
    ['replay rewritten risk', j => { Object.assign(j.snapshots[4]!.risk[0]!, { confirmedUsd: '99' }); }]
  ];
  it.each(corruptions)('rejects %s despite unchanged row counts', (_, corrupt) => {
    const expected = journal(), actual = structuredClone(expected);
    corrupt(actual);
    expect(() => requireExactPipelineJournal(actual, expected)).toThrow('Pipeline journal:');
  });
  it.each(['executions', 'originalEvidence', 'applications', 'financialReceipts', 'lots', 'reductions'] as const)('refuses extra %s durable row', field => {
    const expected = journal(), actual = structuredClone(expected);
    const rows = actual.snapshots[3]![field];
    Object.assign(rows, { [rows.length]: structuredClone(rows[0]) });
    expect(() => requireExactPipelineJournal(actual, expected)).toThrow();
  });
  it.each(corruptions.filter(([name]) => ['position basis', 'sell reduction', 'correction revoked', 'worker fence', 'source projection', 'replay rewritten risk'].includes(name)))('also cross-checks %s when a mistaken expected journal agrees', (_, corrupt) => {
    const actual = journal(); corrupt(actual);
    expect(() => requireExactPipelineJournal(actual, structuredClone(actual))).toThrow();
  });
  it('does not erase the settled follower sell when source evidence reverses', () => {
    const input = journal(), sell = input.snapshots[1]!, reversed = input.snapshots[2]!;
    expect(reversed.sourceHeads[1]!.applicationActive).toBe(false);
    expect(reversed.position).toEqual(sell.position);
    expect(reversed.reductions).toEqual(sell.reductions);
    Object.assign(reversed.applications[1]!, { active: false });
    expect(() => requireExactPipelineJournal(input, structuredClone(input))).toThrow();
  });
  it('refuses float/scientific quantities instead of losing precision', () => {
    const input = journal(); Object.assign(input.snapshots[0]!.originalEvidence[0]!, { baseQuantity: '9.007199254740993e15' });
    expect(() => requireExactPipelineJournal(input, structuredClone(input))).toThrow();
  });
  it('refuses reordered stages and never turns a snapshot into positive runtime evidence', () => {
    const input = journal(); Object.assign(input.snapshots, { 0: input.snapshots[1], 1: input.snapshots[0] });
    expect(() => requireExactPipelineJournal(input, structuredClone(input))).toThrow();
  });
});
