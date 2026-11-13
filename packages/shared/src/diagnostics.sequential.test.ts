import { afterEach, expect, it, vi } from 'vitest';
import { executeWithRpcFailover, probeRpcEndpoint, probeRpcPool, resetEndpointRegistry } from './rpc-failover.js';
import { serializeLogArguments } from './logger.js';
const marker = 'SYNTHETIC_PRIVATE_MARKER';
afterEach(() => { vi.unstubAllGlobals(); resetEndpointRegistry(); });
it('does not serialize credentials nested in objects or provider URLs and messages', async () => {
  const output = serializeLogArguments([{ nested: { apiKey: marker, signature: marker }, url: `https://provider.invalid/${marker}?token=${marker}` }, new Error(`Authorization: Bearer ${marker}`)]);
  expect(output).not.toContain(marker);
  await expect(executeWithRpcFailover({ chain: 'solana', maxAttempts: 1, env: { SOLANA_RPC_URL: `https://provider.invalid/${marker}` }, action: async () => { throw new Error(marker); } })).rejects.not.toThrow(marker);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, statusText: marker })));
  expect(JSON.stringify(await probeRpcPool('solana', { SOLANA_RPC_URL: `https://provider.invalid/${marker}` }))).not.toContain(marker);
});
it.each([null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, '0xgarbage', '123oops'])('does not mark malformed block height %s as healthy', async result => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result }) })));
  expect((await probeRpcEndpoint('https://provider.invalid', 'solana')).healthy).toBe(false);
});
it('times out when headers arrive but body decoding stalls', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => new Promise(() => {}) })));
  expect((await probeRpcEndpoint('https://provider.invalid', 'solana', 10)).healthy).toBe(false);
});
it('reports valid integer slot and canonical hex height as healthy', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: 123 }) })));
  expect((await probeRpcEndpoint('https://provider.invalid', 'solana')).blockHeight).toBe(123);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ result: '0x7b' }) })));
  expect((await probeRpcEndpoint('https://provider.invalid', 'polygon')).blockHeight).toBe(123);
});
