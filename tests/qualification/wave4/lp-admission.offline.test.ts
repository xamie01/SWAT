import { describe, expect, it } from 'vitest';
import { lpExactHash, lpSnapshot, type LpPaperQuote, type LpPaperReceipt, type LpExactPosition, type LpExactOperation } from '../../../packages/db/src/lp-exact.js';
import { lpOperationIntent, type LpQuoteInput } from '../../../packages/db/src/lp-paper-service.js';
import { requireLpQuoteAdmission, requireLpSettlementAdmission, type LpProtectedQuoteAdmission, type LpProtectedSettlementAdmission } from '../../../packages/db/src/lp-paper-admission-contract.js';

const userId = '11111111-1111-4111-8111-111111111111';
const positionId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const quoteId = '44444444-4444-4444-8444-444444444444';
const settlementId = '55555555-5555-4555-8555-555555555555';
const t = (seconds: number) => `2026-11-18T00:00:${seconds.toString().padStart(2, '0')}.000Z`;
function fixture(action: 'close' | 'rebalance' = 'close') {
  const amount = { raw: '900719925474099312345', scale: 18 };
  const position = { id: positionId, userId, chain: 'solana', protocol: 'meteora-dlmm', poolAddress: 'solana:pool', depositAsset: 'solana:asset', revision: '0', currentAmount: amount, mode: 'paper', state: 'active' } as LpExactPosition;
  const input: LpQuoteInput = { userId, chain: position.chain, poolAddress: position.poolAddress, depositAsset: position.depositAsset, deposit: amount, action, intentHash: lpOperationIntent(position, action), positionId, positionRevision: '0' };
  const quote: LpPaperQuote = {
    version: 1, providerId: 'synthetic-provider', quoteId: 'synthetic-quote', userId, intentHash: input.intentHash, action, mode: 'paper',
    pool: { chain: 'solana', networkId: 'synthetic-solana', protocol: 'meteora-dlmm', poolAddress: 'solana:pool', depositAsset: 'solana:asset', depositScale: 18, evidenceId: 'synthetic-pool', observedAt: t(0), currentPrice: 1, binStep: 1, tickSpacing: null },
    deposit: amount, unitPriceUsd: { raw: '1000000', scale: 6 }, valueMicroUsd: '900719925', amountAfter: action === 'close' ? { raw: '0', scale: 18 } : amount, proceedsMicroUsd: action === 'close' ? '900719925' : '0', observedAt: t(0), expiresAt: t(30),
    economics: action === 'close' ? null : { basis: 'incremental-rebalance', windowStart: t(0), windowEnd: t(30), extraFeesMicroUsd: '100000', inventoryChangeMicroUsd: '0', impermanentLossMicroUsd: '0', gasMicroUsd: '10000', repositionMicroUsd: '10000' }
  };
  const operation: LpExactOperation = { id: operationId, userId, positionId, operationKey: 'close', fingerprint: input.intentHash, action, positionRevision: '0', amountBefore: amount, quote, plan: null, receiptKey: 'synthetic-receipt-key', status: 'pending', receipt: null };
  const receipt: LpPaperReceipt = { version: 1, providerId: quote.providerId, receiptId: 'synthetic-receipt', receiptKey: operation.receiptKey, userId, positionId, positionRevision: '0', mode: 'paper', action, networkId: quote.pool.networkId, chain: 'solana', protocol: 'meteora-dlmm', poolAddress: position.poolAddress, depositAsset: position.depositAsset, quoteId: quote.quoteId, quoteHash: lpExactHash(quote), amountBefore: amount, amountAfter: quote.amountAfter, proceedsMicroUsd: quote.proceedsMicroUsd, collectedFeesMicroUsd: '100000', executionCostsMicroUsd: '50000', settledAt: t(10), finality: 'paper-settled' };
  const admittedQuote: LpProtectedQuoteAdmission = { id: quoteId, userId, input: lpSnapshot(input), quote: lpSnapshot(quote), admittedAt: t(1) };
  const admittedSettlement: LpProtectedSettlementAdmission = { id: settlementId, quoteAdmissionId: quoteId, operationId, userId, positionId, positionRevision: '0', receipt: lpSnapshot(receipt), admittedAt: t(11) };
  return { position, input, quote, operation, receipt, admittedQuote, admittedSettlement, now: new Date(t(12)) };
}

