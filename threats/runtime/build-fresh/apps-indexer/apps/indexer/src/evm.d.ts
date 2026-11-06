import { type PublicClient } from 'viem';
import { Queue } from 'bullmq';
import { type Chain } from '@swat/shared';
import { type IngestionBatchResult } from './ingestion-health.js';
export type WalletChain = Chain;
export type EvmBackfillDependencies = {
    client?: PublicClient;
    publish?: (channel: string, message: string) => Promise<unknown>;
};
export declare function backfillEvmWallet(address: string, chain: 'polygon' | 'robinhood-chain', dependencies?: EvmBackfillDependencies): Promise<IngestionBatchResult>;
/**
 * Discover and seed early & big buyers of an EVM ERC-20 token on Robinhood Chain or Polygon.
 */
export declare function discoverFromEvmToken(tokenAddress: string, chain: 'polygon' | 'robinhood-chain', dependencies?: EvmBackfillDependencies & {
    backfillQueue?: Queue;
}): Promise<{
    earlyBuyers: number;
    bigBuyers: number;
    scanned: number;
}>;
//# sourceMappingURL=evm.d.ts.map