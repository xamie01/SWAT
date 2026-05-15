import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
export const walletAddressSchema = z
    .string()
    .min(32)
    .max(44)
    .refine((value) => {
    try {
        new PublicKey(value);
        return true;
    }
    catch {
        return false;
    }
}, 'Invalid Solana wallet address');
export const walletInputSchema = z.object({
    address: walletAddressSchema,
    source: z.enum(['shiller', 'manual', 'discovered']).default('manual'),
    nickname: z.string().max(100).optional()
});
export function isValidSolanaAddress(address) {
    return walletAddressSchema.safeParse(address).success;
}
//# sourceMappingURL=validation.js.map