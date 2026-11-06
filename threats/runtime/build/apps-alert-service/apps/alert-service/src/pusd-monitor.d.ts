import { type PusdMonitorInput, type PusdMonitorVerdict } from '@swat/shared';
export interface PusdMonitorDependencies {
    readonly loadInputs: () => Promise<PusdMonitorInput>;
    readonly sendAlert: (message: string) => Promise<void>;
    readonly logError?: (message: string, error: unknown) => void;
    readonly onVerdict?: (verdict: PusdMonitorVerdict) => Promise<void>;
}
export declare function formatPusdOpsMessage(verdict: PusdMonitorVerdict): string;
/**
 * Polls and assesses pUSD withdrawal-pool liquidity and offramp health (`S4-M42`).
 *
 * Dispatches Telegram operational alerts when `outcome === 'impaired'`.
 */
export declare function checkPusdLiquidity(dependencies: PusdMonitorDependencies): Promise<PusdMonitorVerdict | null>;
//# sourceMappingURL=pusd-monitor.d.ts.map