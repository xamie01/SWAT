import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJupiterJitoRuntime, type JupiterJitoRuntimeOptions, type JupiterJitoSubmitInput } from './jupiter-jito-runtime.js';

// Entire transport barrel is mocked: no source barrel, RPC, credentials or keys.
const transport = vi.hoisted(() => ({
  buildJupiterSwap: vi.fn(), submitJitoBundle: vi.fn(), getJitoBundleStatus: vi.fn(),
  getJitoTipFloor: vi.fn(), getJitoTipAccounts: vi.fn()
}));
vi.mock('@swat/shared', () => ({ ...transport,
  selectJitoTip: () => 100, selectTipAccount: () => 'opaque-tip-recipient',
  fetchTokenPriceUsd: vi.fn(async () => null), lamportsToUsd: vi.fn(() => null)
}));

const execution = { executionId: 'execution-one', clientOrderId: 'swat-one', userId: 'tenant-one', chain: 'solana' as const, targetAccount: 'solana:opaque-account' };
const input = {
  clientOrderId: execution.clientOrderId, execution,
  signerPublicKey: 'opaque-account',
  intent: { inputMint: 'mint-in', outputMint: 'mint-out', inputAmountRaw: '1000', slippageBps: 50, recipient: 'opaque-account' },
  quote: { inputMint: 'mint-in', outputMint: 'mint-out', inAmount: '1000', outAmount: '900', otherAmountThreshold: '896', swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0', routePlan: [], contextSlot: 1 }
} satisfies JupiterJitoSubmitInput;

function fixture() {
  let pending: any = null;
  let resolved: any = null;
  let claimed = false;
  const store = {
    findPending: vi.fn(async () => pending), findResolution: vi.fn(async () => resolved),
    listPending: vi.fn(async () => pending ? [pending] : []),
    claim: vi.fn(async () => { if (claimed) return false; claimed = true; return true; }),
    prepare: vi.fn(async (value: any) => { pending = structuredClone(value); }),
    save: vi.fn(async (value: any) => { pending = structuredClone(value); }),
    resolve: vi.fn(async (_id: string, value: any) => { resolved = value; pending = null; })
  };
  const options = {
    pendingStore: store, jito: { baseUrl: 'https://transport.invalid' },
    signTransaction: vi.fn(async (bytes: string) => bytes === 'opaque-swap' ? 'opaque-signed-swap' : 'opaque-signed-tip'),
    buildTipTransaction: vi.fn(async () => 'opaque-tip'),
    extractSignatures: vi.fn(async () => ['opaque-swap-signature', 'opaque-tip-signature']),
    simulation: { evaluate: vi.fn(async () => ({ kind: 'submit' as const, outcome: { kind: 'proceed' as const, unitsConsumed: 1, slot: 1 } })) },
    maxTipLamports: 100, fallbackTipLamports: 100, pendingTtlMs: 600000,
    now: () => new Date('2026-11-13T00:00:00Z')
  } satisfies JupiterJitoRuntimeOptions;
  return { store, options, runtime: createJupiterJitoRuntime(options) };
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.buildJupiterSwap.mockResolvedValue({ swapTransaction: 'opaque-swap', lastValidBlockHeight: 100 });
  transport.getJitoTipFloor.mockResolvedValue(null);
  transport.getJitoTipAccounts.mockResolvedValue(['opaque-tip-recipient']);
  transport.submitJitoBundle.mockResolvedValue({ ok: true, bundleId: 'opaque-bundle' });
  transport.getJitoBundleStatus.mockResolvedValue({ bundleId: 'opaque-bundle', status: 'Landed', transactions: ['opaque-swap-signature'], slot: 10 });
});

