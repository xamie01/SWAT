import { PublicKey, Keypair } from '@solana/web3.js';
import { z } from 'zod';
export { PublicKey, Keypair };
export declare const chainSchema: z.ZodEnum<["solana", "polygon", "robinhood-chain", "base", "ethereum", "bsc"]>;
export declare const walletAddressSchema: z.ZodEffects<z.ZodString, string, string>;
export declare const evmAddressSchema: z.ZodString;
export declare function isValidAddressForChain(address: string, chain: z.infer<typeof chainSchema>): boolean;
export declare const walletInputSchema: z.ZodEffects<z.ZodObject<{
    address: z.ZodString;
    chain: z.ZodDefault<z.ZodEnum<["solana", "polygon", "robinhood-chain", "base", "ethereum", "bsc"]>>;
    source: z.ZodDefault<z.ZodEnum<["shiller", "manual", "discovered"]>>;
    nickname: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    address: string;
    chain: "solana" | "polygon" | "robinhood-chain" | "base" | "ethereum" | "bsc";
    source: "shiller" | "manual" | "discovered";
    nickname?: string | undefined;
}, {
    address: string;
    chain?: "solana" | "polygon" | "robinhood-chain" | "base" | "ethereum" | "bsc" | undefined;
    source?: "shiller" | "manual" | "discovered" | undefined;
    nickname?: string | undefined;
}>, {
    address: string;
    chain: "solana" | "polygon" | "robinhood-chain" | "base" | "ethereum" | "bsc";
    source: "shiller" | "manual" | "discovered";
    nickname?: string | undefined;
}, {
    address: string;
    chain?: "solana" | "polygon" | "robinhood-chain" | "base" | "ethereum" | "bsc" | undefined;
    source?: "shiller" | "manual" | "discovered" | undefined;
    nickname?: string | undefined;
}>;
export type WalletInput = z.infer<typeof walletInputSchema>;
export declare function isValidSolanaAddress(address: string): boolean;
//# sourceMappingURL=validation.d.ts.map