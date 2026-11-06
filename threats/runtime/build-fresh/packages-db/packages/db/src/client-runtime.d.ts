import type { PoolConfig } from 'pg';
type Environment = Record<string, string | undefined>;
export type DatabaseRuntimeConfig = {
    pool: PoolConfig;
    shutdownTimeoutMs: number;
};
type PoolErrorSource = {
    on(event: 'error', listener: (error: Error) => void): unknown;
};
type ClosablePool = {
    end(): Promise<void>;
};
export type DatabaseShutdownProcess = {
    once(signal: NodeJS.Signals, listener: () => void): unknown;
    removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
    exit(code: number): void;
};
type ShutdownOptions = {
    close: () => Promise<void>;
    timeoutMs: number;
    processRef?: DatabaseShutdownProcess;
    logError?: (message: string, error: unknown) => void;
};
export declare function buildDatabaseRuntimeConfig(databaseUrl: string, env?: Environment): DatabaseRuntimeConfig;
export declare function attachPoolErrorHandler(source: PoolErrorSource, logError?: (message: string, error: unknown) => void): void;
export declare function createPoolCloser(pool: ClosablePool): () => Promise<void>;
export declare function installDatabaseShutdownHandlers({ close, timeoutMs, processRef, logError }: ShutdownOptions): () => void;
export {};
//# sourceMappingURL=client-runtime.d.ts.map