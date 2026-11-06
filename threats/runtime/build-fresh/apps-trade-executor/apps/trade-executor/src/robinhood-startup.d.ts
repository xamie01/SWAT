import { resolveChainMode } from '@swat/db';
import type { PublicClient } from 'viem';
import { type RobinhoodReadiness } from './robinhood.js';
export type RobinhoodOpsAlert = {
    type: 'ROBINHOOD_LIVE_NOT_READY';
    chain: 'robinhood-chain';
    severity: 'critical';
    reason: string;
    checkedAt: string;
    requestedMode: 'live' | 'live+shadow';
};
export type RobinhoodOpsAlertEmitter = (alert: RobinhoodOpsAlert) => Promise<void>;
export declare function configureRobinhoodOpsAlertEmitter(emitter: RobinhoodOpsAlertEmitter): void;
export declare function getLastRobinhoodOpsAlert(): RobinhoodOpsAlert | null;
export declare function verifyRobinhoodEnvironment(options?: {
    client?: PublicClient;
    resolveMode?: typeof resolveChainMode;
    emitOpsAlert?: RobinhoodOpsAlertEmitter;
    runtimeCheck?: () => void | Promise<void>;
    values?: Record<string, string | undefined>;
}): Promise<RobinhoodReadiness>;
//# sourceMappingURL=robinhood-startup.d.ts.map