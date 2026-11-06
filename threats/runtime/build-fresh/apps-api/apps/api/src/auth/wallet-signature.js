import { randomBytes } from 'node:crypto';
import { verifyMessage } from 'viem';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
/** Nonce lifetime. Long enough for a hardware wallet, short enough to bound theft. */
export const NONCE_TTL_SECONDS = 300;
export function generateNonce() {
    return randomBytes(16).toString('hex');
}
/**
 * Builds the exact message the client must sign.
 *
 * The server generates this rather than accepting a client-supplied string:
 * verifying a message the caller wrote is verifying nothing, since they can put
 * any domain in it.
 */
export function buildSignInMessage(params) {
    const statement = params.statement ?? 'Sign in to SWAT. This request will not trigger a blockchain transaction.';
    if (params.chainKind === 'evm') {
        // EIP-4361 field order is normative — wallets render it, so it must not drift.
        return [
            `${params.domain} wants you to sign in with your Ethereum account:`,
            params.address,
            '',
            statement,
            '',
            `URI: ${params.uri}`,
            'Version: 1',
            `Nonce: ${params.nonce}`,
            `Issued At: ${params.issuedAt}`
        ].join('\n');
    }
    return [
        `${params.domain} wants you to sign in with your Solana account:`,
        params.address,
        '',
        statement,
        '',
        `URI: ${params.uri}`,
        'Version: 1',
        `Nonce: ${params.nonce}`,
        `Issued At: ${params.issuedAt}`
    ].join('\n');
}
function extractField(message, label) {
    const line = message.split('\n').find((candidate) => candidate.startsWith(`${label}: `));
    return line ? line.slice(label.length + 2).trim() : null;
}
/**
 * Normalises an address for comparison and storage.
 *
 * EVM is case-insensitive (EIP-55 checksums are presentational), so it is
 * lowercased. Solana base58 is case-*sensitive* and lowercasing it would produce
 * a different, invalid key — the same asymmetry `resolveChainAddress` encodes.
 */
export function normaliseAddress(chainKind, address) {
    return chainKind === 'evm' ? address.toLowerCase() : address;
}
export async function verifySignInSignature(input) {
    const nonce = extractField(input.message, 'Nonce');
    const uri = extractField(input.message, 'URI');
    if (!nonce || !uri)
        return { ok: false, reason: 'malformed-message' };
    // Bind the signed bytes to this server's challenge. Checking the nonce we were
    // *sent* rather than the one inside the *signed message* would let a caller
    // present a valid signature over someone else's challenge.
    if (nonce !== input.expectedNonce)
        return { ok: false, reason: 'nonce-mismatch' };
    if (uri !== input.expectedUri)
        return { ok: false, reason: 'uri-mismatch' };
    if (!input.message.startsWith(`${input.expectedDomain} wants you to sign in`)) {
        return { ok: false, reason: 'domain-mismatch' };
    }
    const claimed = normaliseAddress(input.chainKind, input.address);
    const inMessage = input.message.split('\n')[1]?.trim();
    if (!inMessage || normaliseAddress(input.chainKind, inMessage) !== claimed) {
        return { ok: false, reason: 'address-mismatch' };
    }
    if (input.chainKind === 'evm') {
        try {
            const valid = await verifyMessage({
                address: claimed,
                message: input.message,
                signature: input.signature
            });
            return valid ? { ok: true, address: claimed } : { ok: false, reason: 'bad-signature' };
        }
        catch {
            // Malformed signature or address: fail closed, never surface as a 500.
            return { ok: false, reason: 'bad-signature' };
        }
    }
    try {
        // For Solana the address *is* the ed25519 public key, so the signature is
        // checked directly against it — there is no recovery step as with secp256k1.
        const publicKey = bs58.decode(claimed);
        const signature = bs58.decode(input.signature);
        if (publicKey.length !== 32 || signature.length !== 64) {
            return { ok: false, reason: 'bad-signature' };
        }
        const valid = nacl.sign.detached.verify(new TextEncoder().encode(input.message), signature, publicKey);
        return valid ? { ok: true, address: claimed } : { ok: false, reason: 'bad-signature' };
    }
    catch {
        return { ok: false, reason: 'bad-signature' };
    }
}
//# sourceMappingURL=wallet-signature.js.map