import { describe, expect, it, vi } from 'vitest';
import { assertion, qualify, result } from './core.js';
import { config } from './offline-fixture.js';

describe('qualification owned-lifetime control, injected promises only', () => {
  it('settles cooperative owned work after cancellation before complete containment', async () => {
    let finished = false;
    const close = vi.fn(async () => {});
    const report = await qualify(config(), {
      inspect: async (_c, deadline) => {
        const work = new Promise<void>(resolve => deadline.signal.addEventListener('abort', () => { finished = true; resolve(); }, { once: true }));
        deadline.abort();
        await work;
      }, execute: async gate => result(gate, [assertion('never', true)]), close
    });
    expect(finished).toBe(true); expect(close).toHaveBeenCalledOnce();
    expect(report).toMatchObject({ cleanupComplete: true, pendingWork: 0, containmentComplete: true, observedGatesComplete: false });
    expect(report.failure).not.toBeNull();
  });
  it('does not hang or claim settlement for an uncooperative inspection capability', async () => {
    let finish: () => void = () => {};
    const execute = vi.fn(), close = vi.fn(async () => {});
    const report = await qualify(config(), {
      inspect: (_c, deadline) => { const work = new Promise<void>(resolve => { finish = resolve; }); deadline.abort(); return work; },
      execute, close
    });
    expect(report).toMatchObject({ cleanupComplete: true, pendingWork: 1, containmentComplete: false, observedGatesComplete: false });
    expect(execute).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
    finish();
  });
  it('does not accept a late gate result after its lifetime was cancelled', async () => {
    let finish: (value: ReturnType<typeof result>) => void = () => {};
    const report = await qualify(config(), { inspect: async () => {},
      execute: (gate, _c, deadline) => {
        const work = new Promise<ReturnType<typeof result>>(resolve => { finish = resolve; }); deadline.abort(); return work;
      }, close: async () => {} });
    expect(report.results).toHaveLength(0); expect(report.pendingWork).toBe(1);
    finish(result('I1', [assertion('late-injected', true)]));
    await Promise.resolve();
    expect(report.results).toHaveLength(0);
    expect(report.containmentComplete).toBe(false);
  });
  it('does not hang or claim cleanup for an uncooperative shutdown capability', async () => {
    let finish: () => void = () => {};
    const report = await qualify(config(), { inspect: async () => {},
      execute: async gate => result(gate, [assertion('injected', true)]),
      close: deadline => { const work = new Promise<void>(resolve => { finish = resolve; }); deadline.abort(); return work; }
    });
    expect(report).toMatchObject({ cleanupComplete: false, containmentComplete: false, pendingWork: 1, observedGatesComplete: false });
    expect(report.failure).toBe('Owned client shutdown failed'); finish();
  });
});
