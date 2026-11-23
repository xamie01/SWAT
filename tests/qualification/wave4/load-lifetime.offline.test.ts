import { describe, expect, it } from 'vitest';
import { loadLifetimeDurations, runIndependentLoad } from './load-lifetime.js';
import { Deadline } from './containment.js';

describe('independently bounded I7 load lifetime, injected capabilities only', () => {
  it('keeps the complete 27-minute default schedule separate from the ten-minute core', () => {
    expect(loadLifetimeDurations({ secondRampMinutes: 2, drainMs: 60_000 })).toEqual({ loadMs: 1_620_000, drainMs: 60_000 });
    expect(() => new Deadline(1_620_000)).toThrow('Invalid bounded deadline');
  });

  it('bounds the reviewed second ramp and accounting drain without extending either on progress', () => {
    expect(loadLifetimeDurations({ secondRampMinutes: 99, drainMs: 240_000 })).toEqual({ loadMs: 7_440_000, drainMs: 240_000 });
    for (const plan of [{ secondRampMinutes: 1, drainMs: 1 }, { secondRampMinutes: 100, drainMs: 1 },
      { secondRampMinutes: 2, drainMs: 0 }, { secondRampMinutes: 2, drainMs: 240_001 }]) {
      expect(() => loadLifetimeDurations(plan)).toThrow('Reviewed finite');
    }
  });

  it('refuses early callback completion as complete load and still closes owned resources', async () => {
    let closed = false;
    const report = await runIndependentLoad({ secondRampMinutes: 2, drainMs: 60_000 }, {
      run: async () => 'injected', drain: async () => { throw new Error('must not drain early'); },
      close: async () => { closed = true; }
    });
    expect(closed).toBe(true);
    expect(report).toMatchObject({ loadComplete: false, drainComplete: false, cleanupComplete: true,
      pendingWork: 0, containmentComplete: true, observationsComplete: false, runtimeAccepted: false,
      liveCapabilityAccepted: false, productionReady: false });
    expect(report.value).toBeUndefined();
    expect(report.failure).not.toBeNull();
  });

  it('refuses pre-cancelled input before admission and still performs cleanup', async () => {
    const cancel = new AbortController(); cancel.abort();
    let ran = false, closed = false;
    const report = await runIndependentLoad({ secondRampMinutes: 2, drainMs: 60_000 }, {
      run: async () => { ran = true; return true; }, drain: async () => true, close: async () => { closed = true; }
    }, cancel.signal);
    expect(ran).toBe(false); expect(closed).toBe(true);
    expect(report.observationsComplete).toBe(false);
  });

  it('reports unsettled work instead of claiming containment when an owned capability ignores cancellation', async () => {
    const cancel = new AbortController();
    let finish: (value: boolean) => void = () => {};
    const report = await runIndependentLoad({ secondRampMinutes: 2, drainMs: 60_000 }, {
      run: () => { const work = new Promise<boolean>(resolve => { finish = resolve; }); cancel.abort(); return work; },
      drain: async () => true, close: async () => {}
    }, cancel.signal);
    expect(report).toMatchObject({ pendingWork: 1, containmentComplete: false, observationsComplete: false });
    finish(true);
  });
});
