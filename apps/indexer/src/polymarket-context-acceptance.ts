import { randomBytes } from 'node:crypto';
import {
  closePool,
  getPolymarketOutcomeContext,
  insertParsedTransaction,
  query,
  recordConfirmedPolymarketTrade,
  upsertPolymarketContext,
  upsertToken,
  upsertWallet
} from '@swat/db';
import { prefixChainValue } from '@swat/shared';
import {
  assertPolymarketCertificationBatch,
  type ConfirmedPolymarketTrade
} from './polymarket-helpers.js';

const POLYMARKET_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

export async function runPolymarketContextAcceptance(): Promise<void> {
  const conditionId = `0x${randomBytes(32).toString('hex')}`;
  const transactionHash = `0x${randomBytes(32).toString('hex')}`;
  const proxyWallet = `0x${randomBytes(20).toString('hex')}`;
  const tokenYes = BigInt(`0x${randomBytes(31).toString('hex')}`).toString();
  const tokenNo = BigInt(`0x${randomBytes(31).toString('hex')}`).toString();
  const now = new Date();
  const timestamp = new Date(now.getTime() - 30_000);
  const trade: ConfirmedPolymarketTrade = {
    proxyWallet,
    timestamp,
    conditionId,
    asset: tokenYes,
    size: 2,
    price: 0.5,
    side: 'BUY',
    transactionHash,
    outcome: 'Yes',
    title: 'Will the Polymarket context acceptance pass?'
  };
  const walletAddress = prefixChainValue(proxyWallet, 'polygon');
  const tokenIds = [tokenYes, tokenNo].map((tokenId) => prefixChainValue(tokenId, 'polygon'));
  let primaryError: unknown;
  let passSummary: Record<string, unknown> | null = null;

  try {
    await upsertWallet({
      address: proxyWallet,
      chain: 'polygon',
      source: 'discovered',
      discoveryMethod: 'polymarket-context-acceptance'
    });
    await upsertToken(POLYMARKET_USDC, {
      chain: 'polygon',
      decimals: 6,
      symbol: 'USDC',
      name: 'USD Coin'
    });
    await upsertPolymarketContext({
      conditionId,
      question: trade.title,
      slug: `acceptance-${conditionId.slice(2, 10)}`,
      endDate: new Date(now.getTime() + 86_400_000),
      resolutionSource: 'acceptance-fixture',
      outcomeCount: 2,
      clobTokenIds: [tokenYes, tokenNo],
      status: 'active',
      tickSize: '0.01',
      negRisk: false,
      acceptingOrders: true,
      resolutionStatus: 'unresolved',
      outcomes: [
        { tokenId: tokenYes, outcome: 'Yes', outcomeIndex: 0 },
        { tokenId: tokenNo, outcome: 'No', outcomeIndex: 1 }
      ]
    });

    const sourceTrade = {
      transactionHash,
      proxyWallet,
      asset: tokenYes,
      conditionId,
      side: 'BUY' as const,
      size: '2',
      price: '0.5',
      timestamp
    };
    const firstSourceInsert = await recordConfirmedPolymarketTrade(sourceTrade);
    const duplicateSourceInsert = await recordConfirmedPolymarketTrade(sourceTrade);
    if (!firstSourceInsert || duplicateSourceInsert) {
      throw new Error('Confirmed Polymarket source-trade deduplication failed');
    }

    const transactionPayload = {
      chain: 'polygon' as const,
      signature: transactionHash,
      walletAddress: proxyWallet,
      tokenIn: POLYMARKET_USDC,
      tokenOut: tokenYes,
      amountIn: '1000000',
      amountOut: '2000000',
      amountInUsd: 1,
      amountOutUsd: 1,
      direction: 'buy' as const,
      targetToken: tokenYes,
      programId: 'polymarket-data-api',
      timestamp,
      blockTime: Math.floor(timestamp.getTime() / 1000)
    };
    const firstTransactionInsert = await insertParsedTransaction(transactionPayload);
    const duplicateTransactionInsert = await insertParsedTransaction(transactionPayload);
    if (!firstTransactionInsert || duplicateTransactionInsert) {
      throw new Error('Derived Polymarket transaction deduplication failed');
    }

    const context = await getPolymarketOutcomeContext(tokenYes);
    if (
      !context
      || context.tokenId !== tokenIds[0]
      || context.conditionId !== conditionId
      || context.outcome !== 'Yes'
      || context.question !== trade.title
      || context.marketStatus !== 'active'
      || Number(context.tickSize) !== 0.01
      || context.negRisk !== false
      || context.resolutionStatus !== 'unresolved'
      || !context.contextComplete
    ) {
      throw new Error(`Persisted Polymarket context mismatch: ${JSON.stringify(context)}`);
    }

    const certification = assertPolymarketCertificationBatch({
      trades: [trade],
      mappedTokenIds: [tokenYes],
      now,
      maxLagSeconds: 300
    });
    const [counts] = await query<{
      source_trades: string;
      transactions: string;
      outcomes: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM polymarket_trades WHERE transaction_hash = $1) AS source_trades,
         (SELECT COUNT(*) FROM transactions WHERE chain = 'polygon' AND signature = $1) AS transactions,
         (SELECT COUNT(*) FROM polymarket_outcomes WHERE condition_id = $2) AS outcomes`,
      [transactionHash, conditionId]
    );
    if (
      Number(counts?.source_trades) !== 1
      || Number(counts?.transactions) !== 1
      || Number(counts?.outcomes) !== 2
    ) {
      throw new Error(`Polymarket acceptance row counts mismatch: ${JSON.stringify(counts)}`);
    }

    passSummary = {
      conditionId,
      transactionHash,
      proxyWallet: walletAddress,
      asset: context.tokenId,
      outcome: context.outcome,
      marketState: context.marketStatus,
      contextCoverage: certification.contextCoverage,
      lagSeconds: certification.lagSeconds,
      sourceTrades: Number(counts.source_trades),
      transactions: Number(counts.transactions),
      outcomes: Number(counts.outcomes)
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: Error[] = [];
  const cleanupStep = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(new Error(`Polymarket context cleanup failed: ${label}`, { cause: error }));
    }
  };

  await cleanupStep('delete derived transactions', () =>
    query('DELETE FROM transactions WHERE signature = $1', [transactionHash]));
  await cleanupStep('delete confirmed source trades', () =>
    query('DELETE FROM polymarket_trades WHERE transaction_hash = $1', [transactionHash]));
  await cleanupStep('delete outcome mappings', () =>
    query('DELETE FROM polymarket_outcomes WHERE condition_id = $1', [conditionId]));
  await cleanupStep('delete outcome tokens', () =>
    query('DELETE FROM tokens WHERE mint = ANY($1::varchar[])', [tokenIds]));
  await cleanupStep('delete market context', () =>
    query('DELETE FROM polymarket_markets WHERE condition_id = $1', [conditionId]));
  await cleanupStep('delete proxy wallet', () =>
    query('DELETE FROM wallets WHERE address = $1', [walletAddress]));
  await cleanupStep('verify fixture cleanup', async () => {
    const [counts] = await query<{
      source_trades: string;
      transactions: string;
      outcomes: string;
      markets: string;
      wallets: string;
      tokens: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM polymarket_trades WHERE transaction_hash = $1) AS source_trades,
         (SELECT COUNT(*) FROM transactions WHERE signature = $1) AS transactions,
         (SELECT COUNT(*) FROM polymarket_outcomes WHERE condition_id = $2) AS outcomes,
         (SELECT COUNT(*) FROM polymarket_markets WHERE condition_id = $2) AS markets,
         (SELECT COUNT(*) FROM wallets WHERE address = $3) AS wallets,
         (SELECT COUNT(*) FROM tokens WHERE mint = ANY($4::varchar[])) AS tokens`,
      [transactionHash, conditionId, walletAddress, tokenIds]
    );
    if (!counts || Object.values(counts).some((count) => Number(count) !== 0)) {
      throw new Error(`Polymarket acceptance fixtures remain: ${JSON.stringify(counts)}`);
    }
  });
  await cleanupStep('close PostgreSQL pool', () => closePool());

  const errors = [primaryError, ...cleanupErrors].filter((error) => error !== undefined);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Polymarket context acceptance encountered multiple failures');
  }
  console.log('[POLYMARKET-CONTEXT] PASS', JSON.stringify(passSummary));
}
