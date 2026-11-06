/**
 * Solana lifecycle latency measurement.
 *
 * **There is deliberately no signal→alert target in this file** (`S4-M22`).
 * A `SOLANA_SIGNAL_TO_ALERT_TARGET_MS = 60_000` constant used to live at the top
 * of this module, together with a `summarizeSolanaSignalToAlertLatency` helper
 * that reported a measured median as `targetMet` against it. ADR-0005 §8.1 and
 * `docs/PRD.md` §7.1 both retire that number: under single-master mirroring
 * ("when he buys, you buy") a full minute from detection to alert is not a
 * target that was met, it is a defect. Reporting `targetMet: true` at 40 s was
 * therefore worse than reporting nothing — it converted a failure into a pass.
 *
 * The number was not replaced with a smaller one because no observed
 * distribution exists to derive one from: detection is still on Helius
 * webhooks, which sit at Helius's highest-latency tier. A target may be
 * reintroduced **only** once `S4-M21` (the LaserStream detection-tier work)
 * has landed and produced real percentiles from the recorded lifecycle
 * timestamps. Do not re-add a guessed constant here in the meantime — a
 * plausible-looking number is what this module was just cured of.
 *
 * What remains is measurement with no judgement attached.
 */
function elapsedMilliseconds(start, end) {
    if (!start || !end)
        return null;
    const startMs = start.getTime();
    const endMs = end.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
        return null;
    return endMs - startMs;
}
/**
 * Calculate only latencies backed by recorded lifecycle timestamps. Missing or
 * backwards stamps remain null and are never converted into zero-duration data.
 */
export function calculateSolanaLifecycleLatencies(timestamps) {
    return {
        eventToSignalMs: elapsedMilliseconds(timestamps.eventAt, timestamps.detectedAt),
        signalToAlertMs: elapsedMilliseconds(timestamps.detectedAt, timestamps.alertedAt),
        signalToSubmissionMs: elapsedMilliseconds(timestamps.detectedAt, timestamps.submittedAt),
        signalToConfirmationMs: elapsedMilliseconds(timestamps.detectedAt, timestamps.confirmedAt)
    };
}
//# sourceMappingURL=solana-latency.js.map