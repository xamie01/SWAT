import type { Chain } from './types.js';
import { resolveChainAddress } from './address.js';

export const WALLET_BACKFILL_JOB_NAME = 'backfill-wallet';

export type WalletBackfillJobData = {
  address: string;
  chain: Chain;
};

export function createWalletBackfillJob(address: string, chain?: Chain) {
  const resolved = resolveChainAddress(address, chain);

  return {
    name: WALLET_BACKFILL_JOB_NAME,
    data: {
      address: resolved.raw,
      chain: resolved.chain
    } satisfies WalletBackfillJobData,
    options: {
      jobId: `backfill-${resolved.chain}-${resolved.raw}`,
      removeOnComplete: true,
      removeOnFail: 1000
    }
  };
}
