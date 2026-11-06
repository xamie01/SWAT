import { type PolymarketClientInitialization } from './polymarket.js';
import { type PolymarketCollateralGateway } from './polymarket-collateral.js';
interface PolymarketStartupDependencies {
    resolveMode: () => Promise<{
        effectiveMode: string;
        reason?: string | null;
    }>;
    getNetwork: () => Promise<{
        chainId: number;
    }>;
    getCode: (address: string) => Promise<string>;
    initializeClient: () => Promise<PolymarketClientInitialization>;
    createCollateralGateway: (directWalletWritesAllowed: boolean) => PolymarketCollateralGateway;
    getAuthenticatedCollateralBalance: () => Promise<number>;
    setLiveReadiness: (ready: boolean, reason?: string) => void;
    sdkProduction: unknown;
    clobHost: string;
    env: NodeJS.ProcessEnv;
}
export declare function parseBooleanEnvironment(value: string | undefined, name: string, fallback?: boolean): boolean;
export declare function parseUsdUnits(value: string | undefined, name: string, fallback: string): bigint;
export declare function parseFeeBufferBps(value: string | undefined): bigint;
export declare function assertOfficialPolymarketContractConfig(sdkEnvironment?: unknown, clobHost?: string): void;
export declare function assertPolymarketContractBytecode(name: string, address: string, code: string): void;
export declare function assertAuthenticatedCollateralBalance(authenticatedBalanceUsd: number, pUsdBalanceUnits: bigint, minimumPusdUnits: bigint): void;
export declare function verifyPolymarketEnvironment(overrides?: Partial<PolymarketStartupDependencies>): Promise<boolean>;
export {};
//# sourceMappingURL=polymarket-startup.d.ts.map