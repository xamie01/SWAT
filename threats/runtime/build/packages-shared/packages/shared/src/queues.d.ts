import type { Chain } from './types.js';
export declare const WALLET_BACKFILL_JOB_NAME = "backfill-wallet";
export type WalletBackfillJobData = {
    address: string;
    chain: Chain;
};
export declare function createWalletBackfillJob(address: string, chain?: Chain): {
    name: string;
    data: {
        address: string;
        chain: Chain;
    };
    options: {
        jobId: string;
        removeOnComplete: boolean;
        removeOnFail: number;
    };
};
//# sourceMappingURL=queues.d.ts.map