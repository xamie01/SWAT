export declare function ingestWallets(input: Array<{
    address: string;
    source?: 'shiller' | 'manual' | 'discovered';
    nickname?: string;
}>): Promise<{
    accepted: number;
    rejected: number;
}>;
type HeliusTokenBalance = {
    owner?: string;
    mint: string;
    uiTokenAmount?: {
        amount?: string;
    };
};
type HeliusParsedTransaction = {
    slot?: number;
    blockTime?: number;
    transaction?: {
        signatures?: string[];
        message?: {
            instructions?: Array<{
                programId?: string;
            }>;
        };
    };
    meta?: {
        preTokenBalances?: HeliusTokenBalance[];
        postTokenBalances?: HeliusTokenBalance[];
    };
};
export declare function processTransaction(tx: HeliusParsedTransaction, address: string): Promise<'inserted' | 'skipped'>;
export {};
//# sourceMappingURL=index.d.ts.map