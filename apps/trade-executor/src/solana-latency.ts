export const SOLANA_SIGNAL_TO_ALERT_TARGET_MS = 60_000;

export type SolanaLifecycleTimestamps = {
  eventAt: Date;
  detectedAt?: Date | null;
  alertedAt?: Date | null;
  submittedAt?: Date | null;
  confirmedAt?: Date | null;
};

export type SolanaLifecycleLatencies = {
  eventToSignalMs: number | null;
  signalToAlertMs: number | null;
  signalToSubmissionMs: number | null;
  signalToConfirmationMs: number | null;
};

function elapsedMilliseconds(start: Date | null | undefined, end: Date | null | undefined) {
  if (!start || !end) return null;
  const startMs = start.getTime();
  const endMs = end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}

/**
 * Calculate only latencies backed by recorded lifecycle timestamps. Missing or
 * backwards stamps remain null and are never converted into zero-duration data.
 */
export function calculateSolanaLifecycleLatencies(
  timestamps: SolanaLifecycleTimestamps
): SolanaLifecycleLatencies {
  return {
    eventToSignalMs: elapsedMilliseconds(timestamps.eventAt, timestamps.detectedAt),
    signalToAlertMs: elapsedMilliseconds(timestamps.detectedAt, timestamps.alertedAt),
    signalToSubmissionMs: elapsedMilliseconds(timestamps.detectedAt, timestamps.submittedAt),
    signalToConfirmationMs: elapsedMilliseconds(timestamps.detectedAt, timestamps.confirmedAt)
  };
}

export type SolanaSignalToAlertSummary = {
  sampleCount: number;
  medianMs: number | null;
  targetMs: number;
  targetMet: boolean | null;
};

export function summarizeSolanaSignalToAlertLatency(
  samples: SolanaLifecycleLatencies[]
): SolanaSignalToAlertSummary {
  const measured = samples
    .map((sample) => sample.signalToAlertMs)
    .filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (measured.length === 0) {
    return {
      sampleCount: 0,
      medianMs: null,
      targetMs: SOLANA_SIGNAL_TO_ALERT_TARGET_MS,
      targetMet: null
    };
  }

  const middle = Math.floor(measured.length / 2);
  const medianMs = measured.length % 2 === 0
    ? (measured[middle - 1]! + measured[middle]!) / 2
    : measured[middle]!;
  return {
    sampleCount: measured.length,
    medianMs,
    targetMs: SOLANA_SIGNAL_TO_ALERT_TARGET_MS,
    targetMet: medianMs < SOLANA_SIGNAL_TO_ALERT_TARGET_MS
  };
}
