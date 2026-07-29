import type { Chain } from './types.js';
import { isValidAddressForChain } from './validation.js';

const CHAINS: readonly Chain[] = ['solana', 'polygon', 'robinhood-chain'];
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export type ResolvedChainValue = {
  chain: Chain;
  raw: string;
  prefixed: string;
};

export function isChain(value: unknown): value is Chain {
  return typeof value === 'string' && CHAINS.includes(value as Chain);
}

export function getChainPrefix(value: string): Chain | null {
  for (const chain of CHAINS) {
    if (value.startsWith(`${chain}:`)) return chain;
  }
  return null;
}

export function normalizeChainValue(value: string, chain: Chain): string {
  if (!value || value.trim() !== value) {
    throw new Error('Chain value must be non-empty and contain no surrounding whitespace');
  }
  if (value.includes(':')) {
    throw new Error(`Nested or unsupported chain prefix in ${value}`);
  }
  return chain === 'solana' ? value : value.toLowerCase();
}

export function resolveChainValue(value: string, requestedChain?: Chain): ResolvedChainValue {
  if (!value || value.trim() !== value) {
    throw new Error('Chain value must be non-empty and contain no surrounding whitespace');
  }

  const existingChain = getChainPrefix(value);
  let chain: Chain;
  let raw: string;

  if (existingChain) {
    if (requestedChain && requestedChain !== existingChain) {
      throw new Error(
        `Chain prefix ${existingChain} does not match requested chain ${requestedChain}`
      );
    }
    chain = existingChain;
    raw = value.slice(existingChain.length + 1);
  } else {
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

export function resolveChainAddress(value: string, requestedChain?: Chain): ResolvedChainValue {
  const resolved = resolveChainValue(value, requestedChain);
  if (!isValidAddressForChain(resolved.raw, resolved.chain)) {
    throw new Error(`Invalid ${resolved.chain} address`);
  }
  return resolved;
}

export function prefixChainValue(value: string, chain: Chain): string {
  return resolveChainValue(value, chain).prefixed;
}

export function stripChainPrefix(value: string): string {
  const chain = getChainPrefix(value);
  if (chain) return resolveChainValue(value, chain).raw;
  if (EVM_ADDRESS.test(value)) return value.toLowerCase();
  return value;
}
