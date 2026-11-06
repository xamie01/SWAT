import { Chain, ExecutionMode } from './types.js';
/**
 * Parses an execution mode securely.
 * Fails-closed: any unknown or invalid value returns 'paper'.
 * @param value The string to parse
 * @returns ExecutionMode ('off' | 'paper' | 'live' | 'live+shadow')
 */
export declare function parseExecutionMode(value: string | undefined | null): ExecutionMode;
/**
 * Maps a legacy TRADING_MODE value to an ExecutionMode for a specific chain.
 * Live execution is strictly clamped to 'paper' if the chain is not in the certified allowlist.
 */
export declare function mapLegacyTradingMode(legacyMode: string | undefined | null, chain: Chain, liveEnabledChains: Chain[]): ExecutionMode;
/**
 * Parses the LIVE_ENABLED_CHAINS environment variable.
 */
export declare function parseLiveEnabledChains(envValue: string | undefined | null): Chain[];
//# sourceMappingURL=execution.d.ts.map