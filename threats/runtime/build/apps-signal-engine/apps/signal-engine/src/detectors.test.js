import { describe, expect, it, vi } from 'vitest';
import { SNIPE_DETECTOR_QUERY, ACCUMULATION_DETECTOR_QUERY, ROTATION_DETECTOR_QUERY, EXIT_DETECTOR_QUERY, scoreSnipePattern, scoreAccumulationPattern, scoreRotationPattern, scoreExitPattern, runSnipeDetector, runAccumulationDetector, runRotationDetector, runExitDetector } from './detectors.js';
describe('Cluster pattern detectors query and score isolation (S4-M26)', () => {
    describe('pure scoring logic', () => {
        it('scores snipe pattern correctly with confidence and ROI bonuses', () => {
            // base 82 + round(0.85 * 10) = 9 + min(5, round(1.2 * 2)) = 2 => 93
            expect(scoreSnipePattern({ cluster_confidence: 0.85, cluster_roi: 1.2 })).toBe(93);
            // caps at 99
            expect(scoreSnipePattern({ cluster_confidence: 1.0, cluster_roi: 10.0 })).toBe(97);
        });
        it('scores accumulation pattern correctly', () => {
            // base 75 + round(0.9 * 10) = 9 => 84
            expect(scoreAccumulationPattern({ cluster_confidence: 0.9 })).toBe(84);
            // caps at 99
            expect(scoreAccumulationPattern({ cluster_confidence: 3.0 })).toBe(99);
        });
        it('scores rotation pattern correctly', () => {
            // base 72 + round(0.8 * 10) = 8 + min(10, 3 * 2) = 6 => 86
            expect(scoreRotationPattern({ cluster_confidence: 0.8, actor_count: 3 })).toBe(86);
            // caps at 95
            expect(scoreRotationPattern({ cluster_confidence: 1.0, actor_count: 10 })).toBe(92);
        });
        it('scores exit pattern and computes seller percentage correctly', () => {
            // base 78 + round(0.7 * 10) = 7 => 85, sellerPct = round((4/5) * 100) = 80
            const res = scoreExitPattern({
                cluster_confidence: 0.7,
                seller_count: 4,
                cluster_size: 5
            });
            expect(res.signalScore).toBe(85);
            expect(res.sellerPct).toBe(80);
        });
    });
    describe('detector runners and query wiring', () => {
        it('runSnipeDetector queries and enqueues snipe signals with suppressTrade: true', async () => {
            const mockRows = [
                {
                    token_mint: 'solana:tokenA',
                    cluster_id: 'cluster-1',
                    buyer_count: 4,
                    cluster_confidence: 0.9,
                    cluster_roi: 0.5
                }
            ];
            const queryFn = vi.fn().mockResolvedValue(mockRows);
            const enqueueFn = vi.fn().mockResolvedValue(undefined);
            const processed = await runSnipeDetector(queryFn, enqueueFn);
            expect(processed).toBe(1);
            expect(queryFn).toHaveBeenCalledWith(SNIPE_DETECTOR_QUERY);
            expect(enqueueFn).toHaveBeenCalledWith({
                patternType: 'snipe',
                clusterId: 'cluster-1',
                tokenMint: 'solana:tokenA',
                confidence: 0.9,
                signalScore: scoreSnipePattern(mockRows[0]),
                suppressTrade: true,
                triggerData: { buyerCount: 4, window: '5m', clusterRoi: 0.5 }
            });
        });
        it('runAccumulationDetector queries and enqueues accumulation signals with 7d dedupe and suppressTrade', async () => {
            const mockRows = [
                {
                    token_mint: 'solana:tokenB',
                    cluster_id: 'cluster-2',
                    buy_volume: 75000,
                    buy_sessions: 4,
                    cluster_confidence: 0.85
                }
            ];
            const queryFn = vi.fn().mockResolvedValue(mockRows);
            const enqueueFn = vi.fn().mockResolvedValue(undefined);
            const processed = await runAccumulationDetector(queryFn, enqueueFn);
            expect(processed).toBe(1);
            expect(queryFn).toHaveBeenCalledWith(ACCUMULATION_DETECTOR_QUERY);
            expect(enqueueFn).toHaveBeenCalledWith({
                patternType: 'accumulation',
                clusterId: 'cluster-2',
                tokenMint: 'solana:tokenB',
                confidence: 0.85,
                signalScore: scoreAccumulationPattern(mockRows[0]),
                dedupeMinutes: 7 * 24 * 60,
                suppressTrade: true,
                triggerData: {
                    buyVolume: 75000,
                    buySessions: 4,
                    window: '7d'
                }
            });
        });
        it('runRotationDetector queries and enqueues rotation signals on bought token with suppressTrade', async () => {
            const mockRows = [
                {
                    token_out: 'solana:tokenOld',
                    token_in: 'solana:tokenNew',
                    cluster_id: 'cluster-3',
                    actor_count: 3,
                    cluster_confidence: 0.75
                }
            ];
            const queryFn = vi.fn().mockResolvedValue(mockRows);
            const enqueueFn = vi.fn().mockResolvedValue(undefined);
            const processed = await runRotationDetector(queryFn, enqueueFn);
            expect(processed).toBe(1);
            expect(queryFn).toHaveBeenCalledWith(ROTATION_DETECTOR_QUERY);
            expect(enqueueFn).toHaveBeenCalledWith({
                patternType: 'rotation',
                clusterId: 'cluster-3',
                tokenMint: 'solana:tokenNew',
                confidence: 0.75,
                signalScore: scoreRotationPattern(mockRows[0]),
                dedupeMinutes: 60,
                suppressTrade: true,
                triggerData: {
                    soldToken: 'solana:tokenOld',
                    boughtToken: 'solana:tokenNew',
                    actorCount: 3,
                    window: '1h'
                }
            });
        });
        it('runExitDetector queries and enqueues exit signals with sellerPct and suppressTrade', async () => {
            const mockRows = [
                {
                    token_mint: 'solana:tokenExit',
                    cluster_id: 'cluster-4',
                    seller_count: 6,
                    cluster_size: 10,
                    exit_volume: 25000,
                    cluster_confidence: 0.8
                }
            ];
            const queryFn = vi.fn().mockResolvedValue(mockRows);
            const enqueueFn = vi.fn().mockResolvedValue(undefined);
            const processed = await runExitDetector(queryFn, enqueueFn);
            expect(processed).toBe(1);
            expect(queryFn).toHaveBeenCalledWith(EXIT_DETECTOR_QUERY);
            expect(enqueueFn).toHaveBeenCalledWith({
                patternType: 'exit',
                clusterId: 'cluster-4',
                tokenMint: 'solana:tokenExit',
                confidence: 0.8,
                signalScore: 86,
                suppressTrade: true,
                dedupeMinutes: 60,
                triggerData: {
                    sellerCount: 6,
                    clusterSize: 10,
                    sellerPct: 60,
                    exitVolume: 25000,
                    window: '1h'
                }
            });
        });
    });
});
//# sourceMappingURL=detectors.test.js.map