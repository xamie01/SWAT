import { BUNDLED_WALLETS_FLAG, type TokenRiskCheck } from './types.js';
/**
 * Bundled/connected-wallet volume detector (Track C2).
 *
 * The pure core is the finding rule: wallets funded from one common source
 * inside the detection window around launch are a bundle. The port in front of
 * it is deliberately dumb — gathering the funding graph is chain-specific and
 * best-effort (Solana: transfer signatures around launch; EVM: explorer API) —
 * because the heuristic itself is what needs testing.
 */
export interface FundingEdge {
    /** The wallet that received the launch allocation. */
    readonly wallet: string;
    /** The wallet that funded it. */
    readonly fundedFrom: string;
    /** When the funding transfer happened. */
    readonly fundedAt: Date;
}
export interface BundledWalletsFinding {
    readonly flag: typeof BUNDLED_WALLETS_FLAG;
    readonly detail: string;
    /** The funding sources that look like a bundle. */
    readonly sources: readonly string[];
    readonly walletCount: number;
}
export declare function detectBundledWallets(edges: readonly FundingEdge[], options?: {
    windowMs?: number;
    minBundleWallets?: number;
}): BundledWalletsFinding | null;
export interface FundingGraphPort {
    /** Funding edges for wallets that received the token around launch. */
    fundingEdges(baseTokenMint: string): Promise<readonly FundingEdge[]>;
}
/** The Track C check: gathers edges through the port, applies the pure rule. */
export declare function bundledWalletsCheck(port: FundingGraphPort): TokenRiskCheck;
//# sourceMappingURL=bundled-wallets.d.ts.map