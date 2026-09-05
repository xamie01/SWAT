import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenPositionSnapshot } from '@swat/db';

// The sweep imports its threshold math from @swat/db, whose barrel eagerly
// constructs the pg pool. The pool never connects here — every DB call is an
// injected dependency — but the module still demands a URL at import time.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://stop-loss-unit-test/unused';
});

import {
  runStopLossSweep,
  stopLossAccountForPosition,
  STOP_LOSS_ACCOUNT,
  type StopLossSweepDependencies
} from './stop-loss.js';

function position(overrides: Partial<OpenPositionSnapshot> = {}): OpenPositionSnapshot {
  return {
    signalId: 'signal-1',
    // The operator path by default, so every pre-`S4-M46` expectation below still
    // describes the behaviour a single-tenant deployment sees.
    userId: null,
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
      failed: 0,
      unaccountable: 0
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
      failed: 0,
      unaccountable: 0
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
      failed: 0,
      unaccountable: 0
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
      failed: 1,
      unaccountable: 0
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
      failed: 1,
      unaccountable: 0
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
      failed: 0,
      unaccountable: 0
    });
  });
});

describe('stopLossAccountForPosition (S4-M46)', () => {
  it('keys the pre-tenancy operator position on the operator account', () => {
    expect(stopLossAccountForPosition(null)).toBe(STOP_LOSS_ACCOUNT);
    expect(STOP_LOSS_ACCOUNT).toBe('operator');
  });

  it('keys a tenant position on that tenant', () => {
    expect(stopLossAccountForPosition('user-a')).toBe('user-a');
  });

  it('gives two tenants distinct keys, which is what the (account, signal_id) key needs', () => {
    expect(stopLossAccountForPosition('user-a')).not.toBe(stopLossAccountForPosition('user-b'));
  });

  it('throws on a blank user id rather than filing it under the operator', () => {
    // A fallback here would key one user's claim on 'operator', and the
    // (account, signal_id) primary key would then block the real owner's claim --
    // exactly the defect S4-M46 exists to close.
    expect(() => stopLossAccountForPosition('')).toThrow(/non-empty user id/);
    expect(() => stopLossAccountForPosition('   ')).toThrow(/non-empty user id/);
  });
});

describe('runStopLossSweep per-user claims (S4-M46)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('gives two users on ONE signal their own claim rather than one blocking the other', async () => {
    // The pre-S4-M46 shape: one account for the whole sweep, so `signal_stop_losses`
    // (PRIMARY KEY (account, signal_id)) accepted the first claim and rejected the
    // second as already-triggered -- leaving the second user holding an unprotected
    // position while the sweep reported success.
    const claimedKeys = new Set<string>();
    const claim = vi.fn(async (input: { account: string; signalId: string }) => {
      const key = `${input.account}::${input.signalId}`;
      if (claimedKeys.has(key)) return false;
      claimedKeys.add(key);
      return true;
    });

    const dependencies = deps({
      positions: [
        position({ signalId: 'shared-signal', userId: 'user-a' }),
        position({ signalId: 'shared-signal', userId: 'user-b' })
      ],
      claim: claim as StopLossSweepDependencies['claim']
    });

    await expect(runStopLossSweep(dependencies)).resolves.toEqual({
      scanned: 2,
      breached: 2,
      queued: 2,
      alreadyTriggered: 0,
      failed: 0,
      unaccountable: 0
    });

    expect([...claimedKeys]).toEqual(['user-a::shared-signal', 'user-b::shared-signal']);
  });

  it('sweeps a winding_down user’s open position, because it never consults subscription state', async () => {
    // The acceptance test for S4-M46. `winding_down` is the cohort whose master may
    // have gone quiet, so their open position is the one that most needs a stop-loss --
    // and the natural enumeration (`user_wallet_subscriptions WHERE state = 'active'`)
    // drops them silently. This sweep's input is the positions mark-to-market priced,
    // so there is no subscription predicate that can drop anyone.
    //
    // `winding_down` is not represented in the dependencies at all, and that absence IS
    // the assertion: the sweep has no channel through which a subscription state could
    // reach it.
    const windingDownUser = 'user-winding-down';
    const dependencies = deps({
      positions: [position({ signalId: 'signal-wd', userId: windingDownUser })]
    });

    await expect(runStopLossSweep(dependencies)).resolves.toMatchObject({
      breached: 1,
      queued: 1,
      failed: 0,
      unaccountable: 0
    });

    expect(dependencies.claim).toHaveBeenCalledWith(
      expect.objectContaining({ account: windingDownUser, signalId: 'signal-wd' })
    );
    expect(dependencies.enqueueSell).toHaveBeenCalledWith(
      expect.objectContaining({ signalId: 'signal-wd', userId: windingDownUser }),
      `stop-loss-${windingDownUser}-signal-wd`,
      'solana'
    );
  });

  it('scopes the BullMQ job id per user, so two exits are not deduped into one', async () => {
    // The job id is BullMQ's dedupe key. Left on a shared account, user B's exit would
    // be dropped as a duplicate of user A's after both claims succeeded -- an exit
    // silently lost with no failure recorded anywhere.
    const dependencies = deps({
      positions: [
        position({ signalId: 'shared-signal', userId: 'user-a' }),
        position({ signalId: 'shared-signal', userId: 'user-b' })
      ]
    });

    await runStopLossSweep(dependencies);

    const jobIds = (dependencies.enqueueSell as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, jobId]) => jobId
    );
    expect(jobIds).toEqual([
      'stop-loss-user-a-shared-signal',
      'stop-loss-user-b-shared-signal'
    ]);
    expect(new Set(jobIds).size).toBe(2);
  });

  it('releases only the failing user’s claim, never another holder’s live one', async () => {
    const dependencies = deps({
      positions: [
        position({ signalId: 'shared-signal', userId: 'user-a' }),
        position({ signalId: 'shared-signal', userId: 'user-b' })
      ],
      enqueueSell: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('redis down'))
    });

    await expect(runStopLossSweep(dependencies)).resolves.toMatchObject({
      queued: 1,
      failed: 1
    });

    expect(dependencies.release).toHaveBeenCalledOnce();
    expect(dependencies.release).toHaveBeenCalledWith('user-b', 'shared-signal');
  });

  it('resolves each user’s own stop-loss threshold rather than the first holder’s', async () => {
    // resolveRiskPolicy is account-scoped, so caching on chain alone would serve
    // user-a's threshold to user-b. Here user-b's own 40% stop is not breached by a 25%
    // drawdown, so a shared cache would sell a position that is still inside its stop.
    const resolvePolicy = vi.fn(async (account: string) => ({
      stopLossPct: account === 'user-a' ? 20 : 40
    }));
    const dependencies = deps({
      positions: [
        position({ signalId: 'signal-a', userId: 'user-a' }),
        position({ signalId: 'signal-b', userId: 'user-b' })
      ],
      resolvePolicy: resolvePolicy as StopLossSweepDependencies['resolvePolicy']
    });

    await expect(runStopLossSweep(dependencies)).resolves.toMatchObject({
      scanned: 2,
      breached: 1,
      queued: 1
    });

    expect(resolvePolicy).toHaveBeenCalledTimes(2);
    expect(resolvePolicy).toHaveBeenCalledWith('user-a', 'solana');
    expect(resolvePolicy).toHaveBeenCalledWith('user-b', 'solana');
    expect(dependencies.claim).toHaveBeenCalledOnce();
    expect(dependencies.claim).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'user-a' })
    );
  });

  it('caches one policy lookup per (account, chain) pair', async () => {
    const resolvePolicy = vi.fn().mockResolvedValue({ stopLossPct: 20 });
    const dependencies = deps({
      positions: [
        position({ signalId: 'signal-1', userId: 'user-a' }),
        position({ signalId: 'signal-2', userId: 'user-a' }),
        position({
          signalId: 'signal-3',
          userId: 'user-a',
          chain: 'polygon',
          tokenMint: 'polygon:token-3'
        }),
        position({ signalId: 'signal-4', userId: 'user-b' })
      ],
      resolvePolicy: resolvePolicy as StopLossSweepDependencies['resolvePolicy']
    });

    await runStopLossSweep(dependencies);

    // user-a/solana, user-a/polygon, user-b/solana. Four positions, three lookups.
    expect(resolvePolicy).toHaveBeenCalledTimes(3);
  });

  it('counts a blank owner as unaccountable and keeps sweeping the rest', async () => {
    // Distinct from `failed`: a blank owner is permanent, so reporting it as `failed`
    // would present a condition no retry can clear as a transient infrastructure blip.
    const dependencies = deps({
      positions: [
        position({ signalId: 'signal-broken', userId: '  ' }),
        position({ signalId: 'signal-ok', userId: 'user-a' })
      ]
    });

    await expect(runStopLossSweep(dependencies)).resolves.toEqual({
      scanned: 2,
      breached: 1,
      queued: 1,
      alreadyTriggered: 0,
      failed: 0,
      unaccountable: 1
    });

    expect(dependencies.claim).toHaveBeenCalledOnce();
    expect(dependencies.claim).toHaveBeenCalledWith(
      expect.objectContaining({ account: 'user-a', signalId: 'signal-ok' })
    );
  });

  it('leaves the operator job free of a userId key, byte-identical to pre-fan-out', async () => {
    // The executor picks its acting principal from `typeof payload.userId === 'string'`,
    // so a `userId: null` on the operator job would be a new key on a payload that a
    // redelivered BullMQ job may already hold in its old shape.
    const dependencies = deps();

    await runStopLossSweep(dependencies);

    const [job] = (dependencies.enqueueSell as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Record<string, unknown>
    ];
    expect('userId' in job).toBe(false);
  });
});
