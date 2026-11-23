import { performance } from 'node:perf_hooks';
import { Deadline } from './containment.js';

export interface LoadLifetimePlan {
  readonly secondRampMinutes: number;
  readonly drainMs: number;
}
export interface LoadPhaseLifetime {
  readonly signal: AbortSignal;
  check(): void;
  remaining(maximum?: number): number;
  enroll(cancel: () => void): () => void;
}
export interface IndependentLoadPorts<T> {
  run(lifetime: LoadPhaseLifetime): Promise<T>;
  drain(lifetime: LoadPhaseLifetime, result: T): Promise<T>;
  close(lifetime: LoadPhaseLifetime): Promise<void>;
}

export function loadLifetimeDurations(plan: LoadLifetimePlan) {
  if (!plan || !Number.isSafeInteger(plan.secondRampMinutes) || plan.secondRampMinutes < 2
    || plan.secondRampMinutes > 99 || !Number.isSafeInteger(plan.drainMs)
    || plan.drainMs < 1 || plan.drainMs > 240_000) throw new Error('Reviewed finite load and drain durations required');
  return Object.freeze({ loadMs: (25 + plan.secondRampMinutes) * 60_000, drainMs: plan.drainMs });
}

class IndependentLoadDeadline implements LoadPhaseLifetime {
  private readonly controller = new AbortController();
  private readonly until: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly owned = new Set<() => void>();

  constructor(duration: number) {
    this.until = performance.now() + duration;
    this.timer = setTimeout(() => this.abort(), duration);
  }

  get signal() { return this.controller.signal; }

  check() {
    if (this.signal.aborted || performance.now() >= this.until) {
      this.abort();
      throw new Error('Independent load phase exceeded its fixed lifetime');
    }
  }

  remaining(maximum = 30_000) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Finite load operation timeout required');
    this.check();
    return Math.max(1, Math.min(maximum, Math.floor(this.until - performance.now())));
  }

  enroll(cancel: () => void) {
    this.check();
    this.owned.add(cancel);
    return () => { this.owned.delete(cancel); };
  }

  abort() {
    if (this.signal.aborted) return;
    this.controller.abort(new Error('Independent load phase cancelled'));
    for (const cancel of this.owned) {
      try { cancel(); } catch { /* Other owned cancellations must still run. */ }
    }
  }

  dispose() { this.abort(); clearTimeout(this.timer); this.owned.clear(); }
}

/** I7 has its own reviewed finite lifetime; the ten-minute core deadline is never extended. */
export async function runIndependentLoad<T>(plan: LoadLifetimePlan, ports: IndependentLoadPorts<T>, cancellation?: AbortSignal) {
  const durations = loadLifetimeDurations(plan);
  if (!ports || !['run', 'drain', 'close'].every(name => typeof ports[name as keyof IndependentLoadPorts<T>] === 'function')) {
    throw new Error('Owned load, drain and cleanup capabilities required');
  }
  const pending = new Set<Promise<unknown>>();
  let active: IndependentLoadDeadline | undefined;
  let value: T | undefined;
  let failure: string | null = null;
  let loadComplete = false;
  let drainComplete = false;
  let cleanupComplete = false;
  const abort = () => active?.abort();
  cancellation?.addEventListener('abort', abort, { once: true });

  function bounded<V>(lifetime: LoadPhaseLifetime, action: () => Promise<V>) {
    lifetime.check();
    const work = Promise.resolve().then(() => { lifetime.check(); return action(); });
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return new Promise<V>((resolve, reject) => {
      const cancelled = () => reject(new Error('Owned load work cancelled'));
      lifetime.signal.addEventListener('abort', cancelled, { once: true });
      void work.then(result => { lifetime.signal.removeEventListener('abort', cancelled); resolve(result); },
        error => { lifetime.signal.removeEventListener('abort', cancelled); reject(error); });
      if (lifetime.signal.aborted) cancelled();
    });
  }

  const loadStarted = performance.now();
  try {
    active = new IndependentLoadDeadline(durations.loadMs + 5000);
    const traffic = new IndependentLoadDeadline(durations.loadMs);
    const stopTraffic = () => traffic.abort();
    cancellation?.addEventListener('abort', stopTraffic, { once: true });
    try {
      if (cancellation?.aborted) { active.abort(); traffic.abort(); }
      value = await bounded(active, () => ports.run(traffic));
      active.check();
      if (cancellation?.aborted || performance.now() - loadStarted < durations.loadMs) {
        throw new Error('Owned load stopped before the complete reviewed schedule');
      }
      loadComplete = true;
    } finally {
      cancellation?.removeEventListener('abort', stopTraffic);
      traffic.dispose();
    }
    active.dispose();
    active = new IndependentLoadDeadline(durations.drainMs);
    if (cancellation?.aborted) active.abort();
    value = await bounded(active, () => ports.drain(active!, value!));
    active.check(); drainComplete = true;
  } catch {
    failure = 'Owned load or durable drain failed; preserve private partial evidence';
  } finally {
    active?.dispose();
    cancellation?.removeEventListener('abort', abort);
    const shutdown = new Deadline(5000);
    try { await bounded(shutdown, () => ports.close(shutdown)); shutdown.check(); cleanupComplete = true; }
    catch { failure = 'Owned load cleanup failed; residual resources require explicit owner handoff'; }
    finally { shutdown.dispose(); }
  }
  const pendingWork = pending.size;
  const containmentComplete = cleanupComplete && pendingWork === 0;
  return { value: failure === null && containmentComplete ? value : undefined, failure, loadComplete, drainComplete,
    cleanupComplete, pendingWork, containmentComplete, durations,
    observationsComplete: failure === null && containmentComplete && loadComplete && drainComplete,
    runtimeAccepted: false as const, liveCapabilityAccepted: false as const, productionReady: false as const };
}
