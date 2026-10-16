import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../packages/db/src/client.js';
import {
  recordCopyExecutionEvidence,
  recordSourceTradeEvent,
  requestCopyExecution
} from '../../packages/db/src/copy-trade-lifecycle.js';
import { createUser } from '../../packages/db/src/users.js';

/**
 * S4-M3 / ADR-0007.
 *
 * This is intentionally database-backed: the invariant is not just that a
 * query mentions a master column. It is that two source masters can share one
 * fungible tenant position, one master's sell is capped by its own lot, and
 * the aggregate venue row remains the sum that can actually be sold.
 *
 * The integration runner requires a database name ending in `_integration` or
 * `_test`; it is written here but must remain unrun on this environment.
 */

const runId = randomUUID().replace(/-/g, '').slice(0, 12);
const targetAccount = `solana:PAPER${runId}`;
const tokenMint = `solana:Token${runId}`;
const masterA = `solana:MasterA${runId}`;
const masterB = `solana:MasterB${runId}`;
const createdSourceTradeIds: string[] = [];
const createdExecutionIds: string[] = [];
let userId: string | null = null;

async function sourceTrade(input: {
  walletAddress: string;
  side: 'buy' | 'sell';
  quantity: string;
  suffix: string;
}) {
  const result = await recordSourceTradeEvent({
    chain: 'solana',
    sourceEventType: 'transaction',
    sourceEventId: `${runId}-${input.suffix}`,
    transactionHash: `${runId}-${input.suffix}`,
    walletAddress: input.walletAddress,
    tokenMint,
    side: input.side,
    quantity: input.quantity,
    amountUsd: input.quantity,
    priceUsd: '1',
    eventAt: new Date('2026-10-03T00:00:00.000Z'),
    confirmationState: 'confirmed',
    confirmationEvidenceId: `${runId}-${input.suffix}-confirmed`
  });
  createdSourceTradeIds.push(result.event.id);
  return result.event;
}

async function mirror(sourceTradeId: string, quantity: string, evidenceId: string) {
  const requested = await requestCopyExecution({
    sourceTradeId,
    targetAccount,
    userId,
    executionMode: 'paper',
    requestedBaseQuantity: quantity,
    requestedQuoteQuantity: quantity
  });
  createdExecutionIds.push(requested.execution.id);
  const filled = await recordCopyExecutionEvidence({
    executionId: requested.execution.id,
    evidenceType: 'paper_simulation',
    evidenceId,
    baseQuantity: requested.execution.requestedBaseQuantity ?? quantity,
    quoteLeg: { amount: requested.execution.requestedQuoteQuantity ?? quantity, currency: 'USD' },
    priceUsd: '1',
    confirmationState: 'confirmed',
    completesExecution: true,
    occurredAt: new Date('2026-10-03T00:00:01.000Z')
  });
  return { requested: requested.execution, filled };
}

afterAll(async () => {
  if (createdExecutionIds.length > 0) {
    await pool.query(
      `DELETE FROM copy_position_applications WHERE execution_id = ANY($1::uuid[])`,
      [createdExecutionIds]
    );
    await pool.query(
      `DELETE FROM copy_execution_evidence WHERE execution_id = ANY($1::uuid[])`,
      [createdExecutionIds]
    );
    await pool.query(
      `DELETE FROM copy_execution_state_history WHERE execution_id = ANY($1::uuid[])`,
      [createdExecutionIds]
    );
    await pool.query(`DELETE FROM copy_executions WHERE id = ANY($1::uuid[])`, [createdExecutionIds]);
  }
  if (createdSourceTradeIds.length > 0) {
    await pool.query(
      `DELETE FROM source_position_applications WHERE source_trade_id = ANY($1::uuid[])`,
      [createdSourceTradeIds]
    );
    await pool.query(
      `DELETE FROM source_trade_confirmation_history WHERE source_trade_id = ANY($1::uuid[])`,
      [createdSourceTradeIds]
    );
    await pool.query(`DELETE FROM source_trades WHERE id = ANY($1::uuid[])`, [createdSourceTradeIds]);
  }
  await pool.query(
    `DELETE FROM copy_position_lots
      WHERE target_account = $1 AND chain = 'solana' AND token_mint = $2`,
    [targetAccount, tokenMint]
  );
  await pool.query(
    `DELETE FROM copy_positions
      WHERE target_account = $1 AND chain = 'solana' AND token_mint = $2`,
    [targetAccount, tokenMint]
  );
  if (userId) {
    await pool.query(`DELETE FROM audit_log WHERE actor_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
});

describe('master-attributed copy inventory', () => {
  it('keeps one master sell from consuming another master lot', async () => {
    const user = await createUser({
      email: `s4-m3-${runId}@example.com`,
      password: 'a-very-long-password',
      tier: 'free'
    });
    userId = user.id;

    const [buyA, buyB] = await Promise.all([
      sourceTrade({ walletAddress: masterA, side: 'buy', quantity: '100', suffix: 'buy-a' }),
      sourceTrade({ walletAddress: masterB, side: 'buy', quantity: '200', suffix: 'buy-b' })
    ]);
    await mirror(buyA.id, '100', `${runId}-copy-buy-a`);
    await mirror(buyB.id, '200', `${runId}-copy-buy-b`);

    const sourceSellA = await sourceTrade({
      walletAddress: masterA,
      side: 'sell',
      quantity: '100',
      suffix: 'sell-a'
    });
    const sell = await requestCopyExecution({
      sourceTradeId: sourceSellA.id,
      targetAccount,
      userId,
      executionMode: 'paper',
      requestedBaseQuantity: '150'
    });
    createdExecutionIds.push(sell.execution.id);

    // The request exceeds master A's 100-token lot, even though the aggregate
    // venue position contains 300 tokens. Sizing must cap at A's lot.
    expect(sell.execution.requestedBaseQuantity).toBe('100');
    await recordCopyExecutionEvidence({
      executionId: sell.execution.id,
      evidenceType: 'paper_simulation',
      evidenceId: `${runId}-copy-sell-a`,
      baseQuantity: '100',
      quoteLeg: { amount: '100', currency: 'USD' },
      priceUsd: '1',
      confirmationState: 'confirmed',
      completesExecution: true,
      occurredAt: new Date('2026-10-03T00:00:02.000Z')
    });

    const { rows: lots } = await pool.query<{
      master_wallet_address: string;
      confirmed_quantity: string;
    }>(
      `SELECT master_wallet_address, confirmed_quantity::text AS confirmed_quantity
         FROM copy_position_lots
        WHERE target_account = $1 AND user_id = $2 AND chain = 'solana' AND token_mint = $3
        ORDER BY master_wallet_address`,
      [targetAccount, userId, tokenMint]
    );
    expect(lots).toEqual([
      { master_wallet_address: masterA, confirmed_quantity: '0' },
      { master_wallet_address: masterB, confirmed_quantity: '200' }
    ]);

    const { rows: aggregate } = await pool.query<{ confirmed_quantity: string }>(
      `SELECT confirmed_quantity::text AS confirmed_quantity
         FROM copy_positions
        WHERE target_account = $1 AND user_id = $2 AND chain = 'solana' AND token_mint = $3`,
      [targetAccount, userId, tokenMint]
    );
    expect(aggregate[0]?.confirmed_quantity).toBe('200');
  });
});