describe('package17 durable Jito public submit seam', () => {
  it('commits exact signed identity before the first transport call', async () => {
    const { runtime, store } = fixture();
    transport.submitJitoBundle.mockImplementation(async (bytes: string[]) => {
      const durable = await store.findPending();
      expect(durable).toMatchObject({ execution, bundleId: null, signatures: ['opaque-swap-signature', 'opaque-tip-signature'], signedTransactions: bytes });
      expect(durable.expiresAt).toBeInstanceOf(Date);
      return { ok: true, bundleId: 'opaque-bundle' };
    });
    expect((await runtime.submit(input)).status).toBe('submitted');
    expect(transport.submitJitoBundle).toHaveBeenCalledTimes(1);
  });

  it('retains exact signatures across accepted-send/lost-response and a restarted runtime', async () => {
    const { runtime, options, store } = fixture();
    transport.submitJitoBundle.mockRejectedValue(new Error('accepted response lost'));
    expect((await runtime.submit(input)).status).toBe('submission_unknown');
    expect(await store.findPending()).toMatchObject({ bundleId: null, signatures: ['opaque-swap-signature', 'opaque-tip-signature'] });
    expect((await createJupiterJitoRuntime(options).submit(input)).status).toBe('submission_unknown');
    expect(transport.buildJupiterSwap).toHaveBeenCalledTimes(1);
    expect(transport.submitJitoBundle).toHaveBeenCalledTimes(1);
  });

  it('allows one atomic owner across overlapping runtime instances', async () => {
    const { runtime, options } = fixture();
    const results = await Promise.all([runtime.submit(input), createJupiterJitoRuntime(options).submit(input)]);
    expect(results.map(result => result.status).sort()).toEqual(['submission_unknown', 'submitted']);
    expect(transport.buildJupiterSwap).toHaveBeenCalledTimes(1);
    expect(transport.submitJitoBundle).toHaveBeenCalledTimes(1);
  });

  it('does not send when durable preparation fails, and does not rebuild after ownership was retained', async () => {
    const { runtime, options, store } = fixture();
    store.prepare.mockRejectedValue(new Error('commit response lost'));
    expect((await runtime.submit(input)).status).toBe('submission_unknown');
    expect((await createJupiterJitoRuntime(options).submit(input)).status).toBe('submission_unknown');
    expect(transport.submitJitoBundle).not.toHaveBeenCalled();
    expect(transport.buildJupiterSwap).toHaveBeenCalledTimes(1);
  });

  it('retains prewrite when response metadata cannot be saved', async () => {
    const { runtime, store } = fixture();
    store.save.mockRejectedValue(new Error('metadata store unavailable'));
    expect((await runtime.submit(input)).status).toBe('submission_unknown');
    expect(await store.findPending()).toMatchObject({ bundleId: null, signedTransactions: ['opaque-signed-swap', 'opaque-signed-tip'] });
  });

  it('does not query a placeholder or conclude non-fill from blockhash expiry', async () => {
    const { runtime, store } = fixture();
    await store.save({ clientOrderId: 'swat-one', bundleId: 'pending_unknown', lastValidBlockHeight: 1, expiresAt: new Date(0) });
    expect(await runtime.reconcile((await store.findPending())!, 10000)).toMatchObject({ status: 'ambiguous' });
    expect(transport.getJitoBundleStatus).not.toHaveBeenCalled();
    expect(await runtime.sweep(10000)).toHaveLength(1);
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('observes landed identity without inventing a quantified fill or acknowledging it', async () => {
    const { runtime, store } = fixture();
    await runtime.submit(input);
    expect(await runtime.sweep(101)).toEqual([expect.objectContaining({ status: 'ambiguous', reason: 'confirmed-receipt-unavailable' })]);
    expect(store.resolve).not.toHaveBeenCalled();
    expect(await store.listPending()).toHaveLength(1);
  });

  it('acknowledges only after a quantified identity-bound accounting commit, replaying DB failure', async () => {
    const { options, store } = fixture();
    const readReceipt = vi.fn(async () => ({ execution, signature: 'opaque-swap-signature', slot: 10,
      inputMint: 'mint-in', outputMint: 'mint-out', inputAmountRaw: '1000', outputAmountRaw: '899', feeLamports: '105', feeUsd: '0.000021' }));
    const runtime = createJupiterJitoRuntime({ ...options, readReceipt });
    await runtime.submit(input);
    const observation = (await runtime.sweep(101))[0]!;
    expect(observation).toMatchObject({ status: 'filled', receipt: { inputAmountRaw: '1000', outputAmountRaw: '899', feeLamports: '105' } });
    const commit = vi.fn(async () => { throw new Error('DB rollback'); });
    expect(await runtime.settle(observation, commit)).toBe(false);
    expect(store.resolve).not.toHaveBeenCalled();
    const committed = vi.fn(async (pending, result) => {
      expect(await store.listPending()).toHaveLength(1);
      expect(pending.execution).toEqual(execution);
      expect(result).toEqual(observation);
      return true;
    });
    expect(await runtime.settle((await runtime.sweep(101))[0]!, committed)).toBe(true);
    expect(store.resolve).toHaveBeenCalledTimes(1);
    expect(await store.listPending()).toHaveLength(0);
  });
});
