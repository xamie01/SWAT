import { exactDecimal, addExactDecimal, compareExactDecimal, divideDecimalText, multiplyDecimalText } from '@swat/db';
import type { CopyExecutionRecord } from '@swat/db';
import type { CanonicalWorkerQuote } from './worker-policy.js';

export interface PaperValuation {
  readonly priceUsd: string;
  readonly observedAt: Date;
  readonly evidenceId: string;
}
export interface ProvenancePaperValuation extends PaperValuation {
  readonly providerId: string;
  readonly providerIdentity: string;
  readonly chain: CopyExecutionRecord['chain'];
  readonly network: string;
  readonly tokenMint: string;
  readonly baseDecimals: number;
  readonly quoteCurrency: 'USD';
  readonly expiresAt: Date;
  readonly simulationModelId: string;
  readonly simulatedFeeBps: string;
  readonly simulatedFixedFeeUsd: string;
}
export interface ReviewedPaperValuationProvider {
  readonly providerId: string;
  readonly providerIdentity: string;
  readonly networkForChain: (chain: CopyExecutionRecord['chain']) => string | null;
  readonly readValuation: (execution: CopyExecutionRecord) => Promise<ProvenancePaperValuation | null>;
}
function sameExecution(a: CopyExecutionRecord, b: CopyExecutionRecord): boolean {
  return a.id === b.id && a.userId === b.userId && a.clientOrderId === b.clientOrderId && a.chain === b.chain
    && a.tokenMint === b.tokenMint && a.targetAccount === b.targetAccount && a.executionMode === b.executionMode
    && a.direction === b.direction && a.sourceTradeId === b.sourceTradeId && a.exitLotId === b.exitLotId
    && a.requestedBaseQuantity === b.requestedBaseQuantity && a.requestedQuoteQuantity === b.requestedQuoteQuantity;
}
/** Exact paper economics are explicitly simulated, not venue receipt authority.
 * The reviewed provider carries asset/network/scale/time provenance. Buy quote
 * quantity is USD notional (fee added to risk debit); sell base must be exact at
 * the trusted asset scale. No cached numeric price, guessed fee or fill fallback. */