describe('LP independently stored admission comparisons; no writer/store/SQL authority supplied', () => {
  it('compares complete preexisting quote and actual settlement terms without returning fixture aliases', () => {
    const f = fixture();
    expect(requireLpQuoteAdmission(f.admittedQuote, f.input, f.quote, f.now)).toEqual(f.admittedQuote);
    const result = requireLpSettlementAdmission(f.admittedSettlement, f.admittedQuote, f.operation, f.position, f.receipt, f.now);
    expect(result).toEqual(f.admittedSettlement); expect(result.receipt).not.toBe(f.admittedSettlement.receipt);
  });
  it('does not treat a matching candidate hash as independent quote admission', () => {
    const f = fixture(); expect(lpExactHash(f.quote)).toBe(lpExactHash(f.quote));
    expect(() => requireLpQuoteAdmission(null, f.input, f.quote, f.now)).toThrow('stored quote unavailable');
  });
  it('requires independently stored actual settlement terms', () => {
    const f = fixture(); expect(() => requireLpSettlementAdmission(null, f.admittedQuote, f.operation, f.position, f.receipt, f.now)).toThrow('stored settlement unavailable');
  });
  it.each(['provider', 'network', 'action', 'price', 'economics'] as const)('refuses %s quote substitution against a separate admission', field => {
    const f = fixture(), candidate = lpSnapshot(f.quote) as any;
    if (field === 'provider') candidate.providerId = 'forged';
    if (field === 'network') candidate.pool.networkId = 'forged';
    if (field === 'action') candidate.action = 'rebalance';
    if (field === 'price') candidate.unitPriceUsd.raw = '2000000';
    if (field === 'economics') candidate.economics = { forged: true };
    expect(() => requireLpQuoteAdmission(f.admittedQuote, f.input, candidate, f.now)).toThrow('complete quote');
  });
  it.each(['tenant', 'revision', 'inventory'] as const)('refuses %s input substitution even with the same quote', field => {
    const f = fixture(), input = lpSnapshot(f.input) as any;
    if (field === 'tenant') input.userId = settlementId;
    if (field === 'revision') input.positionRevision = '1';
    if (field === 'inventory') input.deposit.raw = '1';
    expect(() => requireLpQuoteAdmission(f.admittedQuote, input, f.quote, f.now)).toThrow('complete quote');
  });
  it.each([t(30), t(40)])('refuses a quote first admitted after expiry (%s)', admittedAt => {
    const f = fixture(), admission = { ...f.admittedQuote, admittedAt };
    expect(() => requireLpQuoteAdmission(admission, f.input, f.quote, new Date(t(50)), true)).toThrow('admitted while fresh');
  });
  it('allows historical recovery only for a quote previously admitted while fresh', () => {
    const f = fixture(); expect(() => requireLpQuoteAdmission(f.admittedQuote, f.input, f.quote, new Date(t(40)))).toThrow('expired');
    expect(requireLpSettlementAdmission(f.admittedSettlement, f.admittedQuote, f.operation, f.position, f.receipt, new Date(t(40)))).toEqual(f.admittedSettlement);
  });
  it('recomputes rebalance positivity from the separately admitted projection', () => {
    const f = fixture('rebalance'); expect(requireLpQuoteAdmission(f.admittedQuote, f.input, f.quote, f.now)).toEqual(f.admittedQuote);
    const quote = { ...f.quote, economics: { ...f.quote.economics!, extraFeesMicroUsd: '0' } };
    expect(() => requireLpQuoteAdmission({ ...f.admittedQuote, quote }, f.input, quote, f.now)).toThrow('not positive');
  });
  it.each(['fees', 'costs', 'proceeds', 'network'] as const)('refuses forged %s actual terms despite a recomputed candidate hash', field => {
    const f = fixture(), receipt = lpSnapshot(f.receipt) as any;
    if (field === 'fees') receipt.collectedFeesMicroUsd = '999999999';
    if (field === 'costs') receipt.executionCostsMicroUsd = '0';
    if (field === 'proceeds') receipt.proceedsMicroUsd = '999999999';
    if (field === 'network') receipt.networkId = 'forged';
    expect(lpExactHash(receipt)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => requireLpSettlementAdmission(f.admittedSettlement, f.admittedQuote, f.operation, f.position, receipt, f.now)).toThrow('complete settlement');
  });
  it.each(['operation', 'quote', 'revision'] as const)('refuses substituted %s settlement binding', field => {
    const f = fixture(), admission = { ...f.admittedSettlement } as any;
    if (field === 'operation') admission.operationId = settlementId;
    if (field === 'quote') admission.quoteAdmissionId = settlementId;
    if (field === 'revision') admission.positionRevision = '1';
    expect(() => requireLpSettlementAdmission(admission, f.admittedQuote, f.operation, f.position, f.receipt, f.now)).toThrow(/binding|admission mismatch/);
  });
  it('refuses an operation fingerprint not derived from its current position', () => {
    const f = fixture(); expect(() => requireLpSettlementAdmission(f.admittedSettlement, f.admittedQuote, { ...f.operation, fingerprint: '0'.repeat(64) }, f.position, f.receipt, f.now)).toThrow('binding');
  });
  it('refuses settlement that predates independent quote admission', () => {
    const f = fixture(); expect(() => requireLpSettlementAdmission(f.admittedSettlement, { ...f.admittedQuote, admittedAt: t(11) }, f.operation, f.position, f.receipt, f.now)).toThrow('time mismatch');
  });
  it('refuses a future settlement admission', () => {
    const f = fixture(); expect(() => requireLpSettlementAdmission({ ...f.admittedSettlement, admittedAt: t(20) }, f.admittedQuote, f.operation, f.position, f.receipt, f.now)).toThrow('time mismatch');
  });
  it('refuses closed or changed position snapshots', () => {
    const f = fixture(); expect(() => requireLpSettlementAdmission(f.admittedSettlement, f.admittedQuote, f.operation, { ...f.position, state: 'closed' }, f.receipt, f.now)).toThrow('binding');
  });
});
