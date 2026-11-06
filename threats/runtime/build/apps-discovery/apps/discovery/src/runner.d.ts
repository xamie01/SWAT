import type { Chain } from '@swat/shared';
type DiscoveryMethod = 'funding' | 'counterparty';
type DiscoveredWalletInput = {
    address: string;
    source: 'discovered';
    discoveryMethod: DiscoveryMethod;
};
type StoredWallet = {
    address: string;
    chain: Chain;
};
type DiscoveryLogger = {
    info(message: string): void;
    error(message: string, error?: unknown): void;
};
export type DiscoveryRunnerDependencies = {
    findFundedUnknownWallets(): Promise<string[]>;
    findFrequentCounterparties(): Promise<string[]>;
    upsertWallet(wallet: DiscoveredWalletInput): Promise<StoredWallet>;
    enqueueBackfill(address: string, chain: Chain): Promise<void>;
    logDiscoveryRun(source: string, seedValue: string, walletsDiscovered: number): Promise<void>;
    logger?: DiscoveryLogger;
};
export declare function createDiscoveryRunner(dependencies: DiscoveryRunnerDependencies): {
    ingestDiscoveredWallets: (addresses: string[], source: DiscoveryMethod, seedValue: string) => Promise<number>;
    runFundingGraphExpansion: () => Promise<number>;
    runCounterpartyDiscovery: () => Promise<number>;
    runNightlyDiscoverySafe: () => Promise<"completed" | "skipped" | "failed">;
};
export {};
//# sourceMappingURL=runner.d.ts.map