type WalletInsert = {
    address: string;
    source: 'shiller' | 'manual' | 'discovered';
    nickname?: string;
};
export declare function listWallets(): Promise<import("pg").QueryResultRow[]>;
export declare function getWallet(address: string): Promise<import("pg").QueryResultRow>;
export declare function upsertWallet(wallet: WalletInsert): Promise<import("pg").QueryResultRow>;
export declare function deleteWallet(address: string): Promise<void>;
export declare function refreshWalletActivity(address: string, lastActive?: Date | null, tradeIncrement?: number): Promise<import("pg").QueryResultRow>;
export {};
//# sourceMappingURL=wallets.d.ts.map