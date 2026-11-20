import { describe, expect, it, vi } from 'vitest';
import type { CopyExecutionRecord } from '@swat/db/dist/copy-trade-lifecycle-owned.js';
import { createExactPaperQuote, type ProvenancePaperValuation } from './worker-paper-quote.js';
import { createExecutorRuntimePorts } from './worker-runtime-adapters.js';
const now = new Date('2026-11-17T00:00:00Z');
const execution = { id: '22222222-2222-2222-2222-222222222222', userId: '11111111-1111-1111-1111-111111111111',
  clientOrderId: 'canonical-order', targetAccount: 'solana:target', tokenMint: 'solana:token', chain: 'solana',
  direction: 'buy', executionMode: 'paper', requestedBaseQuantity: null, requestedQuoteQuantity: '0.3',
  sourceTradeId: '33333333-3333-3333-3333-333333333333', exitLotId: null } as CopyExecutionRecord;
const valuation: ProvenancePaperValuation = { providerId: 'reviewed', providerIdentity: 'provider-backend', evidenceId: 'price-1',
  chain: 'solana', network: 'solana-fixture', tokenMint: execution.tokenMint, baseDecimals: 18, quoteCurrency: 'USD',
  observedAt: now, expiresAt: new Date(now.getTime()+5000), priceUsd: '0.1', simulationModelId: 'explicit-simulated-fee-model',
  simulatedFeeBps: '10', simulatedFixedFeeUsd: '0.000000000000000001' };
function provider(observation = valuation) { return { providerId: valuation.providerId, providerIdentity: valuation.providerIdentity,
  networkForChain: () => valuation.network, readValuation: vi.fn(async () => observation) }; }
function intent(record = execution) { return { execution: record,
  attempt: { executionId: record.id, userId: record.userId, fence: '1', policyRevision: 'revision', riskEpoch: '7' },
  risk: null, maxSlippageBps: 50 }; }
describe('provenance exact simulated paper buy and sell runtime', () => {
  it('exact buy quantity, notional and simulated fee risk debit remain decimal text', async () => {
    const quote = await createExactPaperQuote({ provider: provider(), now: () => now, maximumAgeMs: 1000 })(execution);
    expect(quote?.requestedDebitUsd).toBe('0.300300000000000001');
    const fill = await quote!.execute(intent());
    expect(fill).toMatchObject({ kind: 'fill', executor: 'paper-exact-simulated', evidence: {
      baseQuantity: '3', quoteLeg: { amount: '0.3', currency: 'USD' }, feeUsd: '0.000300000000000001',
      evidenceType: 'paper_simulation', occurredAt: now } });
  });
  it('exact sell preserves above-float-safe quantity and explicit fee without live lot conversion', async () => {
    const sell = { ...execution, direction: 'sell' as const, requestedBaseQuantity: '9007199254740993.000000000000000001', requestedQuoteQuantity: null };
    const quote = await createExactPaperQuote({ provider: provider({ ...valuation, priceUsd: '2' }), now: () => now, maximumAgeMs: 1000 })(sell);
    expect(quote?.requestedDebitUsd).toBeNull();
    const fill = await quote!.execute(intent(sell));
    expect(fill).toMatchObject({ kind: 'fill', evidence: { baseQuantity: sell.requestedBaseQuantity,
      quoteLeg: { amount: '18014398509481986.000000000000000002', currency: 'USD' } } });
    expect(await createExactPaperQuote({ provider: provider(), now: () => now, maximumAgeMs: 1000 })({ ...sell, executionMode: 'live' })).toBeNull();
  });
  it.each(['providerId','providerIdentity','network','tokenMint','chain','quoteCurrency'])('rejects wrong provenance %s', async field => {
    const observation = { ...valuation, [field]: 'foreign' } as ProvenancePaperValuation;
    expect(await createExactPaperQuote({ provider: provider(observation), now: () => now, maximumAgeMs: 1000 })(execution)).toBeNull();
  });
  it.each([new Date(now.getTime()-1001),new Date(now.getTime()+1)])('rejects stale/future price observation', async observedAt => {
    expect(await createExactPaperQuote({ provider: provider({ ...valuation, observedAt }), now: () => now, maximumAgeMs: 1000 })(execution)).toBeNull();
  });
  it('refuses nonrepresentable base scale and missing economics instead of rounding sell or fake zero fee', async () => {
    const sell = { ...execution, direction: 'sell' as const, requestedBaseQuantity: '0.000000001', requestedQuoteQuantity: null };
    expect(await createExactPaperQuote({ provider: provider({ ...valuation, baseDecimals: 8 }), now: () => now, maximumAgeMs: 1000 })(sell)).toBeNull();
    expect(await createExactPaperQuote({ provider: provider({ ...valuation, simulatedFeeBps: null } as never), now: () => now, maximumAgeMs: 1000 })(execution)).toBeNull();
  });
  it('expired quote after durable prepare is uncertainty, not paper fill', async () => {
    let clock = now;
    const quote = await createExactPaperQuote({ provider: provider(), now: () => clock, maximumAgeMs: 1000 })(execution);
    clock = new Date(now.getTime()+1001); expect(await quote!.execute(intent())).toMatchObject({ kind: 'unknown' });
    clock = now; expect(await quote!.execute(intent({ ...execution, userId: 'foreign' }))).toMatchObject({ kind: 'unknown' });
  });
  it('actual runtime factory consumes reviewed paper adapter and retains dynamic trusted Jito live seam', async () => {
    const live = vi.fn(async () => null); const p = provider();
    const ports = createExecutorRuntimePorts({ paperValuation: p, now: () => now, maximumAgeMs: 1000 }, live);
    expect((await ports.canonicalQuote(execution,50))?.requestedDebitUsd).toBe('0.300300000000000001');
    expect(p.readValuation).toHaveBeenCalledWith(execution); expect(live).not.toHaveBeenCalled();
    await ports.canonicalQuote({ ...execution, executionMode: 'live' },50); expect(live).toHaveBeenCalledOnce();
    expect(ports.canonicalTransaction({ userId: execution.userId })).toBeNull();
  });
  it('does not truncate simulated fee below 36 fractional digits', async () => {
    const tiny = {...execution,requestedBaseQuantity:'0.000000000000000001',requestedQuoteQuantity:null};
    const quote = await createExactPaperQuote({provider:provider({...valuation,priceUsd:'0.000000000000000001',simulatedFixedFeeUsd:'0'}),
      now:()=>now,maximumAgeMs:1000})(tiny);
    const fill=await quote!.execute(intent(tiny));
    expect(fill).toMatchObject({kind:'fill',evidence:{feeUsd:'0.000000000000000000000000000000000000001'}});
  });
  it('default missing provider is unavailable and never fabricates simulation authority', async () => {
    const ports = createExecutorRuntimePorts({ paperValuation: null, now: () => now, maximumAgeMs: 1000 }, async () => null);
    expect(await ports.canonicalQuote(execution,50)).toBeNull();
  });
});
