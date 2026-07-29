import { describe, expect, it, vi } from 'vitest';
import {
  createRedisRobinhoodPendingStore,
  createRobinhoodSafetyAssessment
} from './robinhood-runtime.js';
import { evaluateRobinhoodSafety, type PendingRobinhoodSubmission } from './robinhood.js';
import { encodeRuntimeValue } from './runtime-codec.js';

function redisHash() {
  const values = new Map<string, Map<string, string>>();
  return {
    async hget(key: string, field: string) {
      return values.get(key)?.get(field) ?? null;
    },
    async hgetall(key: string) {
      return Object.fromEntries(values.get(key) ?? []);
    },
    async hset(key: string, field: string, value: string) {
      const hash = values.get(key) ?? new Map<string, string>();
      hash.set(field, value);
      values.set(key, hash);
      return 1;
    }
  };
}

const pending: PendingRobinhoodSubmission = {
  clientOrderId: 'signal-rh-1',
  stage: 'swap',
  hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  submittedAt: new Date('2026-07-26T10:00:00.000Z'),
  expiresAt: new Date('2026-07-26T10:10:00.000Z'),
  direction: 'buy',
  account: '0x1111111111111111111111111111111111111111',
  token: '0x2222222222222222222222222222222222222222',
  baseAsset: '0x3333333333333333333333333333333333333333',
  amountIn: '100000000000000000',
  quotedAmountOut: '5000',
  feeTier: 3000,
  slippageBps: 300
};

describe('Redis Robinhood pending store', () => {
  it('restores unresolved submissions and terminal receipt truth after a process restart', async () => {
    const redis = redisHash();
    const firstProcess = createRedisRobinhoodPendingStore(redis);
    await firstProcess.save(pending);

    const restartedProcess = createRedisRobinhoodPendingStore(redis);
    await expect(restartedProcess.findUnresolved('signal-rh-1')).resolves.toEqual(pending);

    await restartedProcess.resolve('signal-rh-1', {
      status: 'filled',
      clientOrderId: 'signal-rh-1',
      signature: pending.hash!,
      transactionHash: pending.hash!,
      amountEth: 0.1,
      actualAmountIn: 100000000000000000n,
      actualAmountOut: 4900n,
      quotedAmountOut: 5000n,
      feeTier: 3000,
      gasUsed: 100000n,
      latencyMs: 1200
    });

    await expect(firstProcess.findUnresolved('signal-rh-1')).resolves.toBeNull();
    await expect(firstProcess.findResolution('signal-rh-1')).resolves.toMatchObject({
      status: 'filled',
      actualAmountOut: 4900n
    });
  });

  it('decodes legacy v1 records with an unknown fee tier as null', async () => {
    const redis = redisHash();
    const key = 'test:pending:robinhood:v1';
    const legacyPending = {
      clientOrderId: pending.clientOrderId,
      stage: pending.stage,
      hash: pending.hash,
      submittedAt: pending.submittedAt,
      expiresAt: pending.expiresAt,
      direction: pending.direction,
      account: pending.account,
      token: pending.token,
      baseAsset: pending.baseAsset,
      amountIn: pending.amountIn,
      quotedAmountOut: pending.quotedAmountOut,
      slippageBps: pending.slippageBps
    };
    await redis.hset(key, pending.clientOrderId, encodeRuntimeValue({
      state: 'pending',
      pending: legacyPending
    }));
    await redis.hset(key, 'legacy-resolution', encodeRuntimeValue({
      state: 'resolved',
      resolution: {
        status: 'filled',
        clientOrderId: 'legacy-resolution',
        signature: pending.hash,
        transactionHash: pending.hash,
        amountEth: 0.1,
        actualAmountIn: 100000000000000000n,
        actualAmountOut: 4900n,
        quotedAmountOut: 5000n,
        gasUsed: 100000n,
        latencyMs: 1200
      }
    }));

    const store = createRedisRobinhoodPendingStore(redis, key);
    await expect(store.findUnresolved(pending.clientOrderId)).resolves.toEqual({
      ...pending,
      feeTier: null
    });
    await expect(store.listUnresolved()).resolves.toEqual([{ ...pending, feeTier: null }]);
    await expect(store.findResolution('legacy-resolution')).resolves.toMatchObject({
      status: 'filled',
      feeTier: null
    });
  });
});

describe('Robinhood runtime safety assessment', () => {
  it('uses a real reverse quote and fails closed when liquidity evidence is unavailable', async () => {
    const quote = vi.fn().mockResolvedValue(90n);
    const assess = createRobinhoodSafetyAssessment({
      quote,
      liquidityLookup: vi.fn().mockResolvedValue(null),
      readOwner: vi.fn().mockResolvedValue(null),
      minimumLiquidityUsd: 50_000
    });

    const assessment = await assess({
      order: {
        clientOrderId: 'signal-rh-2',
        token: pending.token,
        direction: 'buy',
        amountInBaseUnits: 100n,
        slippageBps: 300
      },
      route: { status: 'route', fee: 3000, amountOut: 100n },
      tokenIn: pending.baseAsset,
      tokenOut: pending.token
    });

    expect(quote).toHaveBeenCalledWith(pending.token, pending.baseAsset, 100n, 3000);
    expect(evaluateRobinhoodSafety(assessment)).toContain('liquidity did not pass reliably');
  });
});
