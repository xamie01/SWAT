import { PublicKey, Keypair } from '@solana/web3.js';
import { z } from 'zod';
export { PublicKey, Keypair };
export const chainSchema = z.enum(['solana', 'polygon', 'robinhood-chain', 'base', 'ethereum', 'bsc']);
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
export const evmAddressSchema = z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid EVM wallet address');
export function isValidAddressForChain(address, chain) {
    if (chain === 'solana')
        return walletAddressSchema.safeParse(address).success;
    return evmAddressSchema.safeParse(address).success;
}
export const walletInputSchema = z.object({
    address: z.string(),
    chain: chainSchema.default('solana'),
    source: z.enum(['shiller', 'manual', 'discovered']).default('manual'),
    nickname: z.string().max(100).optional()
}).superRefine((value, ctx) => {
    if (!isValidAddressForChain(value.address, value.chain)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['address'],
            message: value.chain === 'solana' ? 'Invalid Solana wallet address' : 'Invalid EVM wallet address'
        });
    }
});
export function isValidSolanaAddress(address) {
    return walletAddressSchema.safeParse(address).success;
}
//# sourceMappingURL=validation.js.map