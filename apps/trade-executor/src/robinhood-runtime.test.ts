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

describe('Robinhood asset-provenance and transfer-tax checks', () => {
  const context = {
    order: {
      clientOrderId: 'signal-rh-checks',
      token: pending.token,
      direction: 'buy' as const,
      amountInBaseUnits: 100n,
      slippageBps: 300
    },
    route: { status: 'route' as const, fee: 3000, amountOut: 100n },
    tokenIn: pending.baseAsset,
    tokenOut: pending.token
  };

  function assessWith(options: Record<string, unknown>) {
    return createRobinhoodSafetyAssessment({
      quote: vi.fn().mockResolvedValue(90n),
      liquidityLookup: vi.fn().mockResolvedValue(1_000_000),
      minimumLiquidityUsd: 50_000,
      ...options
    })(context);
  }

  function check(assessment: Awaited<ReturnType<ReturnType<typeof createRobinhoodSafetyAssessment>>>, name: string) {
    return assessment.checks.find((candidate) => candidate.name === name);
  }

  it('declares provenance checks unreliable when no provider is configured', async () => {
    // The honest default. Guessing either way on unverified source or unknown
    // holder distribution would be worse than saying the evidence is absent.
    const assessment = await assessWith({});

    expect(check(assessment, 'source_verification')).toMatchObject({ status: 'unknown', reliable: false });
    expect(check(assessment, 'holder_concentration')).toMatchObject({ status: 'unknown', reliable: false });
    expect(check(assessment, 'fee_on_transfer')).toMatchObject({ status: 'unknown', reliable: false });
    // Unreliable is not failing: only sell_simulation and liquidity are required.
    expect(evaluateRobinhoodSafety(assessment)).toEqual([]);
  });

  it('rejects an unverified contract once a provider is wired', async () => {
    const assessment = await assessWith({ verifySource: vi.fn().mockResolvedValue(false) });

    expect(check(assessment, 'source_verification')).toMatchObject({ status: 'fail', reliable: true });
    expect(evaluateRobinhoodSafety(assessment)).toContain('source_verification: contract source is unverified');
  });

  it('passes a verified contract', async () => {
    const assessment = await assessWith({ verifySource: vi.fn().mockResolvedValue(true) });

    expect(check(assessment, 'source_verification')).toMatchObject({ status: 'pass', reliable: true });
    expect(evaluateRobinhoodSafety(assessment)).toEqual([]);
  });

  it('rejects supply concentrated in one holder and accepts a spread book', async () => {
    const concentrated = await assessWith({ readHolderConcentration: vi.fn().mockResolvedValue(0.81) });
    expect(check(concentrated, 'holder_concentration')).toMatchObject({ status: 'fail', reliable: true });
    expect(evaluateRobinhoodSafety(concentrated)[0]).toContain('81.00% of supply');

    const spread = await assessWith({ readHolderConcentration: vi.fn().mockResolvedValue(0.12) });
    expect(check(spread, 'holder_concentration')).toMatchObject({ status: 'pass', reliable: true });
  });

  it('treats an out-of-range or failing provider as no evidence, not as a pass', async () => {
    const nonsense = await assessWith({ readHolderConcentration: vi.fn().mockResolvedValue(4.2) });
    expect(check(nonsense, 'holder_concentration')).toMatchObject({ status: 'unknown', reliable: false });

    const broken = await assessWith({
      verifySource: vi.fn().mockRejectedValue(new Error('explorer 502'))
    });
    expect(check(broken, 'source_verification')).toMatchObject({ status: 'unknown', reliable: false });
    expect(check(broken, 'source_verification')?.evidence).toBe('explorer 502');
  });

  it('refuses any transfer tax by default', async () => {
    // Uniswap V3 credits the pool less than it was sent for a taxed token, so
    // there is no safe amount of tax — the default tolerance is zero.
    const taxed = await assessWith({ probeFeeOnTransfer: vi.fn().mockResolvedValue(50) });

    expect(check(taxed, 'fee_on_transfer')).toMatchObject({ status: 'fail', reliable: true });
    expect(evaluateRobinhoodSafety(taxed)[0]).toContain('Uniswap V3 cannot route fee-on-transfer tokens');

    const untaxed = await assessWith({ probeFeeOnTransfer: vi.fn().mockResolvedValue(0) });
    expect(check(untaxed, 'fee_on_transfer')).toMatchObject({ status: 'pass', reliable: true });
  });

  it('honours an explicit transfer-tax tolerance', async () => {
    const assessment = await assessWith({
      probeFeeOnTransfer: vi.fn().mockResolvedValue(25),
      maxTransferFeeBps: 30
    });

    expect(check(assessment, 'fee_on_transfer')).toMatchObject({ status: 'pass', reliable: true });
  });

  it('probes the traded token on an EXIT, not the base asset (S3-11)', async () => {
    // The exit is where a transfer tax actually strands a position: V3's
    // exactInputSingle credits the pool less than it was sent, so a taxed token
    // that was somehow entered cannot be sold through this router at all.
    //
    // On a sell the route reverses — tokenIn is the traded token and tokenOut is
    // the base asset. The probe must follow `order.token`, not `tokenIn`/
    // `tokenOut`, or a sell would probe the untaxed base asset, pass, and strand
    // the position on submission.
    const probeFeeOnTransfer = vi.fn().mockResolvedValue(50);
    const sellContext = {
      order: {
        clientOrderId: 'signal-rh-exit',
        token: pending.token,
        direction: 'sell' as const,
        amountInBaseUnits: 100n,
        slippageBps: 300
      },
      route: { status: 'route' as const, fee: 3000, amountOut: 100n },
      // Reversed relative to a buy.
      tokenIn: pending.token,
      tokenOut: pending.baseAsset
    };

    const assessment = await createRobinhoodSafetyAssessment({
      quote: vi.fn().mockResolvedValue(90n),
      liquidityLookup: vi.fn().mockResolvedValue(1_000_000),
      minimumLiquidityUsd: 50_000,
      probeFeeOnTransfer
    })(sellContext);

    expect(probeFeeOnTransfer).toHaveBeenCalledWith(pending.token);
    expect(probeFeeOnTransfer).not.toHaveBeenCalledWith(pending.baseAsset);
    expect(check(assessment, 'fee_on_transfer')).toMatchObject({ status: 'fail', reliable: true });
    expect(evaluateRobinhoodSafety(assessment)[0]).toContain(
      'Uniswap V3 cannot route fee-on-transfer tokens'
    );
  });

  it('lets an untaxed token exit cleanly', async () => {
    const sellContext = {
      order: {
        clientOrderId: 'signal-rh-exit-ok',
        token: pending.token,
        direction: 'sell' as const,
        amountInBaseUnits: 100n,
        slippageBps: 300
      },
      route: { status: 'route' as const, fee: 3000, amountOut: 100n },
      tokenIn: pending.token,
      tokenOut: pending.baseAsset
    };

    const assessment = await createRobinhoodSafetyAssessment({
      quote: vi.fn().mockResolvedValue(90n),
      liquidityLookup: vi.fn().mockResolvedValue(1_000_000),
      minimumLiquidityUsd: 50_000,
      probeFeeOnTransfer: vi.fn().mockResolvedValue(0)
    })(sellContext);

    expect(check(assessment, 'fee_on_transfer')).toMatchObject({ status: 'pass', reliable: true });
    expect(evaluateRobinhoodSafety(assessment)).toEqual([]);
  });

  it('rejects a negative tolerance at construction', () => {
    expect(() => createRobinhoodSafetyAssessment({
      quote: vi.fn(),
      minimumLiquidityUsd: 50_000,
      maxTransferFeeBps: -1
    })).toThrow('non-negative integer');
  });
});
