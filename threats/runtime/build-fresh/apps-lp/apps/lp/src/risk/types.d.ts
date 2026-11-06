import type { LpChain } from '@swat/shared';
/**
 * Token/wallet risk filter shapes (Track C).
 *
 * Every check returns *findings*, not a score: the score combiner (score.ts)
 * is the only place weights live, so a new check never needs the other checks
 * touched, and the flag codes are the same strings persisted to
 * `lp_pools.risk_flags`.
 */
export interface TokenRiskFinding {
    /** Stable machine code, persisted to `lp_pools.risk_flags`. */
    readonly flag: string;
    /** Human-readable evidence for the detail view. */
    readonly detail: string;
}
export interface TokenRiskContext {
    readonly chain: LpChain;
    /** Chain-prefixed base token of the pool being assessed. */
    readonly baseTokenMint: string;
    /** Chain-prefixed quote token. */
    readonly quoteTokenMint: string;
    /** Chain-prefixed pool address. */
    readonly poolAddress: string;
}
/** One async risk check: chain reads in, findings out. Never throws to the caller. */
export type TokenRiskCheck = (context: TokenRiskContext) => Promise<readonly TokenRiskFinding[]>;
export declare const HOLDER_CONCENTRATION_FLAG = "holder_concentration";
export declare const BUNDLED_WALLETS_FLAG = "bundled_launch";
export declare const LIQUIDITY_UNLOCKED_FLAG = "liquidity_unlocked";
export declare const MINT_AUTHORITY_FLAG = "mint_authority_active";
export declare const FREEZE_AUTHORITY_FLAG = "freeze_authority_active";
export declare const PAUSE_CAPABLE_FLAG = "pause_capable";
export declare const BLACKLIST_CAPABLE_FLAG = "blacklist_capable";
export declare const HONEYPOT_DETECTED_FLAG = "honeypot_detected";
export declare const EXCESSIVE_TAX_FLAG = "excessive_tax";
export declare const UNVERIFIED_SOURCE_FLAG = "unverified_contract";
//# sourceMappingURL=types.d.ts.map