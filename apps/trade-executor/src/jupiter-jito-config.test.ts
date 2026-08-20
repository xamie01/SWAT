import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  createJupiterJitoRuntimeFromEnvironment,
  getConfiguredJupiterJitoRuntime,
  getJupiterJitoLiveReadiness,
  resetJupiterJitoRuntimeForTests,
  setJupiterJitoUnavailable
} from './jupiter-jito-config.js';
import { createSolanaSigner } from './solana-signer.js';

function memoryRedis() {
  const store = new Map<string, Map<string, string>>();
  return {
    async hget(key: string, field: string) {
      return store.get(key)?.get(field) ?? null;
    },
    async hgetall(key: string) {
      return Object.fromEntries(store.get(key) ?? new Map());
    },
    async hset(key: string, field: string, value: string) {
      if (!store.has(key)) store.set(key, new Map());
      store.get(key)!.set(field, value);
      return 1;
    }
  };
}

const VALID_KEY = bs58.encode(Keypair.generate().secretKey);
const ENV_KEYS = [
  'SOLANA_PRIVATE_KEY',
  'SOLANA_RPC_URL',
  'HELIUS_API_KEY',
  'JITO_BLOCK_ENGINE_URL',
  'JITO_MAX_TIP_LAMPORTS',
  'JITO_TIP_PERCENTILE',
  'JITO_PENDING_TTL_MS'
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetJupiterJitoRuntimeForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetJupiterJitoRuntimeForTests();
});

describe('live readiness gate', () => {
  it('is not ready before configuration, with a stated reason', () => {
    // Fail-closed: resolveChainMode clamps Solana to paper on this, rather than
    // attempting a live trade it cannot sign.
    const readiness = getJupiterJitoLiveReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBeTruthy();
  });

  it('reports not-ready when no Solana key is configured', () => {
    process.env.JITO_BLOCK_ENGINE_URL = 'https://block-engine.test';
    expect(createJupiterJitoRuntimeFromEnvironment(memoryRedis())).toBe(null);
    const readiness = getJupiterJitoLiveReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toMatch(/SOLANA_PRIVATE_KEY|RPC/i);
  });

  it('reports not-ready when the block engine URL is absent, and never guesses one', () => {
    // A wrong block-engine URL fails every bundle at submit time. Guessing a
    // default turns a config omission into a runtime mystery.
    process.env.SOLANA_PRIVATE_KEY = VALID_KEY;
    process.env.SOLANA_RPC_URL = 'https://rpc.test';
    expect(createJupiterJitoRuntimeFromEnvironment(memoryRedis())).toBe(null);
    const readiness = getJupiterJitoLiveReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toMatch(/JITO_BLOCK_ENGINE_URL/);
  });

  it('becomes ready once both the key and endpoint are configured', () => {
    process.env.SOLANA_PRIVATE_KEY = VALID_KEY;
    process.env.SOLANA_RPC_URL = 'https://rpc.test';
    process.env.JITO_BLOCK_ENGINE_URL = 'https://block-engine.test';

    const created = createJupiterJitoRuntimeFromEnvironment(memoryRedis());
    expect(created).not.toBe(null);
    expect(getJupiterJitoLiveReadiness()).toEqual({ ready: true, reason: '' });
    expect(getConfiguredJupiterJitoRuntime()).not.toBe(null);
  });

  it('derives an RPC URL from the Helius key when none is given', () => {
    process.env.SOLANA_PRIVATE_KEY = VALID_KEY;
    process.env.HELIUS_API_KEY = 'helius-test-key';
    process.env.JITO_BLOCK_ENGINE_URL = 'https://block-engine.test';
    expect(createJupiterJitoRuntimeFromEnvironment(memoryRedis())).not.toBe(null);
    expect(getJupiterJitoLiveReadiness().ready).toBe(true);
  });

  it('can be forced unavailable, clearing the runtime', () => {
    process.env.SOLANA_PRIVATE_KEY = VALID_KEY;
    process.env.SOLANA_RPC_URL = 'https://rpc.test';
    process.env.JITO_BLOCK_ENGINE_URL = 'https://block-engine.test';
    createJupiterJitoRuntimeFromEnvironment(memoryRedis());
    expect(getJupiterJitoLiveReadiness().ready).toBe(true);

    setJupiterJitoUnavailable('ops clamp');

    expect(getJupiterJitoLiveReadiness()).toEqual({ ready: false, reason: 'ops clamp' });
    expect(getConfiguredJupiterJitoRuntime()).toBe(null);
  });
});

