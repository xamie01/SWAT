type WalletInsert = {
    address: string;
    source: 'shiller' | 'manual' | 'discovered';
    nickname?: string;
    /** How the wallet was found, e.g. 'token-early' | 'token-big' (optional). */
    discoveryMethod?: string;
};
export declare function listWallets(): Promise<import("pg").QueryResultRow[]>;
export declare function getWallet(address: string): Promise<import("pg").QueryResultRow>;
export declare function upsertWallet(wallet: WalletInsert): Promise<import("pg").QueryResultRow>;
export declare function deleteWallet(address: string): Promise<void>;
/**
 * Delete a wallet and all rows that reference it. `deleteWallet` alone fails with
 * a foreign-key violation once the wallet has transactions / cluster memberships /
 * funding edges, so remove children first, inside a transaction.
 */
export declare function deleteWalletCascade(address: string): Promise<void>;
export declare function refreshWalletActivity(address: string, lastActive?: Date | null, tradeIncrement?: number): Promise<import("pg").QueryResultRow>;
export {};
//# sourceMappingURL=wallets.d.ts.map