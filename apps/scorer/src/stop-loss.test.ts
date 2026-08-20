import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenPositionSnapshot } from '@swat/db';

// The sweep imports its threshold math from @swat/db, whose barrel eagerly
// constructs the pg pool. The pool never connects here — every DB call is an
// injected dependency — but the module still demands a URL at import time.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://stop-loss-unit-test/unused';
});

import { runStopLossSweep, type StopLossSweepDependencies } from './stop-loss.js';

function position(overrides: Partial<OpenPositionSnapshot> = {}): OpenPositionSnapshot {
  return {
    signalId: 'signal-1',
    tokenMint: 'solana:token-1',
    chain: 'solana',
    openQuantity: 100,
    openCostBasisUsd: 1000,
    // -250 on a 1000 basis is a 25% drawdown, past the 20% threshold below.
    unrealizedPnlUsd: -250,
    currentPriceUsd: 7.5,
    ...overrides
  };
}

function deps(overrides: Partial<StopLossSweepDependencies> = {}): StopLossSweepDependencies {
  return {
    positions: [position()],
    resolvePolicy: vi.fn().mockResolvedValue({ stopLossPct: 20 }),
    claim: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    enqueueSell: vi.fn().mockResolvedValue(undefined),
    publishAlert: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe('runStopLossSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('queues exactly one full-position sell for a breached position', async () => {
    const dependencies = deps();

    await expect(runStopLossSweep(dependencies)).resolves.toEqual({
      scanned: 1,
      breached: 1,
      queued: 1,
      alreadyTriggered: 0,
      failed: 0
    });

    expect(dependencies.enqueueSell).toHaveBeenCalledOnce();
    expect(dependencies.enqueueSell).toHaveBeenCalledWith(
      {
        signalId: 'signal-1',
        tokenMint: 'solana:token-1',
        score: 100,
        direction: 'sell',
        stopLoss: true,
        sellTokenAmount: 100
      },
      'stop-loss-operator-signal-1',
      'solana'
    );
    expect(dependencies.claim).toHaveBeenCalledWith({
      account: 'operator',
      signalId: 'signal-1',
      chain: 'solana',
      tokenMint: 'solana:token-1',
      thresholdPct: 20,
      drawdownPct: 25,
      openQuantity: 100,
      openCostBasisUsd: 1000,
      priceUsd: 7.5
    });
    expect(dependencies.release).not.toHaveBeenCalled();
  });

  it('routes each chain’s exit to that chain, not to a shared queue (S3-25)', async () => {
    // The queue is chosen from this argument, so a wrong chain here sends a
    // stop-loss exit to a worker that serves a different venue.
    const dependencies = deps({
      positions: [
        position({ signalId: 'signal-sol' }),
        position({ signalId: 'signal-poly', chain: 'polygon', tokenMint: 'polygon:token-2' }),
        position({
          signalId: 'signal-rh',
          chain: 'robinhood-chain',
          tokenMint: 'robinhood-chain:0xtoken3'
        })
      ]
    });

    await expect(runStopLossSweep(dependencies)).resolves.toMatchObject({ queued: 3, failed: 0 });

    const routed = (dependencies.enqueueSell as ReturnType<typeof vi.fn>).mock.calls.map(
      ([job, , chain]) => [job.signalId, chain]
    );
    expect(routed).toEqual([
      ['signal-sol', 'solana'],
      ['signal-poly', 'polygon'],
      ['signal-rh', 'robinhood-chain']
    ]);
  });

  it('queues nothing on a repeat sweep of the same position', async () => {
    // Second sweep: the (account, signal) row already exists, so the claim loses.
    const dependencies = deps({ claim: vi.fn().mockResolvedValue(false) });

    await expect(runStopLossSweep(dependencies)).resolves.toEqual({
      scanned: 1,
      breached: 1,
      queued: 0,
      alreadyTriggered: 1,
      failed: 0
    });

    expect(dependencies.enqueueSell).not.toHaveBeenCalled();
    expect(dependencies.publishAlert).not.toHaveBeenCalled();
  });

  it('leaves a healthy position alone', async () => {
    const dependencies = deps({
      positions: [position({ unrealizedPnlUsd: -50 }), position({ unrealizedPnlUsd: 300 })]
    });

    await expect(runStopLossSweep(dependencies)).resolves.toEqual({
      scanned: 2,
      breached: 0,
      queued: 0,
      alreadyTriggered: 0,
      failed: 0
    });
    expect(dependencies.claim).not.toHaveBeenCalled();
  });

  it('does not trigger when the chain policy disables stop-loss', async () => {
    const dependencies = deps({
      resolvePolicy: vi.fn().mockResolvedValue({ stopLossPct: 0 })
    });

    const result = await runStopLossSweep(dependencies);
    expect(result.breached).toBe(0);
    expect(dependencies.enqueueSell).not.toHaveBeenCalled();
  });

  it('releases the claim when the sell cannot be queued, so the next sweep retries', async () => {
    const dependencies = deps({
      enqueueSell: vi.fn().mockRejectedValue(new Error('redis down'))
    });

    await expect(runStopLossSweep(dependencies)).resolves.toEqual({
      scanned: 1,
      breached: 1,
      queued: 0,
      alreadyTriggered: 0,
      failed: 1
    });

    expect(dependencies.release).toHaveBeenCalledWith('operator', 'signal-1');
    expect(dependencies.publishAlert).not.toHaveBeenCalled();
  });

  it('keeps the exit queued when only the alert fails', async () => {
    const dependencies = deps({
      publishAlert: vi.fn().mockRejectedValue(new Error('redis down'))
    });

    await expect(runStopLossSweep(dependencies)).resolves.toMatchObject({
      queued: 1,
      failed: 0
    });
    expect(dependencies.release).not.toHaveBeenCalled();
  });

  it('resolves policy once per chain and keeps going after a lookup failure', async () => {
    const resolvePolicy = vi.fn(async (_account: string, chain: string) => {
      if (chain === 'polygon') throw new Error('config unavailable');
      return { stopLossPct: 20 };
    });
    const dependencies = deps({
      positions: [
        position({ signalId: 'signal-1' }),
        position({ signalId: 'signal-2' }),
        position({ signalId: 'signal-3', chain: 'polygon', tokenMint: 'polygon:token-3' })
      ],
      resolvePolicy: resolvePolicy as StopLossSweepDependencies['resolvePolicy']
    });

    await expect(runStopLossSweep(dependencies)).resolves.toEqual({
      scanned: 3,
      breached: 2,
      queued: 2,
      alreadyTriggered: 0,
      failed: 1
    });

    // Two solana positions, one lookup.
    expect(resolvePolicy).toHaveBeenCalledTimes(2);
  });

  it('does not act on a position whose drawdown cannot be computed', async () => {
    const dependencies = deps({
      positions: [position({ openCostBasisUsd: 0 }), position({ openQuantity: 0 })]
    });

    const result = await runStopLossSweep(dependencies);
    expect(result).toEqual({
      scanned: 2,
      breached: 0,
      queued: 0,
      alreadyTriggered: 0,
      failed: 0
    });
  });
});
