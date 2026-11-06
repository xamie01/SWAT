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
/**
 * Calculate only latencies backed by recorded lifecycle timestamps. Missing or
 * backwards stamps remain null and are never converted into zero-duration data.
 */
export declare function calculateSolanaLifecycleLatencies(timestamps: SolanaLifecycleTimestamps): SolanaLifecycleLatencies;
//# sourceMappingURL=solana-latency.d.ts.map