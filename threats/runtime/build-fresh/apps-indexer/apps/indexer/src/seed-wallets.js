import { getChainPrefix, isValidAddressForChain, resolveChainValue } from '@swat/shared';
export function parseSeedWalletAddresses(value) {
    const wallets = [];
    const seen = new Set();
    for (const [index, entry] of (value ?? '').split(',').entries()) {
        const address = entry.trim();
        if (!address)
            continue;
        try {
            const prefixedChain = getChainPrefix(address);
            const resolved = resolveChainValue(address, prefixedChain ?? undefined);
            if (!isValidAddressForChain(resolved.raw, resolved.chain)) {
                throw new Error(`invalid ${resolved.chain} address`);
            }
            if (!seen.has(resolved.prefixed)) {
                seen.add(resolved.prefixed);
                wallets.push({
                    address: resolved.raw,
                    chain: resolved.chain,
                    source: 'manual'
                });
            }
        }
        catch (error) {
            throw new Error(`WALLET_ADDRESSES entry ${index} is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return wallets;
}
//# sourceMappingURL=seed-wallets.js.map