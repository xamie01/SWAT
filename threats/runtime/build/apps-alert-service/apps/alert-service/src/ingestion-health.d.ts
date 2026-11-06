import { type Chain, type IngestionHealthSnapshot, type RawIngestionHealth } from '@swat/shared';
export type IngestionAlertTarget = 'healthy' | 'stale';
type MonitorDependencies = {
    loadHealth: () => Promise<RawIngestionHealth[]>;
    reserve: (chain: Chain, target: IngestionAlertTarget) => Promise<string | null>;
    complete: (chain: Chain, reservation: string, target: IngestionAlertTarget) => Promise<boolean>;
    release: (chain: Chain, reservation: string) => Promise<void>;
    send: (message: string) => Promise<void>;
    now?: () => Date;
    logError?: (message: string, error: unknown) => void;
};
export type IngestionMonitorResult = {
    chain: Chain;
    target: IngestionAlertTarget;
    action: 'none' | 'sent' | 'failed';
};
export declare function formatIngestionOpsMessage(health: IngestionHealthSnapshot, target: IngestionAlertTarget): string;
export declare function checkIngestionHealth(dependencies: MonitorDependencies): Promise<IngestionMonitorResult[]>;
export {};
//# sourceMappingURL=ingestion-health.d.ts.map