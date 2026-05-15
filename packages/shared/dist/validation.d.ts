import { z } from 'zod';
export declare const walletAddressSchema: z.ZodEffects<z.ZodString, string, string>;
export declare const walletInputSchema: z.ZodObject<{
    address: z.ZodEffects<z.ZodString, string, string>;
    source: z.ZodDefault<z.ZodEnum<["shiller", "manual", "discovered"]>>;
    nickname: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    address: string;
    source: "shiller" | "manual" | "discovered";
    nickname?: string | undefined;
}, {
    address: string;
    source?: "shiller" | "manual" | "discovered" | undefined;
    nickname?: string | undefined;
}>;
export type WalletInput = z.infer<typeof walletInputSchema>;
export declare function isValidSolanaAddress(address: string): boolean;
//# sourceMappingURL=validation.d.ts.map