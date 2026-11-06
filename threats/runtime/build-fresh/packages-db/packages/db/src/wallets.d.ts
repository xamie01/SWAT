import type { Chain } from '@swat/shared';
export type WalletChain = Chain;
type WalletInsert = {
    address: string;
    chain?: WalletChain;
    source: 'shiller' | 'manual' | 'discovered';
    nickname?: string;
    /** How the wallet was found, e.g. 'token-early' | 'token-big' (optional). */
    discoveryMethod?: string;
};
export declare function listWallets(chain?: WalletChain): Promise<import("pg").QueryResultRow[]>;
export declare function getWallet(address: string, chain?: WalletChain): Promise<import("pg").QueryResultRow>;
export declare function upsertWallet(wallet: WalletInsert): Promise<import("pg").QueryResultRow>;
export declare function resolvePrefixedAddress(address: string, chain?: WalletChain): Promise<string>;
export declare function deleteWallet(address: string, chain?: WalletChain): Promise<void>;
/**
 * Delete a wallet and all rows that reference it. `deleteWallet` alone fails with
 * a foreign-key violation once the wallet has transactions / cluster memberships /
 * funding edges, so remove children first, inside a transaction.
 */
export declare function deleteWalletCascade(address: string, chain?: WalletChain): Promise<void>;
export declare function refreshWalletActivity(address: string, lastActive?: Date | null, tradeIncrement?: number): Promise<import("pg").QueryResultRow>;
export {};
//# sourceMappingURL=wallets.d.ts.map