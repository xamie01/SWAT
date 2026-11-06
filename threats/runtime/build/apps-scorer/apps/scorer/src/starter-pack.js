import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chainSchema, getChainPrefix, isValidAddressForChain, resolveChainValue } from '@swat/shared';
export function parseWalletChain(value) {
    const parsed = chainSchema.safeParse(value ?? 'solana');
    if (!parsed.success) {
        throw new Error(`WALLET_CHAIN must be one of solana, polygon, or robinhood-chain; received ${JSON.stringify(value)}`);
    }
    return parsed.data;
}
export function parseStarterPackWallets(text, defaultChain) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch (error) {
        throw new Error(`Starter pack JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!Array.isArray(raw)) {
        throw new Error('Starter pack JSON must be an array of wallet strings or wallet objects');
    }
    const wallets = [];
    const seen = new Set();
    for (const [index, entry] of raw.entries()) {
        const address = typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object' && 'address' in entry
                ? entry.address
                : null;
        const entryChain = entry && typeof entry === 'object' && 'chain' in entry
            ? entry.chain
            : undefined;
        if (typeof address !== 'string') {
            throw new Error(`Starter pack entry ${index} must contain a wallet address string`);
        }
        const chain = parseWalletChain(entryChain ?? getChainPrefix(address) ?? defaultChain);
        const resolved = resolveChainValue(address, chain);
        if (!isValidAddressForChain(resolved.raw, resolved.chain)) {
            throw new Error(`Starter pack entry ${index} is not a valid ${resolved.chain} address`);
        }
        if (!seen.has(resolved.prefixed)) {
            seen.add(resolved.prefixed);
            wallets.push({
                address: resolved.raw,
                chain: resolved.chain
            });
        }
    }
    return wallets;
}
export function resolveStarterPackPath(moduleUrl, configuredPath) {
    const repositoryRoot = fileURLToPath(new URL('../../', moduleUrl));
    return path.resolve(repositoryRoot, configuredPath ?? 'wallet-starter-pack.json');
}
//# sourceMappingURL=starter-pack.js.map