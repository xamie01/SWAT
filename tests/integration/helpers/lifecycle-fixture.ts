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

  /**
   * How a `source_trades` row is recognised as this fixture's.
   *
   * A test that stages a row directly controls `source_event_id` and gets the
   * fixture prefix. A test that drives the *real* ingestion path does not: the
   * EVM builders set `sourceEventId` to the transaction hash, so a prefix-only
   * selector silently matches nothing and leaves the run's rows behind.
   *
   * The wallet/token fallback is limited to the EVM chains because their
   * fixture addresses are derived from `runId` and so cannot collide with
   * another run. The Solana fixture reuses three constant addresses, where the
   * same fallback would delete a concurrent run's rows.
   */
  const scopedByAddress = fixture.chain !== 'solana';
  const isFixtureSource = (alias: string): string =>
    scopedByAddress
      ? `(${alias}.source_event_id LIKE $1
           OR (${alias}.wallet_address = $2 AND ${alias}.chain = $3 AND ${alias}.token_mint = $4))`
      : `${alias}.source_event_id LIKE $1`;
  /** Parameters `$1..$4` for any statement built with `isFixtureSource`. */
  const sourceValues = scopedByAddress
    ? [sourcePattern, sourceWallet, fixture.chain, tokenMint]
    : [sourcePattern];

  const cleanupStatements: Array<[string, string, unknown[]]> = [
    [
      'linked trades',
      `DELETE FROM trades trade
       USING source_trades source
       WHERE trade.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      // An exit trade — a stop-loss, or anything else the scorer queues off the
      // position rather than off a source event — carries the signal but no
      // `source_trade_id`, so the delete above cannot see it. Left behind, it
      // holds a foreign key on the signal and blocks the rest of the teardown.
      'signal-attributed trades',
      `DELETE FROM trades trade
       USING signals signal, source_trades source
       WHERE trade.signal_id = signal.id
         AND signal.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'copy position applications',
      `DELETE FROM copy_position_applications application
       USING copy_executions execution, source_trades source
       WHERE application.execution_id = execution.id
         AND execution.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'copy execution evidence',
      `DELETE FROM copy_execution_evidence evidence
       USING copy_executions execution, source_trades source
       WHERE evidence.execution_id = execution.id
         AND execution.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'copy execution history',
      `DELETE FROM copy_execution_state_history history
       USING copy_executions execution, source_trades source
       WHERE history.execution_id = execution.id
         AND execution.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'copy executions',
      `DELETE FROM copy_executions execution
       USING source_trades source
       WHERE execution.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'copy position lots',
      'DELETE FROM copy_position_lots WHERE target_account = $1 AND chain = $2 AND token_mint = $3',
      [targetAccount, fixture.chain, tokenMint]
    ],
    [
      'copy positions',
      'DELETE FROM copy_positions WHERE target_account = $1 AND chain = $2 AND token_mint = $3',
      [targetAccount, fixture.chain, tokenMint]
    ],
    [
      // Must precede the signals delete: the rejection row references signals(id).
      'copy eligibility rejections',
      `DELETE FROM copy_eligibility_rejections rejection
       USING signals signal, source_trades source
       WHERE rejection.signal_id = signal.id
         AND signal.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'source signals',
      `DELETE FROM signals signal
       USING source_trades source
       WHERE signal.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'source position applications',
      `DELETE FROM source_position_applications application
       USING source_trades source
       WHERE application.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'source confirmation history',
      `DELETE FROM source_trade_confirmation_history history
       USING source_trades source
       WHERE history.source_trade_id = source.id
         AND ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'source trades',
      `DELETE FROM source_trades source WHERE ${isFixtureSource('source')}`,
      sourceValues
    ],
    [
      'source positions',
      'DELETE FROM wallet_positions WHERE wallet_address = $1 AND chain = $2 AND token_mint = $3',
      [sourceWallet, fixture.chain, tokenMint]
    ],
    [
      // Only tests that exercise wallet-selection policy create this row, and
      // the address is fixture-scoped. Guarded so a wallet another table still
      // points at is left alone rather than failing the delete on its FK.
      'fixture source wallet',
      `DELETE FROM wallets wallet
       WHERE wallet.address = $1 AND wallet.chain = $2
         AND NOT EXISTS (SELECT 1 FROM cluster_memberships WHERE wallet_address = wallet.address)
         AND NOT EXISTS (SELECT 1 FROM transactions WHERE wallet_address = wallet.address)
         AND NOT EXISTS (SELECT 1 FROM trades WHERE wallet_address = wallet.address)`,
      [sourceWallet, fixture.chain]
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
    // `$1..$4` are the `isFixtureSource` parameters; the address-scoped ones are
    // reused for the position counts, and `$5` is the copy side's account.
    const verifyValues = scopedByAddress
      ? [...sourceValues, targetAccount]
      : [sourcePattern, sourceWallet, fixture.chain, tokenMint, targetAccount];
    const result = await pool.query<{
      source_trades: number;
      copy_executions: number;
      source_positions: number;
      copy_positions: number;
      trades: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM source_trades source
           WHERE ${isFixtureSource('source')}) AS source_trades,
         (SELECT COUNT(*)::int FROM copy_executions execution
           JOIN source_trades source ON source.id = execution.source_trade_id
          WHERE ${isFixtureSource('source')}) AS copy_executions,
         (SELECT COUNT(*)::int FROM wallet_positions
           WHERE wallet_address = $2 AND chain = $3 AND token_mint = $4) AS source_positions,
         (SELECT COUNT(*)::int FROM copy_positions
           WHERE target_account = $5 AND chain = $3 AND token_mint = $4) AS copy_positions,
         -- Counted on the token rather than through a join: a trade that has lost
         -- every link is precisely the one that blocks migration 030, and a join
         -- through source_trades would be blind to it in exactly that case.
         (SELECT COUNT(*)::int FROM trades
           WHERE token_mint = $4 AND chain = $3) AS trades`,
      verifyValues
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
