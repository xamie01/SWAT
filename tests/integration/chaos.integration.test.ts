import { assertPackage28IsolationPreflight } from './helpers/package28-isolation.js';
import type { Queue as ChaosQueue } from 'bullmq';
import type { Redis as ChaosRedis } from 'ioredis';
import type { LifecycleFixture } from './helpers/lifecycle-fixture.js';

/** Declarations, a fixture UUID and a queue name are not session ownership.
 * No disposable baseline or exact owned backend/client inventory is available.
 * Even a future returning preflight must not silently enable these test bodies.
 */
function assertChaosSessionOwnershipAvailable(): void {
  throw new Error('Chaos integration unavailable: verified disposable baseline and exact owned PostgreSQL/Redis session identities are missing');
}

// Protect direct imports too, not only collection through the root config.
assertPackage28IsolationPreflight(process.env);
assertChaosSessionOwnershipAvailable();
const { afterAll, describe, expect, it } = await import('vitest');
const { resolveChainAddress } = await import('../../packages/shared/src/address.js');
const { closePool, pool } = await import('../../packages/db/src/client.js');
const {
  claimSourceSignalForCopyExecution,
  insertSourceTradeSignal,
  recordSourceTradeEvent,
  transitionCopyExecution
} = await import('../../packages/db/src/copy-trade-lifecycle.js');
const { withTransaction } = await import('../../packages/db/src/transaction.js');
const { withLifecycleFixture } = await import('./helpers/lifecycle-fixture.js');

/**
 * Historical E1 acceptance (`G7-T5`) scenarios, retained but NOT runnable.
 * The assertions below describe intended recovery, not qualified fault evidence.
 * Import refuses before infrastructure, and PostgreSQL/Redis fault helpers are
 * explicitly unavailable until disposable baseline and session ownership exist.
 * No caller-provided run name or endpoint establishes ownership of peer sessions.
 */

const CLAIM_INPUT = {
  executionMode: 'paper' as const,
  requestedQuoteQuantity: '100',
  maxPositionEvidenceAgeMs: 10 * 60_000
};

/** Unavailable: neither a database-wide selector nor a pool name proves PID ownership. */
async function terminateOurBackends(): Promise<void> {
  assertChaosSessionOwnershipAvailable();
}

/** Unavailable: never disconnect Redis peers by type or invented client identity. */
async function terminateOwnedRedisClients(_control: ChaosRedis): Promise<void> {
  assertChaosSessionOwnershipAvailable();
}

afterAll(async () => {
  await closePool();
});

/** Stage a confirmed source event and a claimable signal for it. */
async function stageSignal(fixture: LifecycleFixture): Promise<string> {
  const walletAddress = resolveChainAddress(fixture.sourceWallet, fixture.chain).prefixed;
  await pool.query(
    `INSERT INTO wallets (address, chain, source, status, total_trades, composite_score, last_active)
     VALUES ($1, $2, 'manual', 'active', 40, 90, NOW())
     ON CONFLICT (address) DO UPDATE
       SET status = 'active', total_trades = 40, last_active = NOW()`,
    [walletAddress, fixture.chain]
  );

  const eventAt = new Date(Date.now() - 5_000);
  const source = await recordSourceTradeEvent({
    chain: fixture.chain,
    sourceEventType: 'transaction',
    sourceEventId: `${fixture.sourceEventPrefix}chaos-buy`,
    transactionHash: `${fixture.sourceEventPrefix}chaos-buy`,
    walletAddress: fixture.sourceWallet,
    tokenMint: fixture.tokenMint,
    side: 'buy',
    quantity: '10',
    amountUsd: '2500',
    priceUsd: '250',
    eventAt,
    observedAt: eventAt,
    confirmationState: 'finalized',
    confirmationEvidenceId: `${fixture.sourceEventPrefix}chaos-finalized`
  });
  await pool.query(
    'INSERT INTO tokens (mint, chain) VALUES ($1, $2) ON CONFLICT (mint) DO NOTHING',
    [source.event.tokenMint, source.event.chain]
  );
  const signal = await insertSourceTradeSignal({
    sourceTradeId: source.event.id,
    confidence: 90,
    signalScore: 90,
    triggerData: { reason: 'chaos integration' },
    maxEventAgeMs: 10 * 60_000,
    maxPositionEvidenceAgeMs: 10 * 60_000
  });
  return signal.id;
}

function claim(signalId: string, fixture: LifecycleFixture) {
  return claimSourceSignalForCopyExecution({
    signalId,
    targetAccount: fixture.targetAccount,
    ...CLAIM_INPUT
  });
}

/** Every `copy_executions` row this fixture's source trade produced. */
async function executionRows(fixture: LifecycleFixture): Promise<Array<{
  id: string;
  state: string;
  confirmed_base_quantity: string;
  confirmed_quote_quantity: string;
}>> {
  const { rows } = await pool.query<{
    id: string;
    state: string;
    confirmed_base_quantity: string;
    confirmed_quote_quantity: string;
  }>(
    `SELECT execution.id,
            execution.state,
            execution.confirmed_base_quantity,
            execution.confirmed_quote_quantity
       FROM copy_executions execution
       JOIN source_trades source ON source.id = execution.source_trade_id
      WHERE source.source_event_id LIKE $1
      ORDER BY execution.requested_at`,
    [`${fixture.sourceEventPrefix}%`]
  );
  return rows;
}

/**
 * The invariant, asserted the same way in every case: one execution, and a
 * ledger that still says nothing was filled.
 */
async function expectNoDuplicateAndNoFill(
  fixture: LifecycleFixture,
  executionId: string
): Promise<void> {
  const rows = await executionRows(fixture);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.id).toBe(executionId);
  expect(Number(rows[0]?.confirmed_base_quantity)).toBe(0);
  expect(Number(rows[0]?.confirmed_quote_quantity)).toBe(0);

  // The claim creates the `copy_positions` row up front as the lock anchor for
  // the position, so its presence is expected. What must stay zero is every
  // quantity on it — that is where a fabricated fill would show up.
  const positions = await pool.query<{
    confirmed_quantity: string;
    total_acquired_quantity: string;
    cost_basis_usd: string;
  }>(
    `SELECT confirmed_quantity, total_acquired_quantity, cost_basis_usd
       FROM copy_positions
      WHERE target_account = $1 AND chain = $2 AND token_mint = $3`,
    [
      resolveChainAddress(fixture.targetAccount, fixture.chain).prefixed,
      fixture.chain,
      resolveChainAddress(fixture.tokenMint, fixture.chain).prefixed
    ]
  );
  for (const position of positions.rows) {
    expect(Number(position.confirmed_quantity)).toBe(0);
    expect(Number(position.total_acquired_quantity)).toBe(0);
    expect(Number(position.cost_basis_usd)).toBe(0);
  }
}

describe('chaos: executor death after submit', () => {
  it('resumes the same execution instead of opening a second one', async () => {
    await withLifecycleFixture(async (fixture) => {
      const signalId = await stageSignal(fixture);

      const first = await claim(signalId, fixture);
      expect(first.execution).not.toBeNull();
      const executionId = first.execution!.id;

      await transitionCopyExecution({
        executionId,
        nextState: 'simulated',
        simulationId: `${fixture.sourceEventPrefix}sim`
      });
      const submitted = await transitionCopyExecution({
        executionId,
        nextState: 'submitted',
        submissionType: 'transaction',
        submissionId: `${fixture.sourceEventPrefix}submission`,
        // Required by the lifecycle, and the reason this fault is survivable:
        // the deadline is written in the same transaction as the submission, so
        // a process that dies immediately after still leaves the row scheduled
        // for reconciliation.
        nextReconciliationAt: new Date(Date.now() + 30_000)
      });
      expect(submitted.state).toBe('submitted');

      // Death. Nothing acknowledges the submission; the queue redelivers.
      const replay = await claim(signalId, fixture);

      expect(replay.execution?.id).toBe(executionId);
      expect(replay.created).toBe(false);
      // Still `submitted`: the replay must not rewind a live venue submission
      // to `requested` and re-send it.
      expect(replay.execution?.state).toBe('submitted');
      await expectNoDuplicateAndNoFill(fixture, executionId);
    });
  });

  it('does not invent a fill for a submission it never heard back about', async () => {
    await withLifecycleFixture(async (fixture) => {
      const signalId = await stageSignal(fixture);
      const claimed = await claim(signalId, fixture);
      const executionId = claimed.execution!.id;

      await transitionCopyExecution({
        executionId,
        nextState: 'simulated',
        simulationId: `${fixture.sourceEventPrefix}sim`
      });
      await transitionCopyExecution({
        executionId,
        nextState: 'submitted',
        submissionType: 'transaction',
        submissionId: `${fixture.sourceEventPrefix}submission`,
        nextReconciliationAt: new Date(Date.now() + 30_000)
      });

      // The honest outcome of an unheard-of submission is ambiguity, not a
      // guessed quantity. A guess here would corrupt the position ledger
      // permanently, so the row must be routed to reconciliation instead.
      const escalated = await transitionCopyExecution({
        executionId,
        nextState: 'reconciliation_required',
        reason: 'executor died after submit'
      });

      expect(escalated.state).toBe('reconciliation_required');
      await expectNoDuplicateAndNoFill(fixture, executionId);
    });
  });
});

describe('chaos: PostgreSQL restart', () => {
  it('recovers the pool and keeps the claimed execution intact', async () => {
    await withLifecycleFixture(async (fixture) => {
      const signalId = await stageSignal(fixture);
      const claimed = await claim(signalId, fixture);
      const executionId = claimed.execution!.id;

      await terminateOurBackends();

      // The pool opens fresh connections rather than staying poisoned.
      const rows = await executionRows(fixture);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe('requested');

      const replay = await claim(signalId, fixture);
      expect(replay.execution?.id).toBe(executionId);
      expect(replay.created).toBe(false);
      await expectNoDuplicateAndNoFill(fixture, executionId);
    });
  });

  it('rolls a transaction killed mid-flight back rather than half-applying it', async () => {
    await withLifecycleFixture(async (fixture) => {
      const signalId = await stageSignal(fixture);

      // Driven through the same helper the canonical lifecycle uses, so this
      // asserts production behaviour and not a transaction shape invented here.
      // Before it was hardened, the dying backend emitted `'error'` on the
      // checked-out client with no listener attached and took the process down
      // instead of failing this one transaction.
      const interrupted = await withTransaction(async (client) => {
        await client.query(`UPDATE signals SET status = 'executing' WHERE id = $1`, [signalId]);
        await terminateOurBackends();
        return 'committed';
      }).catch((error: unknown) => error);

      expect(interrupted).toBeInstanceOf(Error);

      // The uncommitted status change died with the backend, so the signal is
      // still claimable and the claim — not a partial write — decides.
      const { rows } = await pool.query<{ status: string }>(
        'SELECT status FROM signals WHERE id = $1',
        [signalId]
      );
      expect(rows[0]?.status).not.toBe('executing');

      const claimed = await claim(signalId, fixture);
      expect(claimed.execution).not.toBeNull();
      await expectNoDuplicateAndNoFill(fixture, claimed.execution!.id);
    });
  });
});

describe('chaos: Redis restart', () => {
  /** Queue names alone do not qualify a disposable Redis or owned clients/keys.
   * Refuse before creation, the callback or any destructive cleanup.
   */
  async function withQueue(
    _fixture: LifecycleFixture,
    _operation: (queue: ChaosQueue, control: ChaosRedis) => Promise<void>
  ): Promise<void> {
    assertChaosSessionOwnershipAvailable();
  }

  it('reconnects after its clients are dropped and still holds the queued job', async () => {
    await withLifecycleFixture(async (fixture) => {
      const signalId = await stageSignal(fixture);
      await withQueue(fixture, async (queue, control) => {
        await queue.add('copyTrade', { signalId }, { jobId: signalId });

        // No owned client inventory is available; this is an explicit refusal.
        await terminateOwnedRedisClients(control);

        const job = await queue.getJob(signalId);
        expect(job?.data).toEqual({ signalId });
      });
    });
  });

  it('loses the job but never the ledger when Redis comes back empty', async () => {
    await withLifecycleFixture(async (fixture) => {
      const signalId = await stageSignal(fixture);
      const claimed = await claim(signalId, fixture);
      const executionId = claimed.execution!.id;

      await withQueue(fixture, async (queue) => {
        await queue.add('copyTrade', { signalId }, { jobId: signalId });

        // A Redis with no persistence comes back with nothing. Dropping the
        // queue's keys is that, scoped to this fixture.
        await queue.obliterate({ force: true });
        expect(await queue.getJob(signalId)).toBeUndefined();

        // Re-enqueued by hand, as an operator would after losing the queue.
        await queue.add('copyTrade', { signalId }, { jobId: signalId });
        const replay = await claim(signalId, fixture);

        expect(replay.execution?.id).toBe(executionId);
        expect(replay.created).toBe(false);
      });

      await expectNoDuplicateAndNoFill(fixture, executionId);
    });
  });
});

describe('chaos: worker reconnection', () => {
  it('gives the claim to exactly one of two workers racing the same signal', async () => {
    await withLifecycleFixture(async (fixture) => {
      const signalId = await stageSignal(fixture);

      const settled = await Promise.allSettled([
        claim(signalId, fixture),
        claim(signalId, fixture)
      ]);

      const claims = settled
        .filter((result) => result.status === 'fulfilled')
        .map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof claim>>>).value);
      const created = claims.filter((result) => result.created);
      expect(created).toHaveLength(1);

      // Whether the loser saw a race error or an already-claimed execution, it
      // must not have produced a second row.
      await expectNoDuplicateAndNoFill(fixture, created[0]!.execution!.id);
    });
  });

  it('lets a reconnecting worker resume its own in-flight execution', async () => {
    await withLifecycleFixture(async (fixture) => {
      const signalId = await stageSignal(fixture);
      const claimed = await claim(signalId, fixture);
      const executionId = claimed.execution!.id;
      await transitionCopyExecution({
        executionId,
        nextState: 'simulated',
        simulationId: `${fixture.sourceEventPrefix}sim`
      });

      // No connection may be acquired to pretend a worker reconnection occurred.
      assertChaosSessionOwnershipAvailable();

      const resumed = await claim(signalId, fixture);
      expect(resumed.execution?.id).toBe(executionId);
      expect(resumed.created).toBe(false);
      expect(resumed.execution?.state).toBe('simulated');
      await expectNoDuplicateAndNoFill(fixture, executionId);
    });
  });

});
