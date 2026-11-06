import { resolveChainAddress } from './address.js';
export const WALLET_BACKFILL_JOB_NAME = 'backfill-wallet';
export function createWalletBackfillJob(address, chain) {
    const resolved = resolveChainAddress(address, chain);
    return {
        name: WALLET_BACKFILL_JOB_NAME,
        data: {
            address: resolved.raw,
            chain: resolved.chain
        },
        options: {
            jobId: `backfill-${resolved.chain}-${resolved.raw}`,
            removeOnComplete: true,
            removeOnFail: 1000
        }
    };
}
//# sourceMappingURL=queues.js.map