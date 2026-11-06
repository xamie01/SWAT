import { type Chain } from '@swat/shared';
export type StarterPackWallet = {
    address: string;
    chain: Chain;
};
export declare function parseWalletChain(value: unknown): Chain;
export declare function parseStarterPackWallets(text: string, defaultChain: Chain): StarterPackWallet[];
export declare function resolveStarterPackPath(moduleUrl: string, configuredPath?: string): string;
//# sourceMappingURL=starter-pack.d.ts.map