import type { Chain, ExecutionConfig, ExecutionMode } from '@swat/shared';
/** Retrieves the validated execution configuration with a maximum 30-second TTL. */
export declare function getExecutionConfig(): Promise<ExecutionConfig | null>;
export interface ChainModeResolution {
    requestedMode: ExecutionMode;
    effectiveMode: ExecutionMode;
    certified: boolean;
    reason?: string;
}
/**
 * Resolves a consistent mode snapshot for multiple chains. One call shares the
 * same DB configuration and certification snapshot without storing a
 * process-global "current chain".
 */
export declare function resolveChainModes<const Chains extends readonly Chain[]>(chains: Chains): Promise<Record<Chains[number], ChainModeResolution>>;
/** Resolves one chain using DB, chain env, legacy env, then paper precedence. */
export declare function resolveChainMode(chain: Chain): Promise<ChainModeResolution>;
/** Atomically changes one requested chain mode and invalidates this process's cache. */
export declare function setChainExecutionMode(chain: Chain, mode: ExecutionMode): Promise<void>;
/** Replaces all requested modes with the atomic, fail-closed global switch. */
export declare function activateAllChainEmergencyOff(): Promise<void>;
/** Resets the in-memory cache for tests and successful hot mutations. */
export declare function clearExecutionConfigCache(): void;
//# sourceMappingURL=execution-config.d.ts.map