import type { LpChain } from '@swat/shared';
import { getLpPool } from '@swat/db';
import type { LivePoolContext } from './live-preview.js';
import type { MeteoraBinSource } from '../scanner/meteora-pools.js';
import type { EvmPoolReader } from '../scanner/evm-clmm-pools.js';
import { type EvmSupportedChain } from '../scanner/evm-clmm-registry.js';
export interface LiveContextSource {
    fetchLiveContext(chain: LpChain, poolAddress: string): Promise<LivePoolContext | null>;
}
export interface LiveContextSourceOptions {
    readonly solanaBinSource?: MeteoraBinSource;
    readonly evmReader?: EvmPoolReader;
    readonly evmReaders?: Partial<Record<EvmSupportedChain, EvmPoolReader>>;
    /** Scan-cache fallback; injectable for tests. Defaults to getLpPool. */
    readonly getPool?: typeof getLpPool;
}
export declare function createLiveContextSource(options: LiveContextSourceOptions): LiveContextSource;
//# sourceMappingURL=live-context.d.ts.map