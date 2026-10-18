import { afterAll, describe, expect, it } from 'vitest';
import {
  advanceSourceTradeConfirmation,
  claimSourceSignalForCopyExecution,
  claimCopyExecutionsForReconciliation,
  closePool,
  getCopyExecutionByClientOrderId,
  getSourceTradeByIdentity,
  insertSourceTradeSignal,
  recordCopyExecutionEvidence,
  recordSourceTradeEvent,
  releaseCopyExecutionReconciliationClaim,
  requestCopyExecution,
  transitionCopyExecution,
  query
} from '../../packages/db/src/index.js';
import { withLifecycleFixture } from './helpers/lifecycle-fixture.js';

const eventAt = new Date('2026-01-01T12:00:00.000Z');
const observedAt = new Date('2026-01-01T12:00:01.000Z');

async function ensureSignalToken(tokenMint: string, chain: string): Promise<void> {
  await query(
    `INSERT INTO tokens (mint, chain) VALUES ($1, $2)
     ON CONFLICT (mint) DO NOTHING`,
    [tokenMint, chain]
  );
}

afterAll(async () => {
  await closePool();
});

describe('canonical copy-trade lifecycle', () => {
  it('rejects a copy-linked trade without its signal and source identities', async () => {
    await expect(query(
      `INSERT INTO trades (copy_execution_id, direction)
       VALUES (gen_random_uuid(), 'buy')`
    )).rejects.toThrow('chk_trades_copy_execution_identity_complete');
  });

  it('deduplicates an immutable source event and rejects an identity collision', async () => {
    await withLifecycleFixture(async (fixture) => {
      const input = {
        chain: fixture.chain,
        sourceEventType: 'transaction' as const,
        sourceEventId: `${fixture.sourceEventPrefix}tx-1`,
        transactionHash: `${fixture.sourceEventPrefix}tx-1`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'buy' as const,
        quantity: '10',
        amountUsd: '100',
        priceUsd: '10',
        eventAt,
        observedAt,
        confirmationState: 'confirmed' as const,
        confirmationEvidenceId: `${fixture.sourceEventPrefix}confirmation-1`
      };

      const first = await recordSourceTradeEvent(input);
      const replay = await recordSourceTradeEvent(input);
      const retrieved = await getSourceTradeByIdentity({
        chain: fixture.chain,
        sourceEventType: input.sourceEventType,
        sourceEventId: input.sourceEventId
      });

      expect(first.inserted).toBe(true);
      expect(replay.inserted).toBe(false);
      expect(replay.event.id).toBe(first.event.id);
      expect(replay.position.confirmedQuantity).toBe('10');
      expect(retrieved?.id).toBe(first.event.id);

      await expect(recordSourceTradeEvent({ ...input, quantity: '11' }))
        .rejects.toThrow('identity collision with a different immutable payload');
    });
  });

  it('rebuilds an out-of-order source position and removes reversed evidence', async () => {
    await withLifecycleFixture(async (fixture) => {
      const sell = await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}sell`,
        transactionHash: `${fixture.sourceEventPrefix}sell`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'sell',
        quantity: '4',
        amountUsd: '40',
        priceUsd: '10',
        eventAt: new Date('2026-01-01T12:05:00.000Z'),
        observedAt,
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}sell-confirmed`
      });
      expect(sell.position).toMatchObject({
        confirmedQuantity: '0',
        unmatchedReductionQuantity: '4'
      });

      const buy = await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}buy`,
        transactionHash: `${fixture.sourceEventPrefix}buy`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'buy',
        quantity: '10',
        amountUsd: '100',
        priceUsd: '10',
        eventAt: new Date('2026-01-01T12:00:00.000Z'),
        observedAt: new Date('2026-01-01T12:06:00.000Z'),
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}buy-confirmed`
      });
      expect(buy.position).toMatchObject({
        confirmedQuantity: '6',
        totalAcquiredQuantity: '10',
        totalReducedQuantity: '4',
        unmatchedReductionQuantity: '0'
      });
      expect(Number(buy.position.costBasisUsd)).toBe(60);

      const reversed = await advanceSourceTradeConfirmation({
        sourceTradeId: buy.event.id,
        confirmationState: 'reversed',
        evidenceId: `${fixture.sourceEventPrefix}buy-reversed`,
        observedAt: new Date('2026-01-01T12:07:00.000Z')
      });
      expect(reversed.position).toMatchObject({
        confirmedQuantity: '0',
        costBasisUsd: '0',
        totalAcquiredQuantity: '0',
        totalReducedQuantity: '4',
        unmatchedReductionQuantity: '4'
      });
    });
  });

  it('uses one deterministic client identity for duplicate copy requests', async () => {
    await withLifecycleFixture(async (fixture) => {
      const source = await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}copy-source`,
        transactionHash: `${fixture.sourceEventPrefix}copy-source`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'buy',
        quantity: '5',
        amountUsd: '50',
        eventAt,
        observedAt,
        confirmationState: 'finalized',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}source-finalized`
      });
      const request = {
        sourceTradeId: source.event.id,
        targetAccount: fixture.targetAccount,
        executionMode: 'paper' as const,
        requestedBaseQuantity: '2'
      };

      const first = await requestCopyExecution(request);
      const replay = await requestCopyExecution(request);
      const retrieved = await getCopyExecutionByClientOrderId({
        chain: fixture.chain,
        targetAccount: fixture.targetAccount,
        clientOrderId: first.execution.clientOrderId
      });

      expect(first.created).toBe(true);
      expect(replay.created).toBe(false);
      expect(replay.execution.id).toBe(first.execution.id);
      expect(replay.execution.clientOrderId).toBe(first.execution.clientOrderId);
      expect(retrieved?.id).toBe(first.execution.id);
      await expect(requestCopyExecution({ ...request, requestedBaseQuantity: '3' }))
        .rejects.toThrow('identity collision with different requested quantities');
    });
  });

  it('updates copy positions only from confirmed evidence and removes reversals', async () => {
    await withLifecycleFixture(async (fixture) => {
      const source = await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}evidence-source`,
        transactionHash: `${fixture.sourceEventPrefix}evidence-source`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'buy',
        quantity: '2',
        amountUsd: '20',
        eventAt,
        observedAt,
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}source-confirmed`
      });
      const requested = await requestCopyExecution({
        sourceTradeId: source.event.id,
        targetAccount: fixture.targetAccount,
        executionMode: 'paper',
        requestedBaseQuantity: '2'
      });
      const evidence = {
        executionId: requested.execution.id,
        evidenceType: 'paper_simulation' as const,
        evidenceId: `${fixture.sourceEventPrefix}paper-fill`,
        baseQuantity: '2',
        quoteLeg: { amount: '20', currency: 'USD' as const },
        priceUsd: '10',
        completesExecution: true,
        occurredAt: new Date('2026-01-01T12:00:02.000Z'),
        observedAt: new Date('2026-01-01T12:00:03.000Z')
      };

      const observed = await recordCopyExecutionEvidence({
        ...evidence,
        confirmationState: 'observed'
      });
      expect(observed.execution.confirmedBaseQuantity).toBe('0');
      expect(observed.position.confirmedQuantity).toBe('0');

      const confirmed = await recordCopyExecutionEvidence({
        ...evidence,
        confirmationState: 'confirmed'
      });
      expect(confirmed.execution).toMatchObject({
        state: 'confirmed',
        confirmedBaseQuantity: '2',
        confirmedQuoteQuantity: '20'
      });
      expect(confirmed.position).toMatchObject({
        confirmedQuantity: '2',
        costBasisUsd: '20'
      });

      const reversed = await recordCopyExecutionEvidence({
        ...evidence,
        confirmationState: 'reversed'
      });
      expect(reversed.execution).toMatchObject({
        state: 'reconciliation_required',
        confirmedBaseQuantity: '0',
        confirmedQuoteQuantity: '0'
      });
      expect(reversed.position.confirmedQuantity).toBe('0');
    });
  });

  it('reconciles partial fills with exclusive, owner-checked claims', async () => {
    await withLifecycleFixture(async (fixture) => {
      const source = await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}partial-source`,
        transactionHash: `${fixture.sourceEventPrefix}partial-source`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'buy',
        quantity: '5',
        amountUsd: '50',
        eventAt,
        observedAt,
        confirmationState: 'finalized',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}source-finalized`
      });
      const requested = await requestCopyExecution({
        sourceTradeId: source.event.id,
        targetAccount: fixture.targetAccount,
        executionMode: 'paper',
        requestedBaseQuantity: '5',
        maxReconciliationAttempts: 3
      });
      await transitionCopyExecution({
        executionId: requested.execution.id,
        nextState: 'simulated',
        simulationId: `${fixture.sourceEventPrefix}simulation`
      });
      await transitionCopyExecution({
        executionId: requested.execution.id,
        nextState: 'submitted',
        submissionType: 'order',
        submissionId: `${fixture.sourceEventPrefix}venue-order`,
        nextReconciliationAt: new Date(Date.now() - 1_000)
      });

      const partial = await recordCopyExecutionEvidence({
        executionId: requested.execution.id,
        evidenceType: 'venue_fill',
        evidenceId: `${fixture.sourceEventPrefix}fill-1`,
        baseQuantity: '2',
        quoteLeg: { amount: '20', currency: 'USD' as const },
        priceUsd: '10',
        confirmationState: 'confirmed',
        completesExecution: false,
        occurredAt: new Date('2026-01-01T12:00:04.000Z')
      });
      expect(partial.execution).toMatchObject({
        state: 'partially_filled',
        confirmedBaseQuantity: '2'
      });
      expect(partial.position.confirmedQuantity).toBe('2');

      const [leftClaims, rightClaims] = await Promise.all([
        claimCopyExecutionsForReconciliation({ chain: fixture.chain, limit: 100 }),
        claimCopyExecutionsForReconciliation({ chain: fixture.chain, limit: 100 })
      ]);
      const fixtureClaims = [...leftClaims, ...rightClaims]
        .filter((claim) => claim.id === requested.execution.id);
      expect(fixtureClaims).toHaveLength(1);
      const claim = fixtureClaims[0]!;
      expect(claim.reconciliationClaimId).toBeTruthy();
      expect(claim.reconciliationAttempts).toBe(1);

      const wrongOwnerReleased = await releaseCopyExecutionReconciliationClaim({
        executionId: claim.id,
        claimId: '00000000-0000-4000-8000-000000000000',
        retryAt: new Date(Date.now() - 1_000)
      });
      expect(wrongOwnerReleased).toBe(false);
      const released = await releaseCopyExecutionReconciliationClaim({
        executionId: claim.id,
        claimId: claim.reconciliationClaimId!,
        retryAt: new Date(Date.now() - 1_000)
      });
      expect(released).toBe(true);
      expect(await releaseCopyExecutionReconciliationClaim({
        executionId: claim.id,
        claimId: claim.reconciliationClaimId!,
        retryAt: new Date(Date.now() - 1_000)
      })).toBe(false);

      const reclaimed = (await claimCopyExecutionsForReconciliation({
        chain: fixture.chain,
        limit: 100
      })).find((candidate) => candidate.id === requested.execution.id);
      expect(reclaimed).toMatchObject({ reconciliationAttempts: 2 });
      expect(reclaimed?.reconciliationClaimId).not.toBe(claim.reconciliationClaimId);

      const complete = await recordCopyExecutionEvidence({
        executionId: requested.execution.id,
        evidenceType: 'venue_fill',
        evidenceId: `${fixture.sourceEventPrefix}fill-2`,
        baseQuantity: '3',
        quoteLeg: { amount: '30', currency: 'USD' as const },
        priceUsd: '10',
        confirmationState: 'finalized',
        completesExecution: true,
        occurredAt: new Date('2026-01-01T12:00:05.000Z')
      });
      expect(complete.execution).toMatchObject({
        state: 'confirmed',
        confirmedBaseQuantity: '5',
        confirmedQuoteQuantity: '50',
        reconciliationClaimId: null
      });
      expect(complete.position).toMatchObject({
        confirmedQuantity: '5',
        costBasisUsd: '50'
      });
      const claimsAfterConfirmation = await claimCopyExecutionsForReconciliation({
        chain: fixture.chain,
        limit: 100
      });
      expect(claimsAfterConfirmation.some((candidate) => candidate.id === requested.execution.id))
        .toBe(false);
    });
  });

  it('links one immutable source event to one replay-safe signal and execution', async () => {
    await withLifecycleFixture(async (fixture) => {
      const now = new Date();
      const source = await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}linked-buy`,
        transactionHash: `${fixture.sourceEventPrefix}linked-buy`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'buy',
        quantity: '10',
        amountUsd: '100',
        priceUsd: '10',
        eventAt: new Date(now.getTime() - 2_000),
        observedAt: now,
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}linked-buy-confirmed`
      });
      await ensureSignalToken(source.event.tokenMint, source.event.chain);
      const signalInput = {
        sourceTradeId: source.event.id,
        confidence: 0.9,
        signalScore: 90,
        triggerData: { fixture: true },
        maxEventAgeMs: 60_000,
        maxPositionEvidenceAgeMs: 60_000,
        now
      };
      const signal = await insertSourceTradeSignal(signalInput);
      const replayedSignal = await insertSourceTradeSignal(signalInput);

      expect(signal).toMatchObject({ inserted: true, direction: 'buy' });
      expect(replayedSignal).toMatchObject({ inserted: false, id: signal.id });

      const claimInput = {
        signalId: signal.id,
        targetAccount: fixture.targetAccount,
        executionMode: 'paper' as const,
        requestedQuoteQuantity: '80',
        maxPositionEvidenceAgeMs: 60_000,
        now
      };
      const claimed = await claimSourceSignalForCopyExecution(claimInput);
      const replayedClaim = await claimSourceSignalForCopyExecution(claimInput);

      expect(claimed).toMatchObject({ created: true, claimed: true });
      expect(claimed.execution).toMatchObject({
        signalId: signal.id,
        sourceTradeId: source.event.id,
        state: 'requested',
        requestedQuoteQuantity: '80'
      });
      expect(replayedClaim).toMatchObject({
        created: false,
        claimed: false,
        execution: { id: claimed.execution?.id }
      });
      const history = await query<{ to_state: string }>(
        `SELECT to_state FROM copy_execution_state_history WHERE execution_id = $1`,
        [claimed.execution!.id]
      );
      expect(history.map((entry) => entry.to_state)).toEqual(['requested']);

      await transitionCopyExecution({
        executionId: claimed.execution!.id,
        nextState: 'simulated',
        simulationId: `${fixture.sourceEventPrefix}retry-simulation`
      });
      const simulatedRetry = await claimSourceSignalForCopyExecution(claimInput);
      expect(simulatedRetry).toMatchObject({
        created: false,
        execution: { id: claimed.execution?.id, state: 'simulated' }
      });
      await transitionCopyExecution({
        executionId: claimed.execution!.id,
        nextState: 'reconciliation_required',
        reason: 'fixture requires reconciliation',
        nextReconciliationAt: new Date(Date.now() + 1_000)
      });
      const reconciliationRetry = await claimSourceSignalForCopyExecution(claimInput);
      expect(reconciliationRetry).toMatchObject({
        created: false,
        execution: { id: claimed.execution?.id, state: 'reconciliation_required' }
      });
    });
  });

  it('derives and replays a partial copied exit from the source wallet sold fraction', async () => {
    await withLifecycleFixture(async (fixture) => {
      const now = new Date();
      const sourceBuy = await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}proportional-buy`,
        transactionHash: `${fixture.sourceEventPrefix}proportional-buy`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'buy',
        quantity: '10',
        amountUsd: '100',
        priceUsd: '10',
        eventAt: new Date(now.getTime() - 4_000),
        observedAt: now,
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}proportional-buy-confirmed`
      });
      await ensureSignalToken(sourceBuy.event.tokenMint, sourceBuy.event.chain);
      const buySignal = await insertSourceTradeSignal({
        sourceTradeId: sourceBuy.event.id,
        confidence: 0.9,
        signalScore: 90,
        triggerData: {},
        maxEventAgeMs: 60_000,
        maxPositionEvidenceAgeMs: 60_000,
        now
      });
      const buyExecution = await claimSourceSignalForCopyExecution({
        signalId: buySignal.id,
        targetAccount: fixture.targetAccount,
        executionMode: 'paper',
        requestedQuoteQuantity: '80',
        maxPositionEvidenceAgeMs: 60_000,
        now
      });
      await transitionCopyExecution({
        executionId: buyExecution.execution!.id,
        nextState: 'simulated',
        simulationId: `${fixture.sourceEventPrefix}buy-simulation`
      });
      await recordCopyExecutionEvidence({
        executionId: buyExecution.execution!.id,
        evidenceType: 'paper_simulation',
        evidenceId: `${fixture.sourceEventPrefix}buy-fill`,
        baseQuantity: '8',
        quoteLeg: { amount: '80', currency: 'USD' as const },
        priceUsd: '10',
        confirmationState: 'confirmed',
        completesExecution: true,
        occurredAt: new Date(now.getTime() - 3_000)
      });

      const sourceSell = await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}proportional-sell`,
        transactionHash: `${fixture.sourceEventPrefix}proportional-sell`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'sell',
        quantity: '2.5',
        amountUsd: '25',
        priceUsd: '10',
        eventAt: new Date(now.getTime() - 2_000),
        observedAt: now,
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}proportional-sell-confirmed`
      });
      const sellSignal = await insertSourceTradeSignal({
        sourceTradeId: sourceSell.event.id,
        confidence: 0.9,
        signalScore: 90,
        triggerData: {},
        maxEventAgeMs: 60_000,
        maxPositionEvidenceAgeMs: 60_000,
        now
      });
      expect(sellSignal).toMatchObject({
        direction: 'sell',
        sourcePositionBeforeQuantity: '10',
        sourceSellFraction: '0.25000000000000000000'
      });

      const sellClaimInput = {
        signalId: sellSignal.id,
        targetAccount: fixture.targetAccount,
        executionMode: 'live' as const,
        maxPositionEvidenceAgeMs: 60_000,
        now
      };
      const sellExecution = await claimSourceSignalForCopyExecution(sellClaimInput);
      const replayedSell = await claimSourceSignalForCopyExecution(sellClaimInput);
      expect(sellExecution.execution).toMatchObject({
        direction: 'sell',
        requestedBaseQuantity: '2.00000000000000000000',
        reservedBaseQuantity: '2.00000000000000000000'
      });
      expect(replayedSell.execution?.id).toBe(sellExecution.execution?.id);

      await transitionCopyExecution({
        executionId: sellExecution.execution!.id,
        nextState: 'simulated',
        simulationId: `${fixture.sourceEventPrefix}sell-simulation`
      });
      await transitionCopyExecution({
        executionId: sellExecution.execution!.id,
        nextState: 'submitted',
        submissionType: 'order',
        submissionId: `${fixture.sourceEventPrefix}sell-order`,
        nextReconciliationAt: new Date(Date.now() + 1_000)
      });
      const partialEvidence = {
        executionId: sellExecution.execution!.id,
        evidenceType: 'venue_fill' as const,
        evidenceId: `${fixture.sourceEventPrefix}sell-fill-1`,
        baseQuantity: '1',
        quoteLeg: { amount: '10', currency: 'USD' as const },
        priceUsd: '10',
        confirmationState: 'confirmed' as const,
        completesExecution: false,
        occurredAt: new Date(now.getTime() - 1_000)
      };
      const partial = await recordCopyExecutionEvidence(partialEvidence);
      const replayedPartial = await recordCopyExecutionEvidence(partialEvidence);
      expect(partial.execution.state).toBe('partially_filled');
      expect(partial.position.confirmedQuantity).toBe('7');
      expect(replayedPartial.position.confirmedQuantity).toBe('7');

      const completed = await recordCopyExecutionEvidence({
        ...partialEvidence,
        evidenceId: `${fixture.sourceEventPrefix}sell-fill-2`,
        completesExecution: true,
        occurredAt: now
      });
      expect(completed.execution).toMatchObject({
        state: 'confirmed',
        confirmedBaseQuantity: '2'
      });
      expect(completed.position.confirmedQuantity).toBe('6');
    });
  });

  it('fails closed when proportional-exit position evidence is stale', async () => {
    await withLifecycleFixture(async (fixture) => {
      const now = new Date();
      await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}stale-buy`,
        transactionHash: `${fixture.sourceEventPrefix}stale-buy`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'buy',
        quantity: '10',
        eventAt: new Date(now.getTime() - 3_000),
        observedAt: now,
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}stale-buy-confirmed`
      });
      const sourceSell = await recordSourceTradeEvent({
        chain: fixture.chain,
        sourceEventType: 'transaction',
        sourceEventId: `${fixture.sourceEventPrefix}stale-sell`,
        transactionHash: `${fixture.sourceEventPrefix}stale-sell`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'sell',
        quantity: '1',
        eventAt: new Date(now.getTime() - 2_000),
        observedAt: now,
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}stale-sell-confirmed`
      });
      await ensureSignalToken(sourceSell.event.tokenMint, sourceSell.event.chain);
      const signal = await insertSourceTradeSignal({
        sourceTradeId: sourceSell.event.id,
        confidence: 0.9,
        signalScore: 90,
        triggerData: {},
        maxEventAgeMs: 60_000,
        maxPositionEvidenceAgeMs: 60_000,
        now
      });
      const result = await claimSourceSignalForCopyExecution({
        signalId: signal.id,
        targetAccount: fixture.targetAccount,
        executionMode: 'paper',
        maxPositionEvidenceAgeMs: 1,
        now: new Date(Date.now() + 5_000)
      });

      expect(result).toMatchObject({
        execution: null,
        created: false,
        claimed: false,
        reason: 'Source position evidence is stale'
      });
      const [stored] = await query<{ status: string }>(
        'SELECT status FROM signals WHERE id = $1',
        [signal.id]
      );
      expect(stored?.status).toBe('expired');
    });
  });

  it('does not double-count replayed partial Polymarket venue evidence', async () => {
    await withLifecycleFixture(async (fixture) => {
      const now = new Date();
      const source = await recordSourceTradeEvent({
        chain: 'polygon',
        sourceEventType: 'venue_trade',
        sourceEventId: `${fixture.sourceEventPrefix}polymarket-trade`,
        sourceEventIndex: '0',
        transactionHash: `${fixture.sourceEventPrefix}polymarket-settlement`,
        walletAddress: fixture.sourceWallet,
        tokenMint: fixture.tokenMint,
        side: 'buy',
        quantity: '5',
        amountUsd: '2.5',
        priceUsd: '0.5',
        eventAt: new Date(now.getTime() - 2_000),
        observedAt: now,
        confirmationState: 'confirmed',
        confirmationEvidenceId: `${fixture.sourceEventPrefix}polymarket-confirmed`
      });
      await ensureSignalToken(source.event.tokenMint, source.event.chain);
      const signal = await insertSourceTradeSignal({
        sourceTradeId: source.event.id,
        confidence: 0.9,
        signalScore: 90,
        triggerData: {},
        maxEventAgeMs: 60_000,
        maxPositionEvidenceAgeMs: 60_000,
        now
      });
      const claimed = await claimSourceSignalForCopyExecution({
        signalId: signal.id,
        targetAccount: fixture.targetAccount,
        executionMode: 'live',
        requestedQuoteQuantity: '2.5',
        maxPositionEvidenceAgeMs: 60_000,
        now
      });
      await transitionCopyExecution({
        executionId: claimed.execution!.id,
        nextState: 'simulated',
        simulationId: `${fixture.sourceEventPrefix}polymarket-simulation`
      });
      await transitionCopyExecution({
        executionId: claimed.execution!.id,
        nextState: 'submitted',
        submissionType: 'order',
        submissionId: `${fixture.sourceEventPrefix}polymarket-order`,
        nextReconciliationAt: new Date(Date.now() + 1_000)
      });
      const evidence = {
        executionId: claimed.execution!.id,
        evidenceType: 'venue_fill' as const,
        evidenceId: `${fixture.sourceEventPrefix}polymarket-fill-1`,
        baseQuantity: '2',
        quoteLeg: { amount: '1', currency: 'USD' as const },
        priceUsd: '0.5',
        confirmationState: 'confirmed' as const,
        completesExecution: false,
        occurredAt: now
      };
      const first = await recordCopyExecutionEvidence(evidence);
      const replay = await recordCopyExecutionEvidence(evidence);
      const [stored] = await query<{ evidence_count: number; confirmed_quantity: string }>(
        `SELECT
           COUNT(evidence.id)::int AS evidence_count,
           execution.confirmed_base_quantity::text AS confirmed_quantity
         FROM copy_executions execution
         LEFT JOIN copy_execution_evidence evidence ON evidence.execution_id = execution.id
         WHERE execution.id = $1
         GROUP BY execution.confirmed_base_quantity`,
        [claimed.execution!.id]
      );

      expect(first.execution.state).toBe('partially_filled');
      expect(replay.execution.confirmedBaseQuantity).toBe('2');
      expect(stored).toEqual({ evidence_count: 1, confirmed_quantity: '2' });
    }, 'polygon');
  });
});