describe('environment validation', () => {
  beforeEach(() => {
    process.env.SOLANA_PRIVATE_KEY = VALID_KEY;
    process.env.SOLANA_RPC_URL = 'https://rpc.test';
    process.env.JITO_BLOCK_ENGINE_URL = 'https://block-engine.test';
  });

  it('rejects a non-integer tip cap rather than silently defaulting', () => {
    process.env.JITO_MAX_TIP_LAMPORTS = 'abc';
    expect(() => createJupiterJitoRuntimeFromEnvironment(memoryRedis())).toThrow(
      /JITO_MAX_TIP_LAMPORTS/
    );
  });

  it('rejects a zero tip cap', () => {
    // A zero cap would clamp every tip to the 1-lamport floor, so no bundle
    // would ever be built — indistinguishable from a dead executor.
    process.env.JITO_MAX_TIP_LAMPORTS = '0';
    expect(() => createJupiterJitoRuntimeFromEnvironment(memoryRedis())).toThrow(
      /JITO_MAX_TIP_LAMPORTS/
    );
  });

  it('rejects an unknown tip percentile', () => {
    process.env.JITO_TIP_PERCENTILE = 'p99';
    expect(() => createJupiterJitoRuntimeFromEnvironment(memoryRedis())).toThrow(
      /JITO_TIP_PERCENTILE/
    );
  });

  it('rejects a pending TTL below the runtime minimum', () => {
    process.env.JITO_PENDING_TTL_MS = '1000';
    expect(() => createJupiterJitoRuntimeFromEnvironment(memoryRedis())).toThrow(
      /pendingTtlMs/
    );
  });
});

describe('solana signer', () => {
  it('rejects a non-base58 key without echoing the material', () => {
    let message = '';
    try {
      createSolanaSigner({ privateKeyBase58: 'not-base58-!!!', rpcUrl: 'https://rpc.test' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/not valid base58/);
    expect(message).not.toContain('not-base58-!!!');
  });

  it('rejects a key of the wrong length', () => {
    const short = bs58.encode(Buffer.alloc(32, 7));
    expect(() => createSolanaSigner({ privateKeyBase58: short, rpcUrl: 'https://rpc.test' }))
      .toThrow(/64 bytes/);
  });

  it('exposes the public key but never the secret', () => {
    const keypair = Keypair.generate();
    const signer = createSolanaSigner({
      privateKeyBase58: bs58.encode(keypair.secretKey),
      rpcUrl: 'https://rpc.test'
    });
    expect(signer.publicKey).toBe(keypair.publicKey.toBase58());
    // The key is held in a closure; nothing on the returned object exposes it.
    expect(JSON.stringify(Object.keys(signer))).not.toMatch(/secret|private/i);
  });

  it('refuses a non-positive tip amount', async () => {
    const signer = createSolanaSigner({
      privateKeyBase58: VALID_KEY,
      rpcUrl: 'https://rpc.test'
    });
    // Rejected before any RPC call, so this needs no network.
    await expect(signer.buildTip({ tipAccount: 'x', lamports: 0 })).rejects.toThrow(/positive/);
    await expect(signer.buildTip({ tipAccount: 'x', lamports: 1.5 })).rejects.toThrow(/positive/);
  });
});
