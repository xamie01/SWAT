/**
 * Operator signing is unavailable until a trusted final-message verifier can
 * bind exact bytes (including resolved ALTs), recipients, debits, approvals,
 * cleanup, compute fees and tips to current execution authority. Simulation
 * success and Jupiter quote metadata are not such authorization.
 *
 * Keep the existing public seam for callers; do not load keys or construct a
 * signer while that verifier is absent. Injected test signers are opaque mocks.
 */
export const SOLANA_SIGNING_UNAVAILABLE = 'solana-final-message-authorization-unavailable';

export interface SolanaSignerOptions {
  readonly privateKeyBase58: string;
  readonly rpcUrl: string;
}

export interface SolanaSigner {
  readonly publicKey: string;
  sign(transactionBase64: string): Promise<string>;
  buildTip(input: { tipAccount: string; lamports: number }): Promise<string>;
  getBlockHeight(): Promise<number>;
}

export function createSolanaSigner(_options: SolanaSignerOptions): SolanaSigner {
  throw new Error(SOLANA_SIGNING_UNAVAILABLE);
}

export function createSolanaSignerFromEnvironment(): SolanaSigner | null {
  // Do not inspect credentials simply to decide an unavailable capability.
  return null;
}
