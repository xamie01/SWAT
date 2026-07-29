import { describe, expect, it, vi } from 'vitest';
import { capBaseUnitSpend, fetchSolanaBalanceSol } from './balances.js';

const WALLET = '11111111111111111111111111111111';

describe('fetchSolanaBalanceSol', () => {
  it('reads a confirmed balance for the configured Trojan wallet', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      result: { value: 2_500_000_000 },
      id: 'swat-trade-balance'
    }), { status: 200 }));

    await expect(fetchSolanaBalanceSol({
      walletAddress: `solana:${WALLET}`,
      heliusApiKey: 'test-key',
      timeoutMs: 1_000,
      fetchFn
    })).resolves.toBe(2.5);

    const [url, request] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('api-key=test-key');
    expect(JSON.parse(String(request.body))).toMatchObject({
      method: 'getBalance',
      params: [WALLET, { commitment: 'confirmed' }]
    });
  });

  it('fails closed on missing credentials or malformed RPC balances', async () => {
    await expect(fetchSolanaBalanceSol({
      walletAddress: WALLET,
      heliusApiKey: '',
      timeoutMs: 1_000
    })).rejects.toThrow(/HELIUS_API_KEY/);

    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { value: -1 }
    }), { status: 200 }));
    await expect(fetchSolanaBalanceSol({
      walletAddress: WALLET,
      heliusApiKey: 'test-key',
      timeoutMs: 1_000,
      fetchFn
    })).rejects.toThrow(/invalid lamport balance/);
  });
});

describe('capBaseUnitSpend', () => {
  it('subtracts the reserve and never returns more than the remaining balance', () => {
    expect(capBaseUnitSpend(500n, 450n, 50n)).toBe(400n);
    expect(capBaseUnitSpend(100n, 450n, 50n)).toBe(100n);
    expect(capBaseUnitSpend(100n, 40n, 50n)).toBe(0n);
  });
});
