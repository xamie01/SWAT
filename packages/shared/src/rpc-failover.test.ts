import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_FALLBACK_RPCS,
  executeWithRpcFailover,
  getActiveRpcUrl,
  getOrCreateEndpointState,
  prioritizeRpcEndpoints,
  recordRpcFailure,
  recordRpcSuccess,
  resetEndpointRegistry,
  resolveConfiguredRpcUrls
} from './rpc-failover.js';

describe('Resilient Multi-Provider RPC Failover', () => {
  beforeEach(() => {
    resetEndpointRegistry();
  });

  describe('resolveConfiguredRpcUrls', () => {
    it('returns default fallbacks when env is empty', () => {
      const urls = resolveConfiguredRpcUrls('solana', {});
      expect(urls).toEqual(DEFAULT_FALLBACK_RPCS.solana);
    });

    it('places singular SOLANA_RPC_URL first as primary', () => {
      const urls = resolveConfiguredRpcUrls('solana', {
        SOLANA_RPC_URL: 'https://helius.solana.example'
      });
      expect(urls[0]).toBe('https://helius.solana.example');
      expect(urls).toContain('https://api.mainnet-beta.solana.com');
    });

    it('splits comma-separated SOLANA_RPC_URLS and preserves primary order', () => {
      const urls = resolveConfiguredRpcUrls('solana', {
        SOLANA_RPC_URL: 'https://primary.example',
        SOLANA_RPC_URLS: 'https://backup1.example, https://backup2.example'
      });
      expect(urls[0]).toBe('https://primary.example');
      expect(urls[1]).toBe('https://backup1.example');
      expect(urls[2]).toBe('https://backup2.example');
      expect(urls).toContain('https://api.mainnet-beta.solana.com');
    });

    it('resolves polygon URLs correctly', () => {
      const urls = resolveConfiguredRpcUrls('polygon', {
        POLYGON_RPC_URL: 'https://alchemy.polygon.example'
      });
      expect(urls[0]).toBe('https://alchemy.polygon.example');
      expect(urls).toContain('https://polygon-bor-rpc.publicnode.com');
    });

    it('resolves robinhood URLs correctly with comma-separated fallbacks', () => {
      const urls = resolveConfiguredRpcUrls('robinhood', {
        ROBINHOOD_RPC_URL: 'https://rpc.mainnet.chain.robinhood.com',
        ROBINHOOD_RPC_URLS: 'https://orbit-fallback.robinhood.example'
      });
      expect(urls[0]).toBe('https://rpc.mainnet.chain.robinhood.com');
      expect(urls[1]).toBe('https://orbit-fallback.robinhood.example');
      expect(urls).toContain('https://rpc.mainnet.chain.robinhood.com');
    });
  });

  describe('prioritizeRpcEndpoints & circuit breaker', () => {
    const urls = ['https://rpc-a.example', 'https://rpc-b.example', 'https://rpc-c.example'];

    it('orders by lowest latency among healthy endpoints', () => {
      recordRpcSuccess('https://rpc-a.example', 150);
      recordRpcSuccess('https://rpc-b.example', 50);
      recordRpcSuccess('https://rpc-c.example', 80);

      const prioritized = prioritizeRpcEndpoints(urls);
      expect(prioritized).toEqual([
        'https://rpc-b.example',
        'https://rpc-c.example',
        'https://rpc-a.example'
      ]);
    });

    it('deprioritizes endpoints on failure with active cooldown', () => {
      const now = 100000;
      recordRpcFailure('https://rpc-a.example', new Error('HTTP 429 Too Many Requests'), now);

      const stateA = getOrCreateEndpointState('https://rpc-a.example');
      expect(stateA.consecutiveFailures).toBe(1);
      expect(stateA.cooldownUntil).toBeGreaterThan(now);

      const prioritized = prioritizeRpcEndpoints(urls, now);
      // rpc-a is in cooldown, so healthy rpc-b and rpc-c come first
      expect(prioritized[0]).not.toBe('https://rpc-a.example');
      expect(prioritized[2]).toBe('https://rpc-a.example');
    });

    it('recovers endpoint when cooldown expires', () => {
      const now = 100000;
      recordRpcFailure('https://rpc-a.example', new Error('timeout'), now);

      // Advance time beyond cooldown (15s = 15000ms)
      const future = now + 20000;
      const prioritized = prioritizeRpcEndpoints(urls, future);
      // It has recovered from coolingOff into recovering
      expect(prioritized).toContain('https://rpc-a.example');
    });

    it('clears failures on subsequent success', () => {
      recordRpcFailure('https://rpc-a.example', new Error('failed'));
      expect(getOrCreateEndpointState('https://rpc-a.example').consecutiveFailures).toBe(1);

      recordRpcSuccess('https://rpc-a.example', 45);
      const state = getOrCreateEndpointState('https://rpc-a.example');
      expect(state.consecutiveFailures).toBe(0);
      expect(state.cooldownUntil).toBe(0);
      expect(state.lastLatencyMs).toBe(45);
    });
  });

  describe('executeWithRpcFailover', () => {
    it('succeeds on first attempt if primary works', async () => {
      const env = {
        SOLANA_RPC_URLS: 'https://rpc-1.test,https://rpc-2.test'
      };

      const result = await executeWithRpcFailover({
        chain: 'solana',
        env,
        action: async (url) => {
          if (url === 'https://rpc-1.test') return 'success-from-rpc-1';
          throw new Error('should not reach here');
        }
      });

      expect(result).toBe('success-from-rpc-1');
      expect(getOrCreateEndpointState('https://rpc-1.test').consecutiveFailures).toBe(0);
    });

    it('transparently fails over to secondary when primary fails', async () => {
      const env = {
        SOLANA_RPC_URLS: 'https://failing-rpc.test,https://working-rpc.test'
      };

      const callLog: string[] = [];

      const result = await executeWithRpcFailover({
        chain: 'solana',
        env,
        action: async (url) => {
          callLog.push(url);
          if (url === 'https://failing-rpc.test') {
            throw new Error('503 Service Unavailable');
          }
          return `success-from-${url}`;
        }
      });

      expect(result).toBe('success-from-https://working-rpc.test');
      expect(callLog).toEqual(['https://failing-rpc.test', 'https://working-rpc.test']);
      expect(getOrCreateEndpointState('https://failing-rpc.test').consecutiveFailures).toBe(1);
      expect(getOrCreateEndpointState('https://working-rpc.test').consecutiveFailures).toBe(0);
    });

    it('throws aggregate error if all candidate endpoints fail', async () => {
      const env = {
        SOLANA_RPC_URL: 'https://fail-1.test',
        SOLANA_RPC_URLS: 'https://fail-2.test'
      };

      await expect(
        executeWithRpcFailover({
          chain: 'solana',
          env,
          maxAttempts: 2,
          action: async (url) => {
            throw new Error(`RPC down: ${url}`);
          }
        })
      ).rejects.toThrow(/All 2 RPC endpoint\(s\) failed for solana/);
    });
  });

  describe('getActiveRpcUrl', () => {
    it('returns healthy active endpoint', () => {
      const env = {
        POLYGON_RPC_URLS: 'https://poly-1.test,https://poly-2.test'
      };
      recordRpcFailure('https://poly-1.test', new Error('rate limited'));
      const active = getActiveRpcUrl('polygon', env);
      expect(active).toBe('https://poly-2.test');
    });
  });
});
