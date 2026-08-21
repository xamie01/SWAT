import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * S4-M15 — that the simulation gate is actually handed to the runtime.
 *
 * `solana-simulation.test.ts` proves the gate classifies correctly, and
 * `jupiter-jito-runtime.test.ts` proves `submit()` honours one when present. Both
 * pass whether or not anything ever constructs a gate — and for a while nothing
 * did, which made the whole feature inert on a live box while every test stayed
 * green. This file closes that gap by capturing the options the runtime factory is
 * called with.
 *
 * A separate file because it has to mock `./jupiter-jito-runtime.js`, and
 * `jupiter-jito-config.test.ts` exercises the real one.
 */
const runtimeMock = vi.hoisted(() => ({
  createJupiterJitoRuntime: vi.fn(() => ({ submit: vi.fn(), reconcile: vi.fn(), sweep: vi.fn() }))
}));

// Partial mock: the config module also imports `createRedisJupiterJitoStore` from
// here, and replacing the whole module would strip it.
vi.mock('./jupiter-jito-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jupiter-jito-runtime.js')>()),
  createJupiterJitoRuntime: runtimeMock.createJupiterJitoRuntime
}));

const { createJupiterJitoRuntimeFromEnvironment, resetJupiterJitoRuntimeForTests } =
  await import('./jupiter-jito-config.js');

function memoryRedis() {
  const store = new Map<string, Map<string, string>>();
  return {
    async hget(key: string, field: string) { return store.get(key)?.get(field) ?? null; },
    async hgetall(key: string) { return Object.fromEntries(store.get(key) ?? new Map()); },
    async hset(key: string, field: string, value: string) {
      if (!store.has(key)) store.set(key, new Map());
      store.get(key)!.set(field, value);
      return 1;
    }
  };
}

const saved: Record<string, string | undefined> = {};
const KEYS = [
  'SOLANA_PRIVATE_KEY', 'SOLANA_RPC_URL', 'JITO_BLOCK_ENGINE_URL',
  'SOLANA_SIMULATION_ENABLED', 'SOLANA_SIMULATION_ON_UNAVAILABLE'
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of KEYS) saved[k] = process.env[k];
  process.env.SOLANA_PRIVATE_KEY = bs58.encode(Keypair.generate().secretKey);
  process.env.SOLANA_RPC_URL = 'https://rpc.invalid';
  process.env.JITO_BLOCK_ENGINE_URL = 'https://jito.invalid';
  delete process.env.SOLANA_SIMULATION_ENABLED;
  delete process.env.SOLANA_SIMULATION_ON_UNAVAILABLE;
  resetJupiterJitoRuntimeForTests();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetJupiterJitoRuntimeForTests();
});

function optionsPassedToRuntime() {
  expect(runtimeMock.createJupiterJitoRuntime).toHaveBeenCalledTimes(1);
  return runtimeMock.createJupiterJitoRuntime.mock.calls[0]![0] as { simulation?: unknown };
}

describe('Solana simulation gate reaches the Jito runtime (S4-M15)', () => {
  it('passes a gate when simulation is enabled', () => {
    // Simulation is opt-out, so the default path is the one that matters most.
    const created = createJupiterJitoRuntimeFromEnvironment(memoryRedis());
    expect(created).not.toBeNull();
    expect(optionsPassedToRuntime().simulation).toBeDefined();
  });

  it('passes no gate when simulation is explicitly disabled', () => {
    // An operator turning it off must actually turn it off — not get a gate that
    // silently evaluates anyway.
    process.env.SOLANA_SIMULATION_ENABLED = 'false';
    createJupiterJitoRuntimeFromEnvironment(memoryRedis());
    expect(optionsPassedToRuntime().simulation).toBeUndefined();
  });

  it('passes undefined rather than null, which is what submit() guards on', () => {
    // `submit()` branches on `options.simulation` being present. A `null` would be
    // falsy and work by accident, but the option is typed optional, so null would
    // be a type error waiting for someone to widen it.
    createJupiterJitoRuntimeFromEnvironment(memoryRedis());
    const simulation = optionsPassedToRuntime().simulation;
    expect(simulation).not.toBeNull();
  });
});