export function createExactPaperQuote(input: {
  readonly provider: ReviewedPaperValuationProvider | null;
  readonly now: () => Date;
  readonly maximumAgeMs: number;
}) {
  return async (execution: CopyExecutionRecord): Promise<CanonicalWorkerQuote | null> => {
    const provider = input.provider;
    if (!provider || execution.executionMode !== 'paper' || !['buy','sell'].includes(execution.direction)
      || !Number.isSafeInteger(input.maximumAgeMs) || input.maximumAgeMs < 1 || input.maximumAgeMs > 60_000) return null;
    const valuation = await provider.readValuation(execution), now = input.now();
    if (!valuation || !Number.isFinite(now.getTime()) || valuation.providerId !== provider.providerId
      || valuation.providerIdentity !== provider.providerIdentity || !valuation.evidenceId || !valuation.simulationModelId
      || valuation.chain !== execution.chain || valuation.tokenMint !== execution.tokenMint || valuation.quoteCurrency !== 'USD'
      || !valuation.network || valuation.network !== provider.networkForChain(execution.chain)
      || !Number.isSafeInteger(valuation.baseDecimals) || valuation.baseDecimals < 0 || valuation.baseDecimals > 36
      || !(valuation.observedAt instanceof Date) || !(valuation.expiresAt instanceof Date)
      || !Number.isFinite(valuation.observedAt.getTime()) || !Number.isFinite(valuation.expiresAt.getTime())
      || valuation.observedAt > now || valuation.expiresAt <= now || now.getTime() - valuation.observedAt.getTime() > input.maximumAgeMs) return null;
    try {
      exactDecimal(valuation.priceUsd, true); exactDecimal(valuation.simulatedFeeBps); exactDecimal(valuation.simulatedFixedFeeUsd);
      if (compareExactDecimal(valuation.simulatedFeeBps, '10000') > 0) return null;
      let base: string;
      if (execution.requestedBaseQuantity !== null) {
        base = exactDecimal(execution.requestedBaseQuantity, true);
        const scaled = divideDecimalText(base, '1', valuation.baseDecimals)!;
        if (compareExactDecimal(base, scaled) !== 0) return null;
      } else {
        if (execution.direction !== 'buy' || !execution.requestedQuoteQuantity) return null;
        base = divideDecimalText(exactDecimal(execution.requestedQuoteQuantity, true), valuation.priceUsd, valuation.baseDecimals)!;
        if (compareExactDecimal(base, '0') <= 0) return null;
      }
      const quoteUsd = multiplyDecimalText(base, valuation.priceUsd);
      if (execution.direction === 'buy' && execution.requestedQuoteQuantity !== null
        && compareExactDecimal(quoteUsd, exactDecimal(execution.requestedQuoteQuantity, true)) > 0) return null;
      const fee = addExactDecimal(valuation.simulatedFixedFeeUsd,
        multiplyDecimalText(multiplyDecimalText(quoteUsd, valuation.simulatedFeeBps), '0.0001'));
      const debit = addExactDecimal(quoteUsd, fee);
      const evidenceId = `paper:${execution.clientOrderId}:${valuation.evidenceId}:${valuation.simulationModelId}`;
      const observedAt = new Date(valuation.observedAt), expiresAt = new Date(valuation.expiresAt);
      return { requestedDebitUsd: execution.direction === 'buy' ? debit : null,
        execute: async intent => {
          const effectAt = input.now();
          if (!sameExecution(intent.execution, execution) || intent.attempt.executionId !== execution.id
            || intent.attempt.userId !== execution.userId || !Number.isFinite(effectAt.getTime())
            || effectAt < observedAt || effectAt >= expiresAt || effectAt.getTime() - observedAt.getTime() > input.maximumAgeMs) {
            return { kind: 'unknown', reason: 'paper-quote-scope-or-provenance-expired-before-effect' };
          }
          return { kind: 'fill', executor: 'paper-exact-simulated', evidence: {
            executionId: execution.id, evidenceType: 'paper_simulation', evidenceId,
            baseQuantity: base, quoteLeg: { amount: quoteUsd, currency: 'USD' }, priceUsd: valuation.priceUsd,
            feeUsd: fee, confirmationState: 'confirmed', completesExecution: true, occurredAt: effectAt } };
        } };
    } catch { return null; }
  };
}

/** Legacy injected exit test seam, NOT used by createExecutorJobPorts. Production
 * requires the provenance-bearing provider contract above. */
export function createExactPaperExitQuote(input: {
  readonly readValuation: (execution: CopyExecutionRecord) => Promise<PaperValuation | null>;
  readonly now: () => Date;
  readonly maximumAgeMs: number;
}) {
  return async (execution: CopyExecutionRecord): Promise<CanonicalWorkerQuote | null> => {
    if (execution.executionMode !== 'paper' || execution.direction !== 'sell' || !execution.requestedBaseQuantity) return null;
    const valuation = await input.readValuation(execution), now = input.now();
    if (!valuation || !valuation.evidenceId || !(valuation.observedAt instanceof Date)
      || !Number.isFinite(valuation.observedAt.getTime()) || !Number.isSafeInteger(input.maximumAgeMs) || input.maximumAgeMs <= 0
      || now.getTime() - valuation.observedAt.getTime() > input.maximumAgeMs || valuation.observedAt > now
      || !/^\d+(?:\.\d+)?$/.test(valuation.priceUsd) || !/[1-9]/.test(valuation.priceUsd)) return null;
    const quoteUsd = multiplyDecimalText(execution.requestedBaseQuantity, valuation.priceUsd);
    return { requestedDebitUsd: null, execute: async intent => ({ kind: 'fill', executor: 'paper-exact',
      evidence: { executionId: intent.execution.id, evidenceType: 'paper_simulation',
        evidenceId: `paper:${execution.clientOrderId}:${valuation.evidenceId}`, baseQuantity: execution.requestedBaseQuantity!,
        quoteLeg: { amount: quoteUsd, currency: 'USD' }, priceUsd: valuation.priceUsd, feeUsd: '0',
        confirmationState: 'confirmed', completesExecution: true, occurredAt: valuation.observedAt } }) };
  };
}
export const unavailableCanonicalQuote = async (): Promise<CanonicalWorkerQuote | null> => null;
