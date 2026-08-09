import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createJupiterJitoRuntime,
  type JupiterJitoPendingStore,
  type JupiterJitoResolution,
  type PendingJupiterJitoSubmission
} from './jupiter-jito-runtime.js';
import type { JupiterQuote } from '@swat/shared';

// The runtime reaches @swat/shared for transport; every network edge is mocked
// so these assert the state machine, not the wire format.
const mocks = vi.hoisted(() => ({
  buildJupiterSwap: vi.fn(),
  submitJitoBundle: vi.fn(),
  getJitoBundleStatus: vi.fn(),
  getJitoTipFloor: vi.fn()
}));

vi.mock('@swat/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@swat/shared')>();
  return {
    ...actual,
    buildJupiterSwap: mocks.buildJupiterSwap,
    submitJitoBundle: mocks.submitJitoBundle,
    getJitoBundleStatus: mocks.getJitoBundleStatus,
    getJitoTipFloor: mocks.getJitoTipFloor
  };
});

const QUOTE = { inAmount: '1000', outAmount: '900' } as unknown as JupiterQuote;

function memoryStore(): JupiterJitoPendingStore {
  const pending = new Map<string, PendingJupiterJitoSubmission>();
  const resolved = new Map<string, JupiterJitoResolution>();
  return {
    async findPending(id) {
      return pending.get(id) ?? null;
    },
    async findResolution(id) {
      return resolved.get(id) ?? null;
    },
    async listPending() {
      return [...pending.values()];
    },
    async save(p) {
      pending.set(p.clientOrderId, p);
    },
    async resolve(id, resolution) {
      pending.delete(id);
      resolved.set(id, resolution);
    }
  };
}

