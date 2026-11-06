import { isValidAddressForChain } from './validation.js';
const CHAINS = ['solana', 'polygon', 'robinhood-chain', 'base', 'ethereum', 'bsc'];
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
export function isChain(value) {
    return typeof value === 'string' && CHAINS.includes(value);
}
export function getChainPrefix(value) {
    for (const chain of CHAINS) {
        if (value.startsWith(`${chain}:`))
            return chain;
    }
    return null;
}
export function normalizeChainValue(value, chain) {
    if (!value || value.trim() !== value) {
        throw new Error('Chain value must be non-empty and contain no surrounding whitespace');
    }
    if (value.includes(':')) {
        throw new Error(`Nested or unsupported chain prefix in ${value}`);
    }
    return chain === 'solana' ? value : value.toLowerCase();
}
export function resolveChainValue(value, requestedChain) {
    if (!value || value.trim() !== value) {
        throw new Error('Chain value must be non-empty and contain no surrounding whitespace');
    }
    const existingChain = getChainPrefix(value);
    let chain;
    let raw;
    if (existingChain) {
        if (requestedChain && requestedChain !== existingChain) {
            throw new Error(`Chain prefix ${existingChain} does not match requested chain ${requestedChain}`);
        }
        chain = existingChain;
        raw = value.slice(existingChain.length + 1);
    }
    else {
        if (value.includes(':')) {
            throw new Error(`Unsupported chain prefix in ${value}`);
        }
        if (!requestedChain && EVM_ADDRESS.test(value)) {
            throw new Error('Raw EVM values require an explicit chain');
        }
        chain = requestedChain ?? 'solana';
        raw = value;
    }
    const normalized = normalizeChainValue(raw, chain);
    if (chain === 'solana' && EVM_ADDRESS.test(normalized)) {
        throw new Error('EVM-shaped values cannot be classified as Solana');
    }
    return {
        chain,
        raw: normalized,
        prefixed: `${chain}:${normalized}`
    };
}
export function resolveChainAddress(value, requestedChain) {
    const resolved = resolveChainValue(value, requestedChain);
    if (!isValidAddressForChain(resolved.raw, resolved.chain)) {
        throw new Error(`Invalid ${resolved.chain} address`);
    }
    return resolved;
}
export function prefixChainValue(value, chain) {
    return resolveChainValue(value, chain).prefixed;
}
export function stripChainPrefix(value) {
    const chain = getChainPrefix(value);
    if (chain)
        return resolveChainValue(value, chain).raw;
    if (EVM_ADDRESS.test(value))
        return value.toLowerCase();
    return value;
}
//# sourceMappingURL=address.js.map