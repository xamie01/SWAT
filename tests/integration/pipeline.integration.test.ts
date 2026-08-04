import { afterAll, describe, expect, it } from 'vitest';
import { resolveChainAddress, resolveChainValue, type Chain } from '@swat/shared';
import {
  claimSourceSignalForCopyExecution,
  closePool,
  insertSourceTradeSignal,
  listSourceTradeSignalCandidates,
  markSourceTradeSignalDispatched,
  markToMarketOpenPositions,
  pool,
  recordCopyExecutionEvidence,
  transitionCopyExecution,
  upsertWallet,
  type SourceTradeSignalCandidate
} from '../../packages/db/src/index.js';
import { parseCanonicalSolanaSwapEvent, type HeliusParsedTransaction } from '../../apps/indexer/src/parse.js';
import {
  persistPolymarketSourceTrade,
  persistRobinhoodSourceTrade,
  persistSolanaSourceTrade
} from '../../apps/indexer/src/source-trade-lifecycle.js';
import { persistTrade } from '../../apps/trade-executor/src/index.js';
import { withLifecycleFixture, type LifecycleFixture } from './helpers/lifecycle-fixture.js';

/**
 * E2 acceptance (`G7-T2`): the production pipeline, per chain, end to end —
 * seed wallet -> backfill -> transactions -> signal -> paper trade ->
 * attribution.
 *
 * Every stage calls the function the running service calls. The one service
 * module that cannot be imported is `apps/signal-engine/src/index.ts`: it opens
 * BullMQ queues and arms `setInterval(tick, 15_000)` at module scope, so
 * importing it starts a second signal engine against the test database. The
 * signal stage therefore drives `listSourceTradeSignalCandidates` ->
 * `insertSourceTradeSignal` -> `markSourceTradeSignalDispatched`, which is
 * exactly what its `enqueueSignal` does either side of the Telegram/BullMQ
 * fan-out. What is skipped is the fan-out and the token-metadata lookup, both
 * of which are network calls that would make this suite flaky in CI.
 *
 * The pipeline runs a **round trip** — canonical entry, then exit — for two
 * reasons: it is the only way attribution can be asserted without a live price
 * feed (a closed position needs no mark), and a buy-only ledger would never
 * exercise the realized-PnL path that the scorer actually reports on.
 *
 * The exit is modelled as the executor's stop-loss exit rather than as a second
 * source trade, because that is the only production shape that closes a
 * *signal's* ledger. A source sell is its own signal with its own canonical
 * execution, and `fk_trades_copy_execution_identity` will not let a trade be
 * attributed to a signal its execution does not belong to — so a source-sell
 * round trip leaves two open one-sided ledgers, not one closed one. A stop-loss
 * exit carries the entry's `signalId` with no `sourceTradeId` and no canonical
 * execution, which is exactly what `apps/trade-executor/src/index.ts` persists
 * when the scorer queues one.
 */

const MAX_EVENT_AGE_MS = 10 * 60_000;
const EVIDENCE_AGE_MS = 10 * 60_000;

/** Buy 100 units at $2, sell them at $3. Realized PnL is therefore $100. */
const BUY_QUANTITY = 100;
const BUY_PRICE_USD = 2;
const SELL_PRICE_USD = 3;
const EXPECTED_REALIZED_PNL_USD = BUY_QUANTITY * (SELL_PRICE_USD - BUY_PRICE_USD);

afterAll(async () => {
  await closePool();
});

/** 32-byte hex derived from the fixture run, so no two runs collide. */
function fixtureHash(fixture: LifecycleFixture, salt: string): string {
  const runHex = fixture.runId.replaceAll('-', '');
  const saltHex = Buffer.from(salt).toString('hex');
  return `0x${(runHex + saltHex).padEnd(64, '0').slice(0, 64)}`;
}

/**
 * Stage 1 — seed. The same call the indexer makes for a `WALLET_ADDRESSES`
 * entry or an API-submitted wallet.
 *
 * The score and `active` status are written separately because `upsertWallet`
 * deliberately does not touch them: scoring is the scorer's job, and the
 * pipeline needs a wallet the candidate query will actually select.
 */
async function seedWallet(fixture: LifecycleFixture): Promise<string> {
  await upsertWallet({
    address: fixture.sourceWallet,
    chain: fixture.chain,
    source: 'manual',
    nickname: `pipeline-${fixture.runId.slice(0, 8)}`
  });
  const address = resolveChainAddress(fixture.sourceWallet, fixture.chain).prefixed;
  await pool.query(
    `UPDATE wallets
        SET status = 'active', composite_score = 92, tier = 'elite',
            total_trades = 40, last_active = NOW()
      WHERE address = $1`,
    [address]
  );
  return address;
}

/**
 * Stage 2 — backfill into canonical source trades, through each chain's real
 * ingestion path. The three differ in more than naming: Solana parses a raw
 * Helius transaction into a swap event, Polymarket takes a confirmed Data API
 * fill, and Robinhood Chain takes a decoded log.
 */
async function ingestSourceTrade(fixture: LifecycleFixture, eventAt: Date): Promise<string> {
  const label = `${fixture.sourceEventPrefix}buy`;

  if (fixture.chain === 'solana') {
    const wallet = fixture.sourceWallet;
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const quote = String(BUY_QUANTITY * BUY_PRICE_USD * 1_000_000);
    const base = String(BUY_QUANTITY);
    // A buy moves USDC out of the wallet and the target token in.
    const transaction: HeliusParsedTransaction = {
      slot: 1,
      blockTime: Math.floor(eventAt.getTime() / 1000),
      transaction: { signatures: [label] },
      meta: {
        preTokenBalances: [
          { owner: wallet, mint: usdc, uiTokenAmount: { amount: quote } },
          { owner: wallet, mint: fixture.tokenMint, uiTokenAmount: { amount: '0' } }
        ],
        postTokenBalances: [
          { owner: wallet, mint: usdc, uiTokenAmount: { amount: '0' } },
          { owner: wallet, mint: fixture.tokenMint, uiTokenAmount: { amount: base } }
        ]
      }
    };

    const event = parseCanonicalSolanaSwapEvent(transaction, wallet);
    if (!event) throw new Error('indexer refused to parse the staged Solana swap');
    expect(event.direction).toBe('buy');
    const persisted = await persistSolanaSourceTrade({ event, source: 'solana-backfill' });
    return persisted.event.id;
  }

  if (fixture.chain === 'polygon') {
    const persisted = await persistPolymarketSourceTrade({
      trade: {
        proxyWallet: fixture.sourceWallet,
        timestamp: eventAt,
        conditionId: fixtureHash(fixture, 'condition-buy'),
        asset: fixture.tokenMint,
        size: BUY_QUANTITY,
        // Polymarket prices are probabilities, so the entry is 20c rather than
        // the $2 the other chains use.
        price: 0.2,
        side: 'BUY',
        transactionHash: fixtureHash(fixture, 'tx-buy'),
        outcome: 'Yes',
        title: 'pipeline integration market'
      },
      quantity: String(BUY_QUANTITY),
      amountUsd: BUY_QUANTITY * 0.2
    });
    return persisted.event.id;
  }

  const persisted = await persistRobinhoodSourceTrade({
    transactionHash: fixtureHash(fixture, 'tx-buy'),
    walletAddress: fixture.sourceWallet,
    tokenMint: fixture.tokenMint,
    side: 'buy',
    quantity: String(BUY_QUANTITY),
    eventAt,
    blockNumber: 1_000n
  });
  return persisted.event.id;
}

/**
 * Stage 3 — signal. `listSourceTradeSignalCandidates` is the gate the signal
 * engine polls on; a source trade that does not surface here never becomes a
 * signal, so the candidate is asserted rather than assumed.
 */
async function deriveSignal(
  fixture: LifecycleFixture,
  sourceTradeId: string
): Promise<{ signalId: string; candidate: SourceTradeSignalCandidate }> {
  await pool.query(
    'INSERT INTO tokens (mint, chain) VALUES ($1, $2) ON CONFLICT (mint) DO NOTHING',
    [resolveChainValue(fixture.tokenMint, fixture.chain).prefixed, fixture.chain]
  );

  const candidates = await listSourceTradeSignalCandidates({
    sourceTradeId,
    maxEventAgeMs: MAX_EVENT_AGE_MS,
    limit: 1
  });
  expect(candidates).toHaveLength(1);
  const candidate = candidates[0]!;
  expect(candidate.chain).toBe(fixture.chain);

  const signal = await insertSourceTradeSignal({
    sourceTradeId: candidate.sourceTradeId,
    clusterId: candidate.clusterId,
    confidence: candidate.clusterConfidence,
    signalScore: candidate.walletScore,
    triggerData: {
      sourceWallet: candidate.walletAddress,
      sourceQuantity: candidate.quantity,
      sourceEventAt: candidate.eventAt.toISOString()
    },
    maxEventAgeMs: MAX_EVENT_AGE_MS,
    maxPositionEvidenceAgeMs: EVIDENCE_AGE_MS
  });
  expect(await markSourceTradeSignalDispatched(signal.id)).toBe(true);

  // The engine hands off exactly once; a second poll must not re-emit it.
  const afterDispatch = await listSourceTradeSignalCandidates({
    sourceTradeId,
    maxEventAgeMs: MAX_EVENT_AGE_MS,
    limit: 1
  });
  expect(afterDispatch).toHaveLength(0);

  return { signalId: signal.id, candidate };
}

/**
 * Stage 4 — paper trade. The canonical claim, the simulate/submit transitions,
 * the venue evidence that moves the copy position, and the `trades` row the
 * dashboard and the scorer read from.
 */
async function executePaperEntry(
  fixture: LifecycleFixture,
  input: { signalId: string; sourceTradeId: string }
): Promise<string> {
  const claimed = await claimSourceSignalForCopyExecution({
    signalId: input.signalId,
    targetAccount: fixture.targetAccount,
    executionMode: 'paper',
    requestedBaseQuantity: String(BUY_QUANTITY),
    maxPositionEvidenceAgeMs: EVIDENCE_AGE_MS
  });
  expect(claimed.execution, claimed.reason).not.toBeNull();
  const executionId = claimed.execution!.id;
  expect(claimed.execution!.direction).toBe('buy');

  await transitionCopyExecution({
    executionId,
    nextState: 'simulated',
    simulationId: `${fixture.sourceEventPrefix}sim-buy`
  });
  await transitionCopyExecution({
    executionId,
    nextState: 'submitted',
    submissionType: 'order',
    submissionId: `${fixture.sourceEventPrefix}submit-buy`,
    nextReconciliationAt: new Date(Date.now() + 30_000)
  });

  const amountUsd = BUY_QUANTITY * BUY_PRICE_USD;
  const settled = await recordCopyExecutionEvidence({
    executionId,
    evidenceType: 'paper_simulation',
    evidenceId: `${fixture.sourceEventPrefix}fill-buy`,
    baseQuantity: String(BUY_QUANTITY),
    quoteQuantity: String(amountUsd),
    priceUsd: String(BUY_PRICE_USD),
    confirmationState: 'finalized',
    completesExecution: true,
    occurredAt: new Date()
  });
  expect(settled.execution.state).toBe('confirmed');

  // Prices and USD amounts are passed explicitly: left out, `persistTrade`
  // reaches for a live price feed, which has no place in an integration run.
  await persistTrade({
    signalId: input.signalId,
    sourceTradeId: input.sourceTradeId,
    copyExecutionId: executionId,
    tokenMint: resolveChainValue(fixture.tokenMint, fixture.chain).prefixed,
    size: amountUsd,
    chain: fixture.chain,
    executionMode: 'paper',
    direction: 'buy',
    executor: 'pipeline-entry',
    amountUsd,
    tokenAmount: BUY_QUANTITY,
    priceUsd: BUY_PRICE_USD,
    feeUsd: 0
  });

  return executionId;
}

/**
 * Stage 5 — exit, shaped exactly as the executor's stop-loss job persists one:
 * the entry's `signalId`, no `sourceTradeId`, and no canonical execution, since
 * the scorer queues it off the position ledger rather than off a source trade.
 */
async function exitPosition(fixture: LifecycleFixture, signalId: string): Promise<void> {
  const amountUsd = BUY_QUANTITY * SELL_PRICE_USD;
  await persistTrade({
    signalId,
    sourceTradeId: null,
    copyExecutionId: null,
    tokenMint: resolveChainValue(fixture.tokenMint, fixture.chain).prefixed,
    size: amountUsd,
    chain: fixture.chain,
    executionMode: 'paper',
    direction: 'sell',
    executor: 'pipeline-exit',
    amountUsd,
    tokenAmount: BUY_QUANTITY,
    priceUsd: SELL_PRICE_USD,
    feeUsd: 0
  });
}

const CHAINS: Chain[] = ['solana', 'polygon', 'robinhood-chain'];

describe.each(CHAINS)('production pipeline on %s', (chain) => {
  it('carries a seeded wallet through to attributed PnL', async () => {
    await withLifecycleFixture(async (fixture) => {
      const walletAddress = await seedWallet(fixture);

      // ── backfill and signal ────────────────────────────────────────────
      const sourceTradeId = await ingestSourceTrade(fixture, new Date(Date.now() - 20_000));
      const { signalId, candidate } = await deriveSignal(fixture, sourceTradeId);
      expect(candidate.walletAddress).toBe(walletAddress);
      expect(candidate.side).toBe('buy');

      // ── entry ──────────────────────────────────────────────────────────
      const executionId = await executePaperEntry(fixture, { signalId, sourceTradeId });

      const position = await pool.query<{ confirmed_quantity: string; cost_basis_usd: string }>(
        `SELECT confirmed_quantity, cost_basis_usd FROM copy_positions
          WHERE target_account = $1 AND chain = $2 AND token_mint = $3`,
        [
          resolveChainAddress(fixture.targetAccount, chain).prefixed,
          chain,
          resolveChainValue(fixture.tokenMint, chain).prefixed
        ]
      );
      expect(Number(position.rows[0]?.confirmed_quantity)).toBe(BUY_QUANTITY);
      expect(Number(position.rows[0]?.cost_basis_usd)).toBe(BUY_QUANTITY * BUY_PRICE_USD);

      // The trade the dashboard reads carries the execution identity, so a
      // reader can get from a filled row back to the evidence behind it.
      const tradeRows = await pool.query<{ copy_execution_id: string | null; direction: string }>(
        'SELECT copy_execution_id, direction FROM trades WHERE signal_id = $1 ORDER BY executed_at',
        [signalId]
      );
      expect(tradeRows.rows).toHaveLength(1);
      expect(tradeRows.rows[0]?.copy_execution_id).toBe(executionId);

      // ── exit ───────────────────────────────────────────────────────────
      await exitPosition(fixture, signalId);

      // ── attribution ────────────────────────────────────────────────────
      // The ledger is closed, so the mark resolves without a live price.
      const marked = await markToMarketOpenPositions(signalId);
      expect(marked.updated).toBe(1);

      const { rows } = await pool.query<{
        pnl_usd: string | null;
        realized_pnl_usd: string | null;
        unrealized_pnl_usd: string | null;
      }>(
        'SELECT pnl_usd, realized_pnl_usd, unrealized_pnl_usd FROM signals WHERE id = $1',
        [signalId]
      );
      expect(Number(rows[0]?.realized_pnl_usd)).toBeCloseTo(EXPECTED_REALIZED_PNL_USD, 6);
      expect(Number(rows[0]?.unrealized_pnl_usd)).toBeCloseTo(0, 6);
      expect(Number(rows[0]?.pnl_usd)).toBeCloseTo(EXPECTED_REALIZED_PNL_USD, 6);
    }, chain);
  });
});
