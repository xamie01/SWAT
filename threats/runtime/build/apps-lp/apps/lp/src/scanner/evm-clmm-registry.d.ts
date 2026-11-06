import type { LpChain, LpProtocol } from '@swat/shared';
export type EvmSupportedChain = Extract<LpChain, 'robinhood-chain' | 'base' | 'ethereum' | 'bsc'>;
export interface EvmClmmNetworkConfig {
    readonly chain: EvmSupportedChain;
    readonly defaultProtocol: LpProtocol;
    readonly defaultRpcEnvVar: string;
    readonly fallbackRpcUrl: string;
    readonly factoryAddress?: `0x${string}`;
    readonly positionManagerAddress?: `0x${string}`;
    readonly nativeQuoteToken: {
        readonly symbol: string;
        readonly address: string;
        readonly decimals: number;
    };
    readonly stableTokens: readonly string[];
}
export declare const EVM_CLMM_NETWORKS: Record<EvmSupportedChain, EvmClmmNetworkConfig>;
export declare function isEvmChain(chain: string): chain is EvmSupportedChain;
export declare function getEvmClmmNetwork(chain: EvmSupportedChain): EvmClmmNetworkConfig;
export declare function resolveEvmRpcUrl(chain: EvmSupportedChain): string;
//# sourceMappingURL=evm-clmm-registry.d.ts.map