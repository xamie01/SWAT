import { describe, expect, it } from 'vitest';
import {
  calculateSolanaLifecycleLatencies,
  summarizeSolanaSignalToAlertLatency
} from './solana-latency.js';

describe('Solana lifecycle latency primitives', () => {
  it('keeps observation, detection, alert, submission, and confirmation distinct', () => {
    expect(calculateSolanaLifecycleLatencies({
      eventAt: new Date('2026-07-26T10:00:00.000Z'),
      detectedAt: new Date('2026-07-26T10:00:08.000Z'),
      alertedAt: new Date('2026-07-26T10:00:30.000Z'),
      submittedAt: new Date('2026-07-26T10:00:35.000Z'),
      confirmedAt: new Date('2026-07-26T10:00:41.000Z')
    })).toEqual({
      eventToSignalMs: 8_000,
      signalToAlertMs: 22_000,
      signalToSubmissionMs: 27_000,
      signalToConfirmationMs: 33_000
    });
  });

  it('does not fabricate zero latency for missing or backwards timestamps', () => {
    expect(calculateSolanaLifecycleLatencies({
      eventAt: new Date('2026-07-26T10:00:10.000Z'),
      detectedAt: new Date('2026-07-26T10:00:09.000Z')
    })).toEqual({
      eventToSignalMs: null,
      signalToAlertMs: null,
      signalToSubmissionMs: null,
      signalToConfirmationMs: null
    });
  });

  it('reports the measured median against the strict sub-60-second target', () => {
    const samples = [20_000, 40_000, 70_000].map((signalToAlertMs) => ({
      eventToSignalMs: null,
      signalToAlertMs,
      signalToSubmissionMs: null,
      signalToConfirmationMs: null
    }));

    expect(summarizeSolanaSignalToAlertLatency(samples)).toEqual({
      sampleCount: 3,
      medianMs: 40_000,
      targetMs: 60_000,
      targetMet: true
    });
  });

  it('leaves target status unknown when there is no measured sample', () => {
    expect(summarizeSolanaSignalToAlertLatency([])).toEqual({
      sampleCount: 0,
      medianMs: null,
      targetMs: 60_000,
      targetMet: null
    });
  });
});
