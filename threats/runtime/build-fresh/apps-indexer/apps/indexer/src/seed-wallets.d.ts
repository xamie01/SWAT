import { type Chain } from '@swat/shared';
export type SeedWallet = {
    address: string;
    chain: Chain;
    source: 'manual';
};
export declare function parseSeedWalletAddresses(value: string | undefined): SeedWallet[];
//# sourceMappingURL=seed-wallets.d.ts.map