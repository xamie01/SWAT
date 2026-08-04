import { describe, expect, it, vi } from 'vitest';

// The coordinator imports CopyExecutionRecord from @swat/db as a type only, but
// the venue module imports transitionCopyExecution as a value — and the @swat/db
// barrel constructs the pg pool at import time. Nothing here connects; every DB
// call is injected.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://reconciliation-unit-test/unused';
});

import type { CopyExecutionRecord } from '@swat/db';
import type { Chain } from '@swat/shared';
import {
  runReconciliationCoordinator,
  type ReconciliationCoordinatorDependencies,
  type VenueReconciler
} from './reconciliation-coordinator.js';
import {
  createEvmReceiptReconciler,
  createPolymarketReconciler,
  createSolanaConfirmationReconciler
} from './reconciliation-venues.js';

const NOW = new Date('2026-08-01T12:00:00.000Z');

function execution(overrides: Partial<CopyExecutionRecord> = {}): CopyExecutionRecord {
  return {
    id: 'exec-1',
    signalId: 'signal-1',
    sourceTradeId: 'source-1',
    chain: 'solana',
    targetAccount: 'operator',
    tokenMint: 'solana:TOKEN',
    direction: 'buy',
    executionMode: 'live',
    clientOrderId: 'swat-abc',
    state: 'reconciliation_required',
    requestedBaseQuantity: '10',
    requestedQuoteQuantity: '100',
    confirmedBaseQuantity: '0',
    confirmedQuoteQuantity: '0',
    reservedBaseQuantity: '0',
    submissionAttempts: 1,
    maxSubmissionAttempts: 3,
    simulationId: null,
    submissionType: 'transaction',
    submissionId: 'sig-1',
    nextReconciliationAt: null,
    reconciliationClaimId: 'claim-1',
    reconciliationAttempts: 1,
    maxReconciliationAttempts: 5,
    sourcePositionBeforeQuantity: null,
    sourceSellFraction: null,
    ...overrides
  } as CopyExecutionRecord;
}

function deps(
  overrides: Partial<ReconciliationCoordinatorDependencies> = {}
): ReconciliationCoordinatorDependencies {
  return {
    claim: vi.fn(async () => []),
    release: vi.fn(async () => true),
    reconcilers: {},
    escalate: vi.fn(async () => undefined),
    now: () => NOW,
    ...overrides
  };
}

describe('runReconciliationCoordinator', () => {
  it('claims a default batch size', async () => {
    const claim = vi.fn(async () => []);
    await runReconciliationCoordinator(deps({ claim }));
    expect(claim).toHaveBeenCalledWith({ limit: 20 });
  });

  it('releases with no retry when the venue resolves the execution', async () => {
    const release = vi.fn(async () => true);
    const reconcile: VenueReconciler = vi.fn(async () => ({ status: 'resolved' as const }));
    const result = await runReconciliationCoordinator(deps({
      claim: async () => [execution()],
      release,
      reconcilers: { solana: reconcile }
    }));

    expect(result.resolved).toBe(1);
    expect(release).toHaveBeenCalledWith({
      executionId: 'exec-1',
      claimId: 'claim-1',
      retryAt: null
    });
  });

  it('reschedules a pending execution using the venue retry time', async () => {
    const release = vi.fn(async () => true);
    const retryAt = new Date('2026-08-01T12:05:00.000Z');
    const result = await runReconciliationCoordinator(deps({
      claim: async () => [execution()],
      release,
      reconcilers: { solana: async () => ({ status: 'pending', retryAt }) }
    }));

    expect(result.pending).toBe(1);
    expect(release).toHaveBeenCalledWith({
      executionId: 'exec-1',
      claimId: 'claim-1',
      retryAt
    });
  });

  it('falls back to the configured backoff when the venue gives no retry time', async () => {
    const release = vi.fn(async () => true);
    await runReconciliationCoordinator(deps({
      claim: async () => [execution()],
      release,
      retryDelayMs: 30_000,
      reconcilers: { solana: async () => ({ status: 'pending' }) }
    }));

    expect(release).toHaveBeenCalledWith({
      executionId: 'exec-1',
      claimId: 'claim-1',
      retryAt: new Date('2026-08-01T12:00:30.000Z')
    });
  });

  // The whole point of the coordinator is to unstick executions, so it must
  // never be the thing that leaves a claim held.
  it('releases the claim when the venue handler throws', async () => {
    const release = vi.fn(async () => true);
    const result = await runReconciliationCoordinator(deps({
      claim: async () => [execution()],
      release,
      reconcilers: {
        solana: async () => {
          throw new Error('rpc timeout');
        }
      }
    }));

    expect(result.unresolved).toBe(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not throw when releasing the claim itself fails', async () => {
    const result = await runReconciliationCoordinator(deps({
      claim: async () => [execution()],
      release: async () => {
        throw new Error('db down');
      },
      reconcilers: { solana: async () => ({ status: 'resolved' }) }
    }));

    expect(result.resolved).toBe(1);
  });

  // A chain whose runtime is absent must be handed back untouched, not resolved
  // by a process that has no way to observe the venue.
  it('reschedules a chain with no handler instead of resolving it', async () => {
    const release = vi.fn(async () => true);
    const escalate = vi.fn(async () => undefined);
    const result = await runReconciliationCoordinator(deps({
      claim: async () => [execution({ chain: 'polygon' })],
      release,
      escalate,
      retryDelayMs: 60_000,
      reconcilers: {}
    }));

    expect(result.unsupported).toBe(1);
    expect(result.resolved).toBe(0);
    expect(escalate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({
      executionId: 'exec-1',
      claimId: 'claim-1',
      retryAt: new Date('2026-08-01T12:01:00.000Z')
    });
  });

  it('escalates once an unresolved execution has burned its last attempt', async () => {
    const escalate = vi.fn(async () => undefined);
    const result = await runReconciliationCoordinator(deps({
      claim: async () => [execution({
        reconciliationAttempts: 5,
        maxReconciliationAttempts: 5
      })],
      escalate,
      reconcilers: { solana: async () => ({ status: 'unresolved', reason: 'no evidence' }) }
    }));

    expect(result.exhausted).toBe(1);
    expect(escalate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'exec-1' }),
      '[operator] no evidence'
    );
  });

  it('does not escalate while attempts remain', async () => {
    const escalate = vi.fn(async () => undefined);
    const result = await runReconciliationCoordinator(deps({
      claim: async () => [execution({ reconciliationAttempts: 2, maxReconciliationAttempts: 5 })],
      escalate,
      reconcilers: { solana: async () => ({ status: 'unresolved', reason: 'no evidence' }) }
    }));

    expect(result.unresolved).toBe(1);
    expect(result.exhausted).toBe(0);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('still releases the claim when escalation fails', async () => {
    const release = vi.fn(async () => true);
    await runReconciliationCoordinator(deps({
      claim: async () => [execution({
        reconciliationAttempts: 5,
        maxReconciliationAttempts: 5
      })],
      release,
      escalate: async () => {
        throw new Error('redis down');
      },
      reconcilers: { solana: async () => ({ status: 'unresolved', reason: 'no evidence' }) }
    }));

    expect(release).toHaveBeenCalledTimes(1);
  });

  // Without a claim id this process cannot prove it owns the row, so acting on
  // it risks a concurrent executor reconciling the same execution.
  it('skips a claimed row that carries no claim id', async () => {
    const release = vi.fn(async () => true);
    const reconcile = vi.fn(async () => ({ status: 'resolved' as const }));
    const result = await runReconciliationCoordinator(deps({
      claim: async () => [execution({ reconciliationClaimId: null })],
      release,
      reconcilers: { solana: reconcile }
    }));

    expect(result.unresolved).toBe(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('routes each claimed execution to the handler for its own chain', async () => {
    const seen: Chain[] = [];
    const handler = (chain: Chain): VenueReconciler => async () => {
      seen.push(chain);
      return { status: 'resolved' };
    };
    const result = await runReconciliationCoordinator(deps({
      claim: async () => [
        execution({ id: 'a', chain: 'solana' }),
        execution({ id: 'b', chain: 'polygon' }),
        execution({ id: 'c', chain: 'robinhood-chain' })
      ],
      reconcilers: {
        solana: handler('solana'),
        polygon: handler('polygon'),
        'robinhood-chain': handler('robinhood-chain')
      }
    }));

    expect(result.claimed).toBe(3);
    expect(result.resolved).toBe(3);
    expect(seen).toEqual(['solana', 'polygon', 'robinhood-chain']);
  });

  it('passes an explicit batch size through to the DB claim', async () => {
    const claim = vi.fn(async () => []);
    await runReconciliationCoordinator(deps({ claim, limit: 5 }));
    expect(claim).toHaveBeenCalledWith({ limit: 5 });
  });
});

describe('createEvmReceiptReconciler', () => {
  it('fails the execution when the transaction reverted', async () => {
    const fail = vi.fn(async () => undefined);
    const reconcile = createEvmReceiptReconciler({
      probe: async () => ({ status: 'reverted' }),
      fail
    });

    const outcome = await reconcile(execution({ chain: 'robinhood-chain', submissionId: '0xdead' }));

    expect(outcome).toEqual({ status: 'resolved' });
    expect(fail).toHaveBeenCalledWith('exec-1', expect.stringContaining('0xdead'));
  });

  it('stays pending while the receipt is unavailable', async () => {
    const fail = vi.fn(async () => undefined);
    const reconcile = createEvmReceiptReconciler({ probe: async () => null, fail });

    expect(await reconcile(execution({ chain: 'robinhood-chain' }))).toEqual({ status: 'pending' });
    expect(fail).not.toHaveBeenCalled();
  });

  // Booking a fill needs the submitted amounts, which live in the pending store
  // that is by definition gone here. Guessing would corrupt the ledger.
  it('reports unresolved for a success it cannot quantify', async () => {
    const fail = vi.fn(async () => undefined);
    const reconcile = createEvmReceiptReconciler({
      probe: async () => ({ status: 'success' }),
      fail
    });

    const outcome = await reconcile(execution({ chain: 'robinhood-chain' }));

    expect(outcome.status).toBe('unresolved');
    expect(fail).not.toHaveBeenCalled();
  });

  it('never fails an execution whose submission identity is unknown', async () => {
    const probe = vi.fn(async () => null);
    const fail = vi.fn(async () => undefined);
    const reconcile = createEvmReceiptReconciler({ probe, fail });

    const outcome = await reconcile(execution({ chain: 'robinhood-chain', submissionId: null }));

    expect(outcome.status).toBe('unresolved');
    expect(probe).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });
});

describe('createSolanaConfirmationReconciler', () => {
  it('fails the execution when the signature failed on chain', async () => {
    const fail = vi.fn(async () => undefined);
    const reconcile = createSolanaConfirmationReconciler({
      probe: async () => ({ status: 'failed' }),
      fail
    });

    expect(await reconcile(execution())).toEqual({ status: 'resolved' });
    expect(fail).toHaveBeenCalledWith('exec-1', expect.stringContaining('sig-1'));
  });

  it('stays pending while the signature is not found', async () => {
    const reconcile = createSolanaConfirmationReconciler({
      probe: async () => ({ status: 'not-found' }),
      fail: async () => undefined
    });

    expect(await reconcile(execution())).toEqual({ status: 'pending' });
  });

  it('reports unresolved for a confirmation it cannot quantify', async () => {
    const reconcile = createSolanaConfirmationReconciler({
      probe: async () => ({ status: 'confirmed' }),
      fail: async () => undefined
    });

    expect((await reconcile(execution())).status).toBe('unresolved');
  });
});

describe('createPolymarketReconciler', () => {
  it.each(['filled', 'partial', 'cancelled', 'failed'] as const)(
    'treats a %s order as resolved because Polymarket persists it itself',
    async (status) => {
      const reconcile = createPolymarketReconciler({ probe: async () => ({ status }) });
      expect(await reconcile(execution({ chain: 'polygon' }))).toEqual({ status: 'resolved' });
    }
  );

  it('stays pending while the order awaits confirmation', async () => {
    const reconcile = createPolymarketReconciler({
      probe: async () => ({ status: 'pending_confirmation' })
    });
    expect(await reconcile(execution({ chain: 'polygon' }))).toEqual({ status: 'pending' });
  });

  it('surfaces the venue reason for an ambiguous order', async () => {
    const reconcile = createPolymarketReconciler({
      probe: async () => ({ status: 'ambiguous', reason: 'no fill evidence' })
    });

    expect(await reconcile(execution({ chain: 'polygon' }))).toEqual({
      status: 'unresolved',
      reason: 'no fill evidence'
    });
  });

  it('reports unresolved when no order row is joined to the execution', async () => {
    const reconcile = createPolymarketReconciler({ probe: async () => null });
    const outcome = await reconcile(execution({ chain: 'polygon' }));
    expect(outcome.status).toBe('unresolved');
  });
});
