import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  chainSchema,
  getChainPrefix,
  isValidAddressForChain,
  resolveChainValue,
  type Chain
} from '@swat/shared';

export type StarterPackWallet = {
  address: string;
  chain: Chain;
};

export function parseWalletChain(value: unknown): Chain {
  const parsed = chainSchema.safeParse(value ?? 'solana');
  if (!parsed.success) {
    throw new Error(
      `WALLET_CHAIN must be one of solana, polygon, or robinhood-chain; received ${JSON.stringify(value)}`
    );
  }
  return parsed.data;
}

export function parseStarterPackWallets(
  text: string,
  defaultChain: Chain
): StarterPackWallet[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Starter pack JSON is invalid: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!Array.isArray(raw)) {
    throw new Error('Starter pack JSON must be an array of wallet strings or wallet objects');
  }

  const wallets: StarterPackWallet[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const address =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && 'address' in entry
          ? (entry as { address?: unknown }).address
          : null;
    const entryChain =
      entry && typeof entry === 'object' && 'chain' in entry
        ? (entry as { chain?: unknown }).chain
        : undefined;

    if (typeof address !== 'string') {
      throw new Error(`Starter pack entry ${index} must contain a wallet address string`);
    }

    const chain = parseWalletChain(
      entryChain ?? getChainPrefix(address) ?? defaultChain
    );
    const resolved = resolveChainValue(address, chain);
    if (!isValidAddressForChain(resolved.raw, resolved.chain)) {
      throw new Error(
        `Starter pack entry ${index} is not a valid ${resolved.chain} address`
      );
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

export function resolveStarterPackPath(
  moduleUrl: string,
  configuredPath?: string
): string {
  const repositoryRoot = fileURLToPath(new URL('../../', moduleUrl));
  return path.resolve(
    repositoryRoot,
    configuredPath ?? 'wallet-starter-pack.json'
  );
}
