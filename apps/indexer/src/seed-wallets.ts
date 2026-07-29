import {
  getChainPrefix,
  isValidAddressForChain,
  resolveChainValue,
  type Chain
} from '@swat/shared';

export type SeedWallet = {
  address: string;
  chain: Chain;
  source: 'manual';
};

export function parseSeedWalletAddresses(value: string | undefined): SeedWallet[] {
  const wallets: SeedWallet[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of (value ?? '').split(',').entries()) {
    const address = entry.trim();
    if (!address) continue;

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
    } catch (error) {
      throw new Error(
        `WALLET_ADDRESSES entry ${index} is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return wallets;
}
