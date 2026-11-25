import { describe, expect, it, vi } from 'vitest';
import { assertPipelineOriginalQuoteEncoding, assertPipelinePersistedExecutionFences,
  createPipelineLifetime, executedOriginalSnapshot, type ExecutedExecution,
  type ExecutedOriginalEvidence, type PipelineSqlRow } from './pipeline-economics.js';

/** Focused inert authoring only. No services, SQL, pool, credentials, network,
 * production settlement clone, or runtime/DB qualification acceptance. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function physical() {
  const query = vi.fn(), client = { query }, release = vi.fn<(broken: boolean) => void>();
  const acquire = vi.fn(async () => ({ client, release }));
  return { client, query, release, acquire };
}
async function lateAcquisition(h: ReturnType<typeof physical>) {
  const pending = deferred<{ client: typeof h.client; release: typeof h.release }>();
  const cancel = new AbortController(), lifetime = createPipelineLifetime(60_000, cancel.signal);
  const operation = lifetime.acquire(() => pending.promise), rejection = expect(operation).rejects.toThrow();
  await Promise.resolve(); await Promise.resolve(); cancel.abort(); await rejection;
  lifetime.dispose();
  pending.resolve({ client: h.client, release: h.release });
  // Drain the bounded acquisition and destruction microtasks, not a polling loop.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  return lifetime;
}
function original(overrides: Partial<ExecutedOriginalEvidence> = {}): ExecutedOriginalEvidence {
  return { id: 'inert-original', executionId: 'inert-execution', userId: 'inert-user', sourceTradeId: 'inert-source',
    evidenceType: 'paper_simulation', evidenceId: 'inert-evidence', base: '1', quote: '20.000000000000000001',
    nativeQuote: '20.000000000000000001', quoteCurrency: 'USD', nativePrice: '1.000000000000000000',
    price: '20.000000000000000001', fee: '0.000000000000000001', occurredAt: '2026-11-24T00:00:00.000Z',
    completes: true, confirmationState: 'confirmed', ...overrides };
}
function fences() {
  const execution: Pick<ExecutedExecution, 'id' | 'userId' | 'signalId' | 'targetAccount' | 'executionMode'> = {
    id: 'inert-execution', userId: 'inert-user', signalId: 'inert-signal', targetAccount: 'solana:inert-target', executionMode: 'paper' };
  const delivery: PipelineSqlRow = { execution_id: execution.id, user_id: execution.userId, signal_id: execution.signalId,
    target_account: execution.targetAccount, execution_mode: execution.executionMode, state: 'completed', fence: '11' };
  const attempt: PipelineSqlRow = { execution_id: execution.id, user_id: execution.userId, state: 'settled', fence: '7' };
  return { execution, delivery, attempt };
}

describe('FROZEN pipeline economics physical lifetime inert cases, not acceptance', () => {
  it('retains raw identity and refuses nested or duplicate enrollment without releasing its owner', async () => {
    const h = physical(), first = createPipelineLifetime(), second = createPipelineLifetime();
    try {
      const owned = await first.acquire(h.acquire);
      expect(owned.client).toBe(h.client);
      await expect(second.acquire(async () => owned)).rejects.toThrow('reuse');
      await expect(second.acquire(h.acquire)).rejects.toThrow('reuse');
      second.dispose(); expect(h.release).not.toHaveBeenCalled();
      owned.release(false); expect(h.release).toHaveBeenCalledExactlyOnceWith(false);
    } finally { first.dispose(); second.dispose(); }
  });
  it('permits healthy sequential reuse but an old release cannot destroy a new owner', async () => {
    const h = physical(), first = createPipelineLifetime(), second = createPipelineLifetime();
    try {
      const old = await first.acquire(h.acquire); old.release(false);
      const current = await second.acquire(h.acquire);
      old.release(true); first.dispose(); expect(h.release).toHaveBeenCalledExactlyOnceWith(false);
      expect(current.client).toBe(h.client); current.release(false);
      expect(h.release.mock.calls).toEqual([[false], [false]]);
    } finally { first.dispose(); second.dispose(); }
  });
  it('permanently quarantines successful destruction and rejects reissued broken objects', async () => {
    const h = physical(), first = createPipelineLifetime(), second = createPipelineLifetime();
    try {
      const owned = await first.acquire(h.acquire); owned.release(true);
      await expect(second.acquire(h.acquire)).rejects.toThrow('quarantined');
      owned.release(false); first.dispose(); second.dispose();
      expect(h.release).toHaveBeenCalledExactlyOnceWith(true); expect(h.query).not.toHaveBeenCalled();
    } finally { first.dispose(); second.dispose(); }
  });
  it('keeps failed destruction owned, retries on cleanup, and retains quarantine after success', async () => {
    const h = physical(), first = createPipelineLifetime(), second = createPipelineLifetime();
    h.release.mockImplementationOnce(() => { throw new Error('inert destruction failure'); });
    try {
      const owned = await first.acquire(h.acquire);
      expect(() => owned.release(true)).toThrow('destruction failure');
      await expect(second.acquire(h.acquire)).rejects.toThrow('reuse');
      expect(h.release).toHaveBeenCalledTimes(1);
      first.dispose(); expect(h.release.mock.calls).toEqual([[true], [true]]);
      await expect(second.acquire(h.acquire)).rejects.toThrow('quarantined');
      owned.release(false); first.dispose(); expect(h.release).toHaveBeenCalledTimes(2);
    } finally { first.dispose(); second.dispose(); }
  });
  it('does not acknowledge a failed healthy release or retry it as healthy', async () => {
    const h = physical(), first = createPipelineLifetime(), second = createPipelineLifetime();
    h.release.mockImplementationOnce(() => { throw new Error('inert return failure'); });
    try {
      const owned = await first.acquire(h.acquire);
      expect(() => owned.release(false)).toThrow('return failure');
      await expect(second.acquire(h.acquire)).rejects.toThrow('reuse');
      owned.release(false); expect(h.release.mock.calls).toEqual([[false], [true]]);
      await expect(second.acquire(h.acquire)).rejects.toThrow('quarantined');
    } finally { first.dispose(); second.dispose(); }
  });
  it('never frees identity or retries indefinitely when destruction always fails', async () => {
    const h = physical(), first = createPipelineLifetime(), second = createPipelineLifetime();
    h.release.mockImplementation(() => { throw new Error('inert permanent failure'); });
    try {
      const owned = await first.acquire(h.acquire);
      expect(() => owned.release(true)).toThrow('permanent failure');
      first.dispose(); first.dispose(); expect(() => owned.release(false)).toThrow('permanent failure');
      await expect(second.acquire(h.acquire)).rejects.toThrow('reuse');
      expect(h.release.mock.calls).toEqual([[true], [true]]);
    } finally { first.dispose(); second.dispose(); }
  });
  it('keeps ownership during synchronous destruction, including reentrant acquisition', async () => {
    const h = physical(), first = createPipelineLifetime(), second = createPipelineLifetime();
    let conflict: Promise<unknown> | undefined;
    h.release.mockImplementation(() => {
      conflict = second.acquire(h.acquire);
      // Immediate acquire schedules its factory while this owner is still held.
      // Factory sees the permanent quarantine after successful destruction too.
    });
    try {
      const owned = await first.acquire(h.acquire); owned.release(true);
      await expect(conflict).rejects.toThrow('reuse'); expect(h.release).toHaveBeenCalledTimes(1);
    } finally { first.dispose(); second.dispose(); }
  });
  it('destroys late acquisition after disposal and permanently rejects reissuance without queries', async () => {
    const h = physical(), second = createPipelineLifetime();
    try {
      await lateAcquisition(h);
      expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
      await expect(second.acquire(h.acquire)).rejects.toThrow('quarantined'); expect(h.query).not.toHaveBeenCalled();
    } finally { second.dispose(); }
  });
  it('retries late failed destruction once after disposal and preserves permanent quarantine', async () => {
    const h = physical(), second = createPipelineLifetime();
    h.release.mockImplementationOnce(() => { throw new Error('inert late destruction failure'); });
    try {
      const lifetime = await lateAcquisition(h); lifetime.dispose();
      expect(h.release.mock.calls).toEqual([[true], [true]]);
      await expect(second.acquire(h.acquire)).rejects.toThrow('quarantined'); expect(h.query).not.toHaveBeenCalled();
    } finally { second.dispose(); }
  });
  it('retains late failed destruction ownership and stops cleanup after two failures', async () => {
    const h = physical(), second = createPipelineLifetime();
    h.release.mockImplementation(() => { throw new Error('inert late permanent failure'); });
    try {
      const lifetime = await lateAcquisition(h); lifetime.dispose(); lifetime.dispose();
      await expect(second.acquire(h.acquire)).rejects.toThrow('reuse');
      expect(h.release.mock.calls).toEqual([[true], [true]]); expect(h.query).not.toHaveBeenCalled();
    } finally { second.dispose(); }
  });
  it('never destroys a late physical duplicate still owned by another lifetime', async () => {
    const h = physical(), owner = createPipelineLifetime();
    try {
      const owned = await owner.acquire(h.acquire); await lateAcquisition(h);
      expect(h.release).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
      owned.release(false); expect(h.release).toHaveBeenCalledExactlyOnceWith(false);
    } finally { owner.dispose(); }
  });
  it('never gives a late duplicate another cleanup attempt against a quarantined identity', async () => {
    const h = physical(), owner = createPipelineLifetime();
    try {
      const owned = await owner.acquire(h.acquire); owned.release(true);
      await lateAcquisition(h); expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
    } finally { owner.dispose(); }
  });
  it('refuses pre-aborted acquisition before invoking its factory', async () => {
    const h = physical(), cancel = new AbortController(); cancel.abort();
    const lifetime = createPipelineLifetime(25, cancel.signal);
    try { await expect(lifetime.acquire(h.acquire)).rejects.toThrow(); expect(h.acquire).not.toHaveBeenCalled(); }
    finally { lifetime.dispose(); }
  });
  it('bounds never-settled acquisition and ignores a late wait result without settlement', async () => {
    vi.useFakeTimers();
    const lifetime = createPipelineLifetime(25), pending = deferred<string>();
    try {
      const acquisition = lifetime.acquire(() => new Promise<never>(() => {}));
      const waiting = lifetime.wait(() => pending.promise);
      const acquiredRejection = expect(acquisition).rejects.toThrow(), waitRejection = expect(waiting).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(26); await acquiredRejection; await waitRejection;
      pending.resolve('inert late result'); await Promise.resolve();
      expect(() => lifetime.check()).toThrow();
    } finally { lifetime.dispose(); vi.useRealTimers(); }
  });
  it('bounds automatic abort destruction retry and never queries its owned client', async () => {
    const h = physical(), cancel = new AbortController(), lifetime = createPipelineLifetime(60_000, cancel.signal);
    h.release.mockImplementationOnce(() => { throw new Error('inert abort failure'); });
    try {
      await lifetime.acquire(h.acquire); cancel.abort();
      expect(h.release).toHaveBeenCalledExactlyOnceWith(true);
      lifetime.dispose(); lifetime.dispose(); expect(h.release.mock.calls).toEqual([[true], [true]]);
      expect(h.query).not.toHaveBeenCalled(); expect(() => lifetime.check()).toThrow();
    } finally { lifetime.dispose(); }
  });
});

describe('FROZEN pipeline economics exact immutable quote and independent fence cases, not acceptance', () => {
  it('accepts canonical USD amount/amount/USD/1 with different exact numeric scales', () => {
    const value = original({ quote: '9007199254740993.00000000000000001',
      nativeQuote: '9007199254740993.000000000000000010', nativePrice: '1.000' });
    expect(() => assertPipelineOriginalQuoteEncoding(value)).not.toThrow();
    expect(value.nativeQuote).toBe('9007199254740993.000000000000000010');
    expect(() => assertPipelineOriginalQuoteEncoding(original({ quote: '0.00', nativeQuote: '0', nativePrice: '1' }))).not.toThrow();
  });
  it.each([
    { nativeQuote: null }, { nativePrice: null }, { quoteCurrency: null }, { quoteCurrency: 'SOL' },
    { nativeQuote: '20.000000000000000002' }, { nativePrice: '1.000000000000000001' },
    { nativePrice: '0' }, { nativeQuote: '2e1' }, { quote: 20 }, { nativePrice: 1 },
  ])('rejects noncanonical USD original without coercion %j', patch => {
    expect(() => assertPipelineOriginalQuoteEncoding(original(patch as Partial<ExecutedOriginalEvidence>))).toThrow();
  });
  it('retains all four absent quote NULLs and does not fill unknown price or fee', () => {
    const value = Object.freeze(original({ quote: null, nativeQuote: null, quoteCurrency: null, nativePrice: null, price: null, fee: null }));
    expect(() => assertPipelineOriginalQuoteEncoding(value)).not.toThrow();
    const snapshot = executedOriginalSnapshot(value);
    expect([snapshot.quoteQuantity, snapshot.quoteNativeQuantity, snapshot.quoteCurrency, snapshot.quoteNativeUsdPrice,
      snapshot.priceUsd, snapshot.feeUsd]).toEqual([null, null, null, null, null, null]);
    expect([value.quote, value.nativeQuote, value.quoteCurrency, value.nativePrice, value.price, value.fee])
      .toEqual([null, null, null, null, null, null]);
  });
  it.each([{ nativeQuote: '0' }, { quoteCurrency: 'USD' }, { nativePrice: '1' }])
  ('rejects partially absent quote storage %j', patch => {
    expect(() => assertPipelineOriginalQuoteEncoding(original({ quote: null, nativeQuote: null, quoteCurrency: null,
      nativePrice: null, ...patch }))).toThrow('four NULLs');
  });
  it('accepts independent positive delivery and worker counters, including bigint bounds', () => {
    const f = fences(); expect(() => assertPipelinePersistedExecutionFences(f.execution, f.delivery, f.attempt)).not.toThrow();
    expect(f.delivery.fence).toBe('11'); expect(f.attempt.fence).toBe('7');
    expect(() => assertPipelinePersistedExecutionFences(f.execution, { ...f.delivery, fence: '9223372036854775807' },
      { ...f.attempt, fence: '9007199254740993' })).not.toThrow();
    expect(() => assertPipelinePersistedExecutionFences(f.execution, { ...f.delivery, fence: '7' }, f.attempt)).not.toThrow();
  });
  it.each([null, undefined, 7, '0', '-1', '01', '1.0', '1e1', ' 7', '9223372036854775808', '10000000000000000000'])
  ('rejects malformed or out-of-bounds persisted fence %s independently', fence => {
    const f = fences();
    expect(() => assertPipelinePersistedExecutionFences(f.execution, { ...f.delivery, fence }, f.attempt)).toThrow('delivery fence');
    expect(() => assertPipelinePersistedExecutionFences(f.execution, f.delivery, { ...f.attempt, fence })).toThrow('worker fence');
  });
  it.each(['execution_id', 'user_id', 'signal_id', 'target_account', 'execution_mode', 'state'])
  ('rejects a foreign persisted delivery %s despite a positive fence', key => {
    const f = fences();
    expect(() => assertPipelinePersistedExecutionFences(f.execution, { ...f.delivery, [key]: 'foreign' }, f.attempt)).toThrow('identity');
  });
  it.each(['execution_id', 'user_id', 'state'])('rejects a foreign persisted worker %s despite a positive fence', key => {
    const f = fences();
    expect(() => assertPipelinePersistedExecutionFences(f.execution, f.delivery, { ...f.attempt, [key]: 'foreign' })).toThrow('owner');
  });
  it('rejects missing execution owner or signal rather than matching missing identities', () => {
    const f = fences();
    expect(() => assertPipelinePersistedExecutionFences({ ...f.execution, userId: null },
      { ...f.delivery, user_id: null }, { ...f.attempt, user_id: null })).toThrow('identity');
    expect(() => assertPipelinePersistedExecutionFences({ ...f.execution, signalId: null },
      { ...f.delivery, signal_id: null }, f.attempt)).toThrow('identity');
  });
});
