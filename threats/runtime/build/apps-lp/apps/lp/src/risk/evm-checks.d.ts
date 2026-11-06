import { type TokenRiskCheck } from './types.js';
/**
 * Robinhood Chain (EVM) risk checks (Tracks C1–C4) over an injected viem
 * client. Holder concentration on EVM needs an off-chain holder list (no
 * on-chain enumeration), so it reports through an injected port and stays
 * silent when no explorer is configured — unknown must read as "no finding",
 * not as "clean", which the gate complements with the unassessed-pool rule.
 */
export interface EvmTokenPort {
    call<T>(method: string, params: unknown[]): Promise<T>;
    /** Best-effort contract call; resolves null when the call reverts or is missing. */
    tryCall(token: string, signature: 'owner()' | 'paused()' | 'totalSupply()' | 'balanceOf(address)', args?: readonly unknown[]): Promise<string | null>;
}
export interface EvmHolderListPort {
    /** Top-10 balances as base-unit numbers, or null when no explorer is configured. */
    top10Balances(token: string): Promise<readonly number[] | null>;
}
export interface EvmTotalSupplyPort {
    totalSupply(token: string): Promise<number | null>;
}
export interface EvmHoneypotPort {
    checkTokenSecurity(token: string): Promise<{
        isHoneypot: boolean;
        buyTax: number;
        sellTax: number;
        isOpenSource: boolean;
        cannotSellAll: boolean;
    } | null>;
}
export declare function evmHoneypotCheck(port: EvmHoneypotPort): TokenRiskCheck;
export declare function evmHolderConcentrationCheck(holders: EvmHolderListPort, supply: EvmTotalSupplyPort): TokenRiskCheck;
export declare function evmMintAuthorityCheck(port: EvmTokenPort): TokenRiskCheck;
export declare function evmLiquidityLockCheck(lpToken: string | null, port: EvmTokenPort): TokenRiskCheck;
//# sourceMappingURL=evm-checks.d.ts.map