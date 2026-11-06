import { ethers } from 'ethers';
export declare const POLYMARKET_CONTRACTS: Readonly<{
    ctfExchange: "0xE111180000d2663C0091e4f400237545B87B996B";
    negRiskCtfExchange: "0xe2222d279d744050d28e00520010520000310F59";
    conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
    pUsd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
    pUsdImplementation: "0x6bBCef9f7ef3B6C592c99e0f206a0DE94Ad0925f";
    collateralOnramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee";
    usdcE: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    proxyFactory: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052";
    proxyImplementation: "0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f";
    safeFactory: "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b";
    depositWalletFactory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07";
    depositWalletBeacon: "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a";
    depositWalletImplementation: "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB";
}>;
export interface PolymarketCollateralGateway {
    getPusdDecimals(): Promise<number>;
    getUsdcEDecimals(): Promise<number>;
    getPusdBalance(account: string): Promise<bigint>;
    getUsdcEBalance(account: string): Promise<bigint>;
    getUsdcEAllowance(account: string, spender: string): Promise<bigint>;
    approveUsdcE(spender: string, amount: bigint): Promise<string>;
    wrapUsdcE(to: string, amount: bigint): Promise<string>;
    getPusdAllowance(account: string, spender: string): Promise<bigint>;
    approvePusd(spender: string, amount: bigint): Promise<string>;
    isConditionalTokenApproved(account: string, operator: string): Promise<boolean>;
    approveConditionalTokenOperator(operator: string): Promise<string>;
}
export interface PolymarketCollateralReadinessOptions {
    funderAddress: string;
    signerAddress: string;
    accountWalletType: 'EOA' | 'POLY_PROXY' | 'POLY_GNOSIS_SAFE' | 'POLY_1271';
    directWalletWritesAllowed: boolean;
    minimumPusdUnits: bigint;
    allowanceCapUnits: bigint;
    autoOnramp: boolean;
    autoApprove: boolean;
}
export interface PolymarketCollateralReadiness {
    pUsdBalanceUnits: bigint;
    allowanceCapUnits: bigint;
    actions: Array<{
        type: string;
        transactionHash: string;
    }>;
}
export declare function ensurePolymarketCollateralReadiness(gateway: PolymarketCollateralGateway, options: PolymarketCollateralReadinessOptions): Promise<PolymarketCollateralReadiness>;
export declare class EthersPolymarketCollateralGateway implements PolymarketCollateralGateway {
    private readonly pUsdRead;
    private readonly usdcERead;
    private readonly conditionalTokensRead;
    private readonly pUsdWrite;
    private readonly usdcEWrite;
    private readonly conditionalTokensWrite;
    private readonly onrampWrite;
    constructor(provider: ethers.providers.Provider, signer: ethers.Signer | null);
    getPusdDecimals(): Promise<number>;
    getUsdcEDecimals(): Promise<number>;
    getPusdBalance(account: string): Promise<bigint>;
    getUsdcEBalance(account: string): Promise<bigint>;
    getUsdcEAllowance(account: string, spender: string): Promise<bigint>;
    approveUsdcE(spender: string, amount: bigint): Promise<string>;
    wrapUsdcE(to: string, amount: bigint): Promise<string>;
    getPusdAllowance(account: string, spender: string): Promise<bigint>;
    approvePusd(spender: string, amount: bigint): Promise<string>;
    isConditionalTokenApproved(account: string, operator: string): Promise<boolean>;
    approveConditionalTokenOperator(operator: string): Promise<string>;
}
//# sourceMappingURL=polymarket-collateral.d.ts.map