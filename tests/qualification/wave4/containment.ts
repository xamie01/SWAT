import { performance } from 'node:perf_hooks';

/** Cancellation authority is limited to handles enrolled by the current run. */
export class Deadline {
  private readonly controller = new AbortController();
  private readonly until: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly owned = new Set<() => void>();
  constructor(durationMs: number) {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 600_000) throw new Error('Invalid bounded deadline');
    this.until = performance.now() + durationMs;
    this.timer = setTimeout(() => this.abort(), durationMs);
  }
  get signal(): AbortSignal { return this.controller.signal; }
  remaining(maximum = 30_000): number {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Invalid operation timeout');
    this.check();
    return Math.max(1, Math.min(maximum, Math.floor(this.until - performance.now())));
  }
  check() {
    if (this.signal.aborted || performance.now() >= this.until) {
      this.abort();
      throw new Error('Owned qualification deadline exceeded');
    }
  }
  enroll(cancel: () => void): () => void {
    this.check();
    this.owned.add(cancel);
    return () => this.owned.delete(cancel);
  }
  abort() {
    if (this.signal.aborted) return;
    this.controller.abort(new Error('Owned qualification cancelled'));
    for (const cancel of this.owned) { try { cancel(); } catch { /* Cancellation of other owned handles must continue. */ } }
  }
  dispose() { this.abort(); clearTimeout(this.timer); this.owned.clear(); }
}

export function tmpfsBytes(options: string): number {
  const values = options.split(',').filter(option => /^size=/i.test(option));
  if (values.length !== 1) throw new Error('Exactly one finite tmpfs size required');
  const match = /^size=([1-9][0-9]*)([kmg]?)$/i.exec(values[0]!);
  if (!match) throw new Error('Invalid tmpfs size');
  const multiplier = ({ '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as Record<string, number>)[match[2]!.toLowerCase()]!;
  const size = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(size) || size < 4096 || size > 2 * 1024 ** 3) throw new Error('Tmpfs size outside qualification bounds');
  return size;
}
