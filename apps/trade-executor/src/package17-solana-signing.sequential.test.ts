import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// Tripwires are fully mocked: no real web3 key construction, signer, simulation or RPC.
const web3 = vi.hoisted(() => ({
  fromSecretKey: vi.fn(() => { throw new Error('key-construction-forbidden'); }),
  Connection: vi.fn(() => { throw new Error('rpc-construction-forbidden'); })
}));
vi.mock('@solana/web3.js', () => ({ Connection: web3.Connection, Keypair: { fromSecretKey: web3.fromSecretKey },
  PublicKey: vi.fn(), SystemProgram: {}, TransactionMessage: vi.fn(), VersionedTransaction: {} }));
vi.mock('bs58', () => ({ default: { decode: vi.fn(() => new Uint8Array(64)) } }));
vi.mock('@swat/shared', () => ({ getActiveRpcUrl: () => 'https://rpc.invalid' }));
import { createSolanaSignerFromEnvironment } from './solana-signer.js';

afterEach(() => vi.unstubAllEnvs());

it('keeps operator signer unavailable without inspecting or loading key material when final-byte verifier is absent', () => {
  vi.stubEnv('SOLANA_PRIVATE_KEY', 'opaque-not-a-key');
  expect(createSolanaSignerFromEnvironment()).toBeNull();
  expect(web3.fromSecretKey).not.toHaveBeenCalled();
  expect(web3.Connection).not.toHaveBeenCalled();
});
