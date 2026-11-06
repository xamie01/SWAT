import { HOLDER_CONCENTRATION_FLAG, LIQUIDITY_UNLOCKED_FLAG, type TokenRiskCheck } from './types.js';
/**
 * Solana risk checks (Tracks C1–C4) over a raw JSON-RPC port, matching the
 * indexer's hand-rolled RPC pattern. The SPL mint-account layout parsing is a
 * pure function so the authority flags are testable without a chain.
 */
export interface SolanaRpcPort {
    /** One JSON-RPC call with parsed JSON result (the indexer's heliusRpc shape). */
    call<T>(method: string, params: unknown[]): Promise<T>;
}
/** Top-10 holders of a mint, with the mint's total supply. */
export interface HolderConcentrationSnapshot {
    /** Largest ten token accounts, base-unit amounts. */
    readonly top10Amounts: readonly number[];
    readonly supply: number;
}
export declare function fetchHolderConcentration(port: SolanaRpcPort, mint: string): Promise<HolderConcentrationSnapshot>;
/**
 * The finding rule for Track C1: the top-10 share of supply. Returns a finding
 * only above `flagThreshold` — a healthy distribution is not a flag.
 */
export declare function holderConcentrationFinding(snapshot: HolderConcentrationSnapshot, flagThreshold?: number): {
    flag: typeof HOLDER_CONCENTRATION_FLAG;
    detail: string;
    top10Share: number;
} | null;
export declare function holderConcentrationCheck(port: SolanaRpcPort): TokenRiskCheck;
/** The fields of an SPL mint account this module reasons about. */
export interface SplMintAuthorities {
    readonly mintAuthority: string | null;
    readonly freezeAuthority: string | null;
}
/**
 * Parses an SPL token mint account (82 bytes, base64-encoded by RPC):
 * 0..4 mint-authority COption, 4..36 authority pubkey, 36..44 supply, 44
 * decimals, 45 is-initialized, 46..50 freeze-authority COption, 50..82 freeze
 * pubkey.
 */
export declare function parseSplMintAuthorities(base64Data: string): SplMintAuthorities;
export declare function fetchSplMintAuthorities(port: SolanaRpcPort, mint: string): Promise<SplMintAuthorities>;
export declare function mintAuthorityFindings(authorities: SplMintAuthorities): {
    flag: string;
    detail: string;
}[];
export declare function mintAuthorityCheck(port: SolanaRpcPort): TokenRiskCheck;
export interface LiquidityLockSnapshot {
    /** LP token balances held by known lockers or the burn address, base units. */
    readonly lockedOrBurnedAmount: number;
    /** LP token balances held by ordinary movable wallets, base units. */
    readonly movableAmount: number;
}
export declare function liquidityLockFinding(snapshot: LiquidityLockSnapshot): {
    flag: typeof LIQUIDITY_UNLOCKED_FLAG;
    detail: string;
} | null;
export declare function liquidityLockCheck(port: SolanaRpcPort, 
/** Resolves the pool's classic LP mint, or null — DLMM pools have none (positions are NFTs). */
resolveLpMint?: (context: {
    readonly poolAddress: string;
}) => string | null): TokenRiskCheck;
//# sourceMappingURL=solana-checks.d.ts.map