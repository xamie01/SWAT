import { PublicKey } from '@solana/web3.js';

/** Matches programs/wake-vault/src/lib.rs; does not certify deployment. */
export function deriveWakeVaultAddress(ownerAddress: string): string {
  const owner = new PublicKey(ownerAddress);
  const program = new PublicKey('6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS');
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), owner.toBuffer()], program)[0].toBase58();
}
