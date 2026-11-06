import { describe, expect, it } from 'vitest';
import * as solanaLatency from './solana-latency.js';
import { calculateSolanaLifecycleLatencies } from './solana-latency.js';
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
    // S4-M22. The module previously exported SOLANA_SIGNAL_TO_ALERT_TARGET_MS = 60_000
    // and a summariser that reported a measured median as `targetMet` against it.
    // ADR-0005 §8.1 retires that number: a minute from detection to alert is a defect
    // under single-master mirroring, so `targetMet: true` at 40 s was a false pass.
    // No replacement target exists until S4-M21 supplies observed percentiles. This
    // test is the tripwire: it fails if anyone re-adds a guessed target or a helper
    // that judges latency against one.
    it('exports measurement only, with no latency target to compare against', () => {
        expect(Object.keys(solanaLatency).sort()).toEqual(['calculateSolanaLifecycleLatencies']);
    });
});
//# sourceMappingURL=solana-latency.test.js.map