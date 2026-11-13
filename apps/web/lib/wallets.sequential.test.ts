import { expect, it, vi } from 'vitest';
vi.mock('@solana/web3.js', () => ({ PublicKey: class { constructor() { throw new Error('Invalid public key'); } } }));
import { deriveSolanaAnchorPda, signRobinhoodDelegation } from './wallets.js';
it('PDA derivation failure never returns a program address as a funding destination', () => {
  expect(() => deriveSolanaAnchorPda('invalid')).toThrow();
});
it('unsupported delegation never prompts even a WalletConnect-only provider', async () => {
  const request = vi.fn();
  await expect(signRobinhoodDelegation({ request }, '0x' + '1'.repeat(40), {})).rejects.toThrow('unsupported');
  expect(request).not.toHaveBeenCalled();
});
