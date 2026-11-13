import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveApiBase, resolveLpApiBase } from '../../apps/web/lib/api.js';
import { executeWithRpcFailover, probeRpcEndpoint } from '../../packages/shared/src/rpc-failover.js';
import { serializeLogArguments } from '../../packages/shared/src/logger.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('Synthetic sensitive-data boundaries', () => {
  it('LEAK-02: production SSR must not select a remote plaintext API fallback', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTERNAL_API_URL', undefined);
    vi.stubEnv('BACKEND_API_INTERNAL_URL', undefined);
    expect(resolveApiBase(null, undefined).startsWith('http://')).toBe(false);
  });
  it('LEAK-02: production SSR must not select a remote plaintext LP fallback', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INTERNAL_LP_URL', undefined);
    vi.stubEnv('BACKEND_LP_INTERNAL_URL', undefined);
    expect(resolveLpApiBase(null, undefined).startsWith('http://')).toBe(false);
  });
  it('LEAK-03: RPC failure and log serialization must omit a synthetic credential marker', async () => {
    const marker = 'SYNTHETIC_CONFIDENTIAL_MARKER';
    let caught: unknown;
    try {
      await executeWithRpcFailover({
        chain: 'solana', maxAttempts: 1,
        env: { SOLANA_RPC_URL: `https://provider.invalid/${marker}` },
        action: async () => { throw new Error('fixture transport failure'); }
      });
    } catch (error) { caught = error; }
    expect(serializeLogArguments([caught])).not.toContain(marker);
  });
  it('health: a JSON-RPC error-shaped empty result must not be treated as healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: null }) }));
    const result = await probeRpcEndpoint('https://provider.invalid', 'solana');
    expect(result.healthy).toBe(false);
  });
});
