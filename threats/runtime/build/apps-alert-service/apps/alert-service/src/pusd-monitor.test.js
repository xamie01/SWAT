import { describe, expect, it, vi } from 'vitest';
import { checkPusdLiquidity, formatPusdOpsMessage } from './pusd-monitor.js';
describe('pUSD monitoring poller (S4-M42)', () => {
    const healthyInput = {
        depth: { nativeUsdcAvailable: 250_000 },
        aggregateFloatUsd: 100_000,
        depthFloorUsd: 50_000,
        collateralPaused: false,
        simulatedUnwrap: 'ok',
        swapOutputDifferenceBps: 2
    };
    const impairedInput = {
        depth: { nativeUsdcAvailable: 10_000 }, // below 50,000 floor
        aggregateFloatUsd: 100_000,
        depthFloorUsd: 50_000,
        collateralPaused: false,
        simulatedUnwrap: 'ok',
        swapOutputDifferenceBps: 2
    };
    it('formats an impaired verdict message with failures and detail', async () => {
        const verdict = await checkPusdLiquidity({
            loadInputs: async () => impairedInput,
            sendAlert: vi.fn()
        });
        expect(verdict).not.toBeNull();
        expect(verdict?.outcome).toBe('impaired');
        expect(verdict?.reasonCode).toBe('pusd-pool-depth-below-floor');
        const formatted = formatPusdOpsMessage(verdict);
        expect(formatted).toContain('SWAT PUSD WITHDRAWAL IMPAIRMENT ALERT');
        expect(formatted).toContain('Outcome:</b> IMPAIRED');
        expect(formatted).toContain('pusd-pool-depth-below-floor');
    });
    it('sends an alert when the outcome is impaired', async () => {
        const sendAlert = vi.fn().mockResolvedValue(undefined);
        const onVerdict = vi.fn().mockResolvedValue(undefined);
        const verdict = await checkPusdLiquidity({
            loadInputs: async () => impairedInput,
            sendAlert,
            onVerdict
        });
        expect(sendAlert).toHaveBeenCalledTimes(1);
        expect(sendAlert.mock.calls[0][0]).toContain('SWAT PUSD WITHDRAWAL IMPAIRMENT ALERT');
        expect(onVerdict).toHaveBeenCalledWith(verdict);
    });
    it('does not send an alert when the outcome is healthy', async () => {
        const sendAlert = vi.fn().mockResolvedValue(undefined);
        const onVerdict = vi.fn().mockResolvedValue(undefined);
        const verdict = await checkPusdLiquidity({
            loadInputs: async () => healthyInput,
            sendAlert,
            onVerdict
        });
        expect(verdict?.outcome).toBe('healthy');
        expect(sendAlert).not.toHaveBeenCalled();
        expect(onVerdict).toHaveBeenCalledWith(verdict);
    });
    it('handles loader errors gracefully and logs them', async () => {
        const logError = vi.fn();
        const sendAlert = vi.fn();
        const verdict = await checkPusdLiquidity({
            loadInputs: async () => {
                throw new Error('RPC endpoint unavailable');
            },
            sendAlert,
            logError
        });
        expect(verdict).toBeNull();
        expect(sendAlert).not.toHaveBeenCalled();
        expect(logError).toHaveBeenCalledWith('[alert-service] pUSD liquidity check failed', expect.any(Error));
    });
});
//# sourceMappingURL=pusd-monitor.test.js.map