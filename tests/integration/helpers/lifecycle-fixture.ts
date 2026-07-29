import { randomUUID } from 'node:crypto';
import { resolveChainAddress, resolveChainValue, type Chain } from '@swat/shared';
import { pool } from '../../../packages/db/src/client.js';

const SOLANA_SOURCE_WALLET = '11111111111111111111111111111111';
const SOLANA_TARGET_ACCOUNT = 'So11111111111111111111111111111111111111112';
const SOLANA_TOKEN_MINT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface LifecycleFixture {
  runId: string;
  chain: Chain;
  sourceEventPrefix: string;
  sourceWallet: string;
  targetAccount: string;
  tokenMint: string;
}

export function createLifecycleFixture(chain: Chain = 'solana'): LifecycleFixture {
  const runId = randomUUID();
  const runHex = runId.replaceAll('-', '');
  const sourceWallet = chain === 'solana'
    ? SOLANA_SOURCE_WALLET
    : `0x${runHex}00000001`;
  const targetAccount = chain === 'solana'
    ? SOLANA_TARGET_ACCOUNT
    : `0x${runHex}00000002`;
  const tokenMint = chain === 'solana'
    ? SOLANA_TOKEN_MINT
    : `0x${runHex}00000003`;
  return {
    runId,
    chain,
    sourceEventPrefix: `it:${runId}:`,
    sourceWallet,
    targetAccount,
    tokenMint
  };
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

async function cleanupLifecycleFixture(fixture: LifecycleFixture): Promise<void> {
  const sourcePattern = `${fixture.sourceEventPrefix}%`;
  const sourceWallet = resolveChainAddress(fixture.sourceWallet, fixture.chain).prefixed;
  const targetAccount = resolveChainAddress(fixture.targetAccount, fixture.chain).prefixed;
  const tokenMint = resolveChainValue(fixture.tokenMint, fixture.chain).prefixed;
  const cleanupStatements: Array<[string, string, unknown[]]> = [
    [
      'linked trades',
      `DELETE FROM trades trade
       USING source_trades source
       WHERE trade.source_trade_id = source.id
         AND source.source_event_id LIKE $1`,
      [sourcePattern]
    ],
    [
      'copy position applications',
      `DELETE FROM copy_position_applications application
       USING copy_executions execution, source_trades source
       WHERE application.execution_id = execution.id
         AND execution.source_trade_id = source.id
         AND source.source_event_id LIKE $1`,
      [sourcePattern]
    ],
    [
      'copy execution evidence',
      `DELETE FROM copy_execution_evidence evidence
       USING copy_executions execution, source_trades source
       WHERE evidence.execution_id = execution.id
         AND execution.source_trade_id = source.id
         AND source.source_event_id LIKE $1`,
      [sourcePattern]
    ],
    [
      'copy execution history',
      `DELETE FROM copy_execution_state_history history
       USING copy_executions execution, source_trades source
       WHERE history.execution_id = execution.id
         AND execution.source_trade_id = source.id
         AND source.source_event_id LIKE $1`,
      [sourcePattern]
    ],
    [
      'copy executions',
      `DELETE FROM copy_executions execution
       USING source_trades source
       WHERE execution.source_trade_id = source.id
         AND source.source_event_id LIKE $1`,
      [sourcePattern]
    ],
    [
      'copy positions',
      'DELETE FROM copy_positions WHERE target_account = $1 AND chain = $2 AND token_mint = $3',
      [targetAccount, fixture.chain, tokenMint]
    ],
    [
      'source signals',
      `DELETE FROM signals signal
       USING source_trades source
       WHERE signal.source_trade_id = source.id
         AND source.source_event_id LIKE $1`,
      [sourcePattern]
    ],
    [
      'source position applications',
      `DELETE FROM source_position_applications application
       USING source_trades source
       WHERE application.source_trade_id = source.id
         AND source.source_event_id LIKE $1`,
      [sourcePattern]
    ],
    [
      'source confirmation history',
      `DELETE FROM source_trade_confirmation_history history
       USING source_trades source
       WHERE history.source_trade_id = source.id
         AND source.source_event_id LIKE $1`,
      [sourcePattern]
    ],
    ['source trades', 'DELETE FROM source_trades WHERE source_event_id LIKE $1', [sourcePattern]],
    [
      'source positions',
      'DELETE FROM wallet_positions WHERE wallet_address = $1 AND chain = $2 AND token_mint = $3',
      [sourceWallet, fixture.chain, tokenMint]
    ],
    [
      'fixture token',
      `DELETE FROM tokens token
       WHERE token.mint = $1 AND token.chain = $2
         AND NOT EXISTS (SELECT 1 FROM source_trades WHERE token_mint = token.mint)
         AND NOT EXISTS (SELECT 1 FROM signals WHERE token_mint = token.mint)
         AND NOT EXISTS (SELECT 1 FROM trades WHERE token_mint = token.mint)
         AND NOT EXISTS (
           SELECT 1 FROM transactions
           WHERE target_token = token.mint OR token_in = token.mint OR token_out = token.mint
         )`,
      [tokenMint, fixture.chain]
    ]
  ];
  const failures: Error[] = [];

  for (const [label, statement, values] of cleanupStatements) {
    try {
      await pool.query(statement, values);
    } catch (error) {
      failures.push(new Error(`Failed to clean ${label}`, { cause: asError(error) }));
    }
  }

  try {
    const result = await pool.query<{
      source_trades: number;
      copy_executions: number;
      source_positions: number;
      copy_positions: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM source_trades WHERE source_event_id LIKE $1) AS source_trades,
         (SELECT COUNT(*)::int FROM copy_executions execution
           JOIN source_trades source ON source.id = execution.source_trade_id
          WHERE source.source_event_id LIKE $1) AS copy_executions,
         (SELECT COUNT(*)::int FROM wallet_positions
           WHERE wallet_address = $2 AND chain = $3 AND token_mint = $4) AS source_positions,
         (SELECT COUNT(*)::int FROM copy_positions
           WHERE target_account = $5 AND chain = $3 AND token_mint = $4) AS copy_positions`,
      [sourcePattern, sourceWallet, fixture.chain, tokenMint, targetAccount]
    );
    const leftovers = Object.entries(result.rows[0] ?? {})
      .filter(([, count]) => Number(count) !== 0)
      .map(([table, count]) => `${table}=${count}`);
    if (leftovers.length > 0) {
      failures.push(new Error(`Lifecycle fixture cleanup left rows: ${leftovers.join(', ')}`));
    }
  } catch (error) {
    failures.push(new Error('Failed to verify lifecycle fixture cleanup', { cause: asError(error) }));
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Lifecycle fixture ${fixture.runId} cleanup failed: ${failures.map((error) => error.message).join('; ')}`
    );
  }
}

export async function withLifecycleFixture(
  operation: (fixture: LifecycleFixture) => Promise<void>,
  chain: Chain = 'solana'
): Promise<void> {
  const fixture = createLifecycleFixture(chain);
  const failures: Error[] = [];
  try {
    await operation(fixture);
  } catch (error) {
    failures.push(asError(error));
  }

  try {
    await cleanupLifecycleFixture(fixture);
  } catch (error) {
    failures.push(asError(error));
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Lifecycle fixture ${fixture.runId} failed: ${failures.map((error) => error.message).join('; ')}`
    );
  }
}
