import { beforeEach, describe, expect, it, vi } from 'vitest';
// The full application entrypoint is not launched. SDK/runtime edges are mocked
// by the neighboring execution lifecycle harness; no signer or service is used.
const mocks = vi.hoisted(() => ({ run: vi.fn(), transaction: vi.fn(), mode: vi.fn(), quote: vi.fn(), settle: vi.fn() }));
vi.mock('./jupiter-jito-config.js', () => ({ getConfiguredCanonicalJitoQuote: () => mocks.quote,
  settleConfiguredJitoResolution: mocks.settle }));
vi.mock('./worker-policy.js', () => ({ runCanonicalWorkerJob: mocks.run }));
vi.mock('@swat/db', async () => ({ ...await vi.importActual<typeof import('@swat/db')>('@swat/db'),
  withTransaction: mocks.transaction, resolveChainMode: mocks.mode }));
vi.mock('./robinhood.js', () => ({ evmAccount: null, WETH_ROBINHOOD: '0x0000000000000000000000000000000000000001' }));
vi.mock('./polymarket.js', () => ({ polymarketSigner: null }));
import { handleJob, settleJitoSweepResolutions, createExecutorJobPorts } from './index.js';
beforeEach(() => { vi.clearAllMocks(); mocks.run.mockResolvedValue({ status: 'paper-filled' }); });
describe('production handleJob canonical join', () => {
  it('actual createExecutorJobPorts installs immutable scope lookup and paper provider adapter consumed by processor', async () => {
    const now = new Date('2026-11-17T00:00:00Z');
    const ports = createExecutorJobPorts({ paperValuation: { providerId:'reviewed',providerIdentity:'backend',
      networkForChain:()=> 'fixture',readValuation:async execution=> ({ providerId:'reviewed',providerIdentity:'backend',
        chain:execution.chain,network:'fixture',tokenMint:execution.tokenMint,baseDecimals:18,quoteCurrency:'USD',
        evidenceId:'price',priceUsd:'0.1',observedAt:now,expiresAt:new Date(now.getTime()+1000),
        simulationModelId:'simulated',simulatedFeeBps:'10',simulatedFixedFeeUsd:'0' }) }, now:()=>now,maximumAgeMs:1000 });
    const data={copyExecutionId:'22222222-2222-2222-2222-222222222222',userId:'foreign'};
    await handleJob({data},ports);
    expect(mocks.run).toHaveBeenCalledWith(data,expect.objectContaining({ transaction:expect.any(Function),quote:ports.canonicalQuote,
      deliveryOwner:ports.deliveryOwner,now:ports.now }));
    expect(ports.canonicalTransaction?.({userId:'foreign'})).toBeNull();
    expect(await ports.canonicalQuote!({id:data.copyExecutionId,chain:'solana',tokenMint:'solana:token',direction:'buy',
      executionMode:'paper',requestedBaseQuantity:null,requestedQuoteQuantity:'0.3',clientOrderId:'order'} as never,50))
      .toMatchObject({requestedDebitUsd:'0.3003'});
    const defaults=createExecutorJobPorts();
    expect(await defaults.canonicalQuote!({executionMode:'paper',direction:'buy'} as never,50)).toBeNull();
  });
  it('delegates canonical work to real orchestration boundary instead of queue boolean/float legacy path', async () => {
    const data = { copyExecutionId: 'canonical', closeAll: true, sellTokenAmount: 0.1 };
    const authorize = vi.fn(), quote = vi.fn();
    expect(await handleJob({ data }, { authorize, canonicalQuote: quote, canonicalTransaction: () => mocks.transaction })).toEqual({ status: 'paper-filled' });
    expect(mocks.run).toHaveBeenCalledWith(data, expect.objectContaining({ transaction: mocks.transaction, authorize, quote }));
  });
  it('reads configured Jito adapter at actual handleJob boundary without fabricating tenant scope', async () => {
    const data = { copyExecutionId: 'canonical' };
    await handleJob({ data }, { authorize: vi.fn(), canonicalTransaction: () => mocks.transaction });
    expect(mocks.run).toHaveBeenCalledWith(data, expect.objectContaining({ quote: mocks.quote }));
  });
  it('actual sweep settlement seam uses opaque resolution identity and configured receipt committer', async () => {
    const resolutions = [{ status: 'failed', clientOrderId: 'swat-opaque-not-uuid', reason: 'unknown' }] as const;
    mocks.settle.mockResolvedValue(false);
    await settleJitoSweepResolutions(resolutions);
    expect(mocks.settle).toHaveBeenCalledWith(resolutions[0]);
    expect(mocks.transaction).not.toHaveBeenCalled();
    mocks.settle.mockRejectedValue(new Error('receipt transaction did not commit'));
    await expect(settleJitoSweepResolutions(resolutions)).rejects.toThrow('receipt transaction did not commit');
  });
  it('missing approved durable tenant scope blocks before unscoped SQL or quote', async () => {
    expect(await handleJob({ data: { copyExecutionId: 'canonical', userId: 'foreign' } }, { authorize: vi.fn() }))
      .toEqual({ status: 'skipped', reason: 'approved-worker-tenant-scope-unavailable' });
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([{ stopLoss: true }, { closeAll: true }, { exitLotId: 'foreign' }])('queue exit flags without canonical claim never reach legacy executor', async data => {
    expect(await handleJob({ data }, { authorize: vi.fn() })).toEqual({ status: 'skipped', reason: 'canonical-lot-exit-required' });
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
