import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock('@swat/shared', () => ({
  buildJupiterSwap: vi.fn().mockResolvedValue({ swapTransaction: 'inert-not-a-transaction', lastValidBlockHeight: 1000 }),
  fetchTokenPriceUsd: vi.fn().mockResolvedValue(100), getJitoBundleStatus: vi.fn(),
  getJitoTipAccounts: vi.fn().mockResolvedValue(['inert-tip-account']), getJitoTipFloor: vi.fn().mockResolvedValue({}),
  lamportsToUsd: vi.fn().mockReturnValue(0), selectJitoTip: vi.fn().mockReturnValue(1),
  selectTipAccount: vi.fn().mockReturnValue('inert-tip-account'), submitJitoBundle: mock.submit
}));
import { createJupiterJitoRuntime } from '../../apps/trade-executor/src/jupiter-jito-runtime.js';

function runtime() {
  const pending = new Map<string, any>();
  const resolved = new Map<string, any>();
  const store = {
    findResolution: vi.fn(async (id: string) => resolved.get(id) ?? null),
    findPending: vi.fn(async (id: string) => pending.get(id) ?? null),
    listPending: vi.fn(async () => [...pending.values()]),
    save: vi.fn(async (row: any) => { pending.set(row.clientOrderId, row); }),
    resolve: vi.fn(async (id: string, row: any) => { pending.delete(id); resolved.set(id, row); })
  };
  return { store, service: createJupiterJitoRuntime({
    pendingStore: store, jito: { baseUrl: 'https://synthetic.invalid' },
    signTransaction: async (text) => text, buildTipTransaction: async () => 'inert-tip',
    maxTipLamports: 10, fallbackTipLamports: 1, pendingTtlMs: 60000
  }) };
}
const input = { clientOrderId: 'fixture-order', signerPublicKey: 'inert-account', quote: {} as any };
beforeEach(() => { vi.clearAllMocks(); });

describe('Submission durability contract; no real transaction or transport', () => {
  it('PF-EXE-03: persist a recoverable identity before any transport invocation', async () => {
    const { service, store } = runtime();
    let persistedBeforeSend = false;
    mock.submit.mockImplementation(async () => {
      persistedBeforeSend = store.save.mock.calls.length > 0;
      return { ok: true, bundleId: 'fixture-bundle' };
    });
    await service.submit(input);
    expect(persistedBeforeSend).toBe(true);
  });
  it('PF-EXE-03: two overlapping requests for one identity must invoke transport once', async () => {
    const { service } = runtime();
    mock.submit.mockResolvedValue({ ok: true, bundleId: 'fixture-bundle' });
    await Promise.all([service.submit(input), service.submit(input)]);
    expect(mock.submit).toHaveBeenCalledTimes(1);
  });
  it('PF-EXE-03: unknown transport outcome must retain a real recoverable transaction identity', async () => {
    const { service, store } = runtime();
    mock.submit.mockResolvedValue({ ok: false, retryable: true, reason: 'synthetic lost response' });
    await service.submit(input);
    expect(store.save.mock.calls[0][0].bundleId).not.toBe('pending_unknown');
  });
});
