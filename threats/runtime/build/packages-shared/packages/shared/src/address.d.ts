import type { Chain } from './types.js';
export type ResolvedChainValue = {
    chain: Chain;
    raw: string;
    prefixed: string;
};
export declare function isChain(value: unknown): value is Chain;
export declare function getChainPrefix(value: string): Chain | null;
export declare function normalizeChainValue(value: string, chain: Chain): string;
export declare function resolveChainValue(value: string, requestedChain?: Chain): ResolvedChainValue;
export declare function resolveChainAddress(value: string, requestedChain?: Chain): ResolvedChainValue;
export declare function prefixChainValue(value: string, chain: Chain): string;
export declare function stripChainPrefix(value: string): string;
//# sourceMappingURL=address.d.ts.map