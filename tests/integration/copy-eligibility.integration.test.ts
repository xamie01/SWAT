import { afterAll, describe, expect, it } from 'vitest';
import { resolveChainAddress } from '@swat/shared';
import {
  claimSourceSignalForCopyExecution,
  closePool,
  insertSourceTradeSignal,
  loadCopyEligibilityFacts,
  pool,
  recordCopyEligibilityRejection,
  recordSourceTradeEvent
} from '../../packages/db/src/index.js';
import {
  COPY_ELIGIBILITY_ACCOUNT,
  enforceCopyEligibility,
  type CopyEligibilityThresholds
} from '../../apps/trade-executor/src/copy-eligibility.js';
import { withLifecycleFixture, type LifecycleFixture } from './helpers/lifecycle-fixture.js';

/**
 * C2 acceptance: a signal whose source wallet is no longer selected must be
 * rejected with a durable reason and must never reach the canonical claim.
 *
 * The gap this covers is a timing one. The signal-engine only emits candidates
 * for wallets that are `active`, but the nightly scorer sweep pauses
 * underperformers — so a signal queued before the sweep and executed after it
 * would copy a wallet we had already dropped.
 */

const THRESHOLDS: CopyEligibilityThresholds = {
  maxEventAgeMs: 10 * 60_000,
  maxClockSkewMs: 30_000,
  minimumSourceActivityUsd: 0,
  minimumSourceTradeCount: 3,
  activityLookbackMs: 30 * 24 * 60 * 60_000
};

const dependencies = {
  loadFacts: loadCopyEligibilityFacts,
  recordRejection: recordCopyEligibilityRejection,
  thresholds: THRESHOLDS
};

afterAll(async () => {
  await closePool();
});

/**
 * Stage a fresh, confirmed source event and its derived signal, plus a
 * `wallets` row in the requested selection state.
 */
async function stageSourceSignal(
  fixture: LifecycleFixture,
  wallet: { status: string; totalTrades: number }
): Promise<{ signalId: string; walletAddress: string }> {
  const walletAddress = resolveChainAddress(fixture.sourceWallet, fixture.chain).prefixed;
  await pool.query(
    `INSERT INTO wallets (address, chain, source, status, total_trades, composite_score, last_active)
     VALUES ($1, $2, 'manual', $3, $4, 88, NOW())
     ON CONFLICT (address) DO UPDATE
       SET status = EXCLUDED.status,
           total_trades = EXCLUDED.total_trades,
           composite_score = EXCLUDED.composite_score,
           last_active = EXCLUDED.last_active`,
    [walletAddress, fixture.chain, wallet.status, wallet.totalTrades]
  );

  const eventAt = new Date(Date.now() - 5_000);
  const source = await recordSourceTradeEvent({
    chain: fixture.chain,
    sourceEventType: 'transaction',
    sourceEventId: `${fixture.sourceEventPrefix}policy-buy`,
    transactionHash: `${fixture.sourceEventPrefix}policy-buy`,
    walletAddress: fixture.sourceWallet,
    tokenMint: fixture.tokenMint,
    side: 'buy',
    quantity: '10',
    amountUsd: '2500',
    priceUsd: '250',
    eventAt,
    observedAt: eventAt,
    confirmationState: 'finalized',
    confirmationEvidenceId: `${fixture.sourceEventPrefix}policy-finalized`
  });
  // signals.token_mint references tokens(mint); the source event does not
  // create the token row.
  await pool.query(
    `INSERT INTO tokens (mint, chain) VALUES ($1, $2) ON CONFLICT (mint) DO NOTHING`,
    [source.event.tokenMint, source.event.chain]
  );
  const signal = await insertSourceTradeSignal({
    sourceTradeId: source.event.id,
    confidence: 90,
    signalScore: 90,
    triggerData: { reason: 'copy-eligibility integration' },
    maxEventAgeMs: 10 * 60_000,
    maxPositionEvidenceAgeMs: 10 * 60_000
  });
  return { signalId: signal.id, walletAddress };
}

describe('copy eligibility at the canonical claim boundary', () => {
  it('lets a selected, active source wallet through to the claim', async () => {
    await withLifecycleFixture(async (fixture) => {
      const { signalId } = await stageSourceSignal(fixture, { status: 'active', totalTrades: 40 });

      const decision = await enforceCopyEligibility(
        { account: COPY_ELIGIBILITY_ACCOUNT, signalId, chain: fixture.chain },
        dependencies
      );
      expect(decision.allowed).toBe(true);

      const claimed = await claimSourceSignalForCopyExecution({
        signalId,
        targetAccount: fixture.targetAccount,
        executionMode: 'paper',
        requestedQuoteQuantity: '100',
        maxPositionEvidenceAgeMs: 10 * 60_000
      });
      expect(claimed.execution).not.toBeNull();
    });
  });

  it('rejects a paused wallet, records the reason, and blocks the claim', async () => {
    await withLifecycleFixture(async (fixture) => {
      const { signalId, walletAddress } = await stageSourceSignal(fixture, {
        status: 'paused',
        totalTrades: 40
      });

      const decision = await enforceCopyEligibility(
        { account: COPY_ELIGIBILITY_ACCOUNT, signalId, chain: fixture.chain },
        dependencies
      );
      expect(decision).toEqual({ allowed: false, reasons: ['source-not-selected'] });

      const { rows } = await pool.query<{
        account: string;
        chain: string;
        wallet_address: string;
        reasons: string[];
      }>(
        `SELECT account, chain, wallet_address, reasons
           FROM copy_eligibility_rejections
          WHERE signal_id = $1`,
        [signalId]
      );
      expect(rows).toEqual([{
        account: 'operator',
        chain: fixture.chain,
        wallet_address: walletAddress,
        reasons: ['source-not-selected']
      }]);

      // The recorded rejection is what makes this stick across a queue retry:
      // the signal is no longer in a claimable status.
      const claimed = await claimSourceSignalForCopyExecution({
        signalId,
        targetAccount: fixture.targetAccount,
        executionMode: 'paper',
        requestedQuoteQuantity: '100',
        maxPositionEvidenceAgeMs: 10 * 60_000
      });
      expect(claimed.execution).toBeNull();
      expect(claimed.reason).toContain('rejected');
    });
  });

  it('rejects a wallet with too little history to have a track record', async () => {
    await withLifecycleFixture(async (fixture) => {
      const { signalId } = await stageSourceSignal(fixture, { status: 'active', totalTrades: 1 });

      const decision = await enforceCopyEligibility(
        { account: COPY_ELIGIBILITY_ACCOUNT, signalId, chain: fixture.chain },
        dependencies
      );
      expect(decision).toEqual({
        allowed: false,
        reasons: ['source-trade-count-below-minimum']
      });

      const claimed = await claimSourceSignalForCopyExecution({
        signalId,
        targetAccount: fixture.targetAccount,
        executionMode: 'paper',
        requestedQuoteQuantity: '100',
        maxPositionEvidenceAgeMs: 10 * 60_000
      });
      expect(claimed.execution).toBeNull();
    });
  });

  it('re-running the policy overwrites the reason rather than duplicating it', async () => {
    await withLifecycleFixture(async (fixture) => {
      const { signalId } = await stageSourceSignal(fixture, { status: 'paused', totalTrades: 1 });

      await enforceCopyEligibility(
        { account: COPY_ELIGIBILITY_ACCOUNT, signalId, chain: fixture.chain },
        dependencies
      );
      await enforceCopyEligibility(
        { account: COPY_ELIGIBILITY_ACCOUNT, signalId, chain: fixture.chain },
        dependencies
      );

      const { rows } = await pool.query<{ reasons: string[] }>(
        `SELECT reasons FROM copy_eligibility_rejections WHERE signal_id = $1`,
        [signalId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reasons).toEqual(expect.arrayContaining([
        'source-not-selected',
        'source-trade-count-below-minimum'
      ]));
    });
  });
});