function makeRuntime(store: JupiterJitoPendingStore, now = () => new Date('2026-08-05T00:00:00Z')) {
  return createJupiterJitoRuntime({
    pendingStore: store,
    jito: { baseUrl: 'https://block-engine.test' },
    signTransaction: async (tx) => `signed:${tx}`,
    buildTipTransaction: async ({ tipAccount, lamports }) => `tip:${tipAccount}:${lamports}`,
    maxTipLamports: 1_000_000,
    fallbackTipLamports: 10_000,
    pendingTtlMs: 600_000,
    now
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildJupiterSwap.mockResolvedValue({
    swapTransaction: 'base64-swap',
    lastValidBlockHeight: 1_000
  });
  mocks.getJitoTipFloor.mockResolvedValue({
    p25: 1_000, p50: 5_000, p75: 20_000, p95: 100_000, p99: 500_000
  });
  mocks.submitJitoBundle.mockResolvedValue({ ok: true, bundleId: 'bundle-1' });
});

describe('construction guards', () => {
  it('rejects an unbounded tip cap', () => {
    // Without a positive cap the tip is unbounded, and it is real SOL charged
    // against position P&L on every single trade.
    expect(() =>
      createJupiterJitoRuntime({
        pendingStore: memoryStore(),
        jito: { baseUrl: 'x' },
        signTransaction: async (t) => t,
        buildTipTransaction: async () => 'tip',
        maxTipLamports: 0,
        fallbackTipLamports: 1,
        pendingTtlMs: 600_000
      })
    ).toThrow(/maxTipLamports/);
  });

  it('rejects a too-short pending TTL', () => {
    expect(() =>
      createJupiterJitoRuntime({
        pendingStore: memoryStore(),
        jito: { baseUrl: 'x' },
        signTransaction: async (t) => t,
        buildTipTransaction: async () => 'tip',
        maxTipLamports: 1_000,
        fallbackTipLamports: 1,
        pendingTtlMs: 1_000
      })
    ).toThrow(/pendingTtlMs/);
  });
});

describe('submit idempotency', () => {
  it('never resubmits a resolved order', async () => {
    const store = memoryStore();
    await store.resolve('order-1', { status: 'filled', clientOrderId: 'order-1', signature: 'sig', slot: 5 });
    const runtime = makeRuntime(store);

    const result = await runtime.submit({
      clientOrderId: 'order-1',
      quote: QUOTE,
      signerPublicKey: 'signer'
    });

    expect(result.status).toBe('already_resolved');
    // The critical assertion: nothing was transmitted.
    expect(mocks.submitJitoBundle).not.toHaveBeenCalled();
  });

  it('never double-submits an in-flight order', async () => {
    const store = memoryStore();
    const runtime = makeRuntime(store);

    await runtime.submit({ clientOrderId: 'order-2', quote: QUOTE, signerPublicKey: 's' });
    expect(mocks.submitJitoBundle).toHaveBeenCalledTimes(1);

    const second = await runtime.submit({ clientOrderId: 'order-2', quote: QUOTE, signerPublicKey: 's' });
    expect(second.status).toBe('pending_confirmation');
    // A redelivered queue job must not open a second position.
    expect(mocks.submitJitoBundle).toHaveBeenCalledTimes(1);
  });
});

describe('submit failure classification', () => {
  it('reports a retryable transport failure as submission_unknown, not rejected', async () => {
    // The bundle may have been received. Calling this "rejected" would let the
    // caller retry into a duplicate position.
    mocks.submitJitoBundle.mockResolvedValue({ ok: false, reason: 'timeout', retryable: true });
    const result = await makeRuntime(memoryStore()).submit({
      clientOrderId: 'order-3',
      quote: QUOTE,
      signerPublicKey: 's'
    });
    expect(result.status).toBe('submission_unknown');
  });

  it('reports a definitive rejection as rejected', async () => {
    mocks.submitJitoBundle.mockResolvedValue({ ok: false, reason: 'bad-bundle', retryable: false });
    const result = await makeRuntime(memoryStore()).submit({
      clientOrderId: 'order-4',
      quote: QUOTE,
      signerPublicKey: 's'
    });
    expect(result.status).toBe('rejected');
  });

  it('never falls back to a public RPC broadcast when Jito is unavailable', async () => {
    // S3-5. A silent downgrade would reintroduce the exact front-running
    // exposure bundles exist to remove, while the operator still believed they
    // were protected. Failing honestly lets the breaker count it.
    mocks.submitJitoBundle.mockResolvedValue({ ok: false, reason: 'engine-down', retryable: true });
    const result = await makeRuntime(memoryStore()).submit({
      clientOrderId: 'order-5',
      quote: QUOTE,
      signerPublicKey: 's'
    });
    expect(result.status).toBe('submission_unknown');
    expect(JSON.stringify(result)).not.toMatch(/rpc|broadcast/i);
  });

  it('rejects when the swap cannot be built', async () => {
    mocks.buildJupiterSwap.mockResolvedValue(null);
    const result = await makeRuntime(memoryStore()).submit({
      clientOrderId: 'order-6',
      quote: QUOTE,
      signerPublicKey: 's'
    });
    expect(result).toMatchObject({ status: 'rejected', reason: 'swap-build-failed' });
    expect(mocks.submitJitoBundle).not.toHaveBeenCalled();
  });

  it('treats a signing failure as rejected, since nothing was transmitted', async () => {
    const runtime = createJupiterJitoRuntime({
      pendingStore: memoryStore(),
      jito: { baseUrl: 'x' },
      signTransaction: async () => {
        throw new Error('hsm offline');
      },
      buildTipTransaction: async () => 'tip',
      maxTipLamports: 1_000_000,
      fallbackTipLamports: 10_000,
      pendingTtlMs: 600_000
    });
    const result = await runtime.submit({
      clientOrderId: 'order-7',
      quote: QUOTE,
      signerPublicKey: 's'
    });
    expect(result.status).toBe('rejected');
    expect(mocks.submitJitoBundle).not.toHaveBeenCalled();
  });

  it('caps the tip even when the floor spikes', async () => {
    mocks.getJitoTipFloor.mockResolvedValue({
      p25: 0, p50: 0, p75: 99_000_000, p95: 0, p99: 0
    });
    await makeRuntime(memoryStore()).submit({
      clientOrderId: 'order-8',
      quote: QUOTE,
      signerPublicKey: 's'
    });
    // maxTipLamports is 1_000_000 in the fixture.
    const submitted = mocks.submitJitoBundle.mock.calls[0]![0] as string[];
    const tipTx = submitted.find((tx) => tx.includes('tip:'))!;
    const lamports = Number(tipTx.split(':').at(-1));
    expect(lamports).toBe(1_000_000);
  });
});

describe('reconciliation', () => {
  const pending: PendingJupiterJitoSubmission = {
    clientOrderId: 'order-r',
    bundleId: 'bundle-r',
    lastValidBlockHeight: 1_000,
    expiresAt: new Date('2026-08-05T00:10:00Z')
  };

  it('returns null when the outcome cannot be observed', async () => {
    // Distinct from `failed` on purpose: treating an unreachable block engine as
    // failure would let the executor re-enter a position that is actually live.
    mocks.getJitoBundleStatus.mockResolvedValue(null);
    const resolution = await makeRuntime(memoryStore()).reconcile(pending, 500);
    expect(resolution).toBe(null);
  });

  it('resolves a landed bundle to filled with its signature', async () => {
    mocks.getJitoBundleStatus.mockResolvedValue({
      bundleId: 'bundle-r', status: 'Landed', transactions: ['sig-abc'], slot: 42
    });
    const resolution = await makeRuntime(memoryStore()).reconcile(pending, 500);
    expect(resolution).toMatchObject({ status: 'filled', signature: 'sig-abc', slot: 42 });
  });

  it('never fabricates a signature for a landed bundle that reports none', async () => {
    // A fill we cannot quantify must stay ambiguous. Inventing one would corrupt
    // the position ledger permanently.
    mocks.getJitoBundleStatus.mockResolvedValue({
      bundleId: 'bundle-r', status: 'Landed', transactions: [], slot: 42
    });
    const resolution = await makeRuntime(memoryStore()).reconcile(pending, 500);
    expect(resolution).toMatchObject({ status: 'ambiguous', reason: 'landed-without-signature' });
  });

  it('resolves an explicitly failed bundle', async () => {
    mocks.getJitoBundleStatus.mockResolvedValue({
      bundleId: 'bundle-r', status: 'Failed', transactions: [], slot: null
    });
    const resolution = await makeRuntime(memoryStore()).reconcile(pending, 500);
    expect(resolution).toMatchObject({ status: 'failed', reason: 'bundle-failed' });
  });

  it('stays unresolved while pending below the expiry block height', async () => {
    // `Invalid` alone may just be propagation lag.
    mocks.getJitoBundleStatus.mockResolvedValue({
      bundleId: 'bundle-r', status: 'Invalid', transactions: [], slot: null
    });
    const resolution = await makeRuntime(memoryStore()).reconcile(pending, 999);
    expect(resolution).toBe(null);
  });

  it('declares a miss only once the blockhash has expired', async () => {
    // Past lastValidBlockHeight the transaction can never land — the only safe
    // point to call it. This is also why a retry needs a FRESH quote and build.
    mocks.getJitoBundleStatus.mockResolvedValue({
      bundleId: 'bundle-r', status: 'Invalid', transactions: [], slot: null
    });
    const resolution = await makeRuntime(memoryStore()).reconcile(pending, 1_001);
    expect(resolution).toMatchObject({ status: 'failed', reason: 'blockhash-expired' });
  });

  it('marks a timed-out bundle ambiguous rather than failed', async () => {
    mocks.getJitoBundleStatus.mockResolvedValue({
      bundleId: 'bundle-r', status: 'Pending', transactions: [], slot: null
    });
    const runtime = makeRuntime(memoryStore(), () => new Date('2026-08-05T01:00:00Z'));
    const resolution = await runtime.reconcile(pending, 500);
    expect(resolution).toMatchObject({ status: 'ambiguous', reason: 'confirmation-timeout' });
  });
});

describe('sweep', () => {
  it('resolves and persists every observable pending bundle', async () => {
    const store = memoryStore();
    await store.save({
      clientOrderId: 'order-s',
      bundleId: 'bundle-s',
      lastValidBlockHeight: 1_000,
      expiresAt: new Date('2026-08-05T00:10:00Z')
    });
    mocks.getJitoBundleStatus.mockResolvedValue({
      bundleId: 'bundle-s', status: 'Landed', transactions: ['sig-s'], slot: 7
    });

    const resolutions = await makeRuntime(store).sweep(500);

    expect(resolutions).toHaveLength(1);
    expect(await store.findResolution('order-s')).toMatchObject({ status: 'filled' });
    expect(await store.listPending()).toHaveLength(0);
  });

  it('leaves an unobservable bundle pending for the next sweep', async () => {
    const store = memoryStore();
    await store.save({
      clientOrderId: 'order-u',
      bundleId: 'bundle-u',
      lastValidBlockHeight: 1_000,
      expiresAt: new Date('2026-08-05T00:10:00Z')
    });
    mocks.getJitoBundleStatus.mockResolvedValue(null);

    const resolutions = await makeRuntime(store).sweep(500);

    expect(resolutions).toHaveLength(0);
    expect(await store.listPending()).toHaveLength(1);
  });
});
