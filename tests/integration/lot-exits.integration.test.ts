import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../../packages/db/src/client.js';
import {
  claimLotExitExecution,
  recordCopyExecutionEvidence,
  recordSourceTradeEvent,
  requestCopyExecution
} from '../../packages/db/src/copy-trade-lifecycle.js';

const runId = randomUUID();
const hex = runId.replaceAll('-', '');
const target = `robinhood-chain:0x${hex}00000001`;
const master = `robinhood-chain:0x${hex}00000002`;
const token = `robinhood-chain:0x${hex}00000003`;
const executionIds: string[] = [];
const sourceIds: string[] = [];
const occurredAt = new Date('2026-10-01T00:00:00Z');

  const sourceEventId = `${runId}:${randomUUID()}`;
  const source = await recordSourceTradeEvent({
    chain: 'robinhood-chain', sourceEventType: 'transaction',
    sourceEventId, transactionHash: sourceEventId, walletAddress: master,
    tokenMint: token, side: 'buy', quantity, amountUsd: Number(quantity) * 10,
    eventAt: occurredAt, confirmationState: 'confirmed', confirmationEvidenceId: randomUUID()
  });
  sourceIds.push(source.event.id);
  const { execution } = await requestCopyExecution({
    sourceTradeId: source.event.id, targetAccount: target,
    executionMode: 'paper', requestedBaseQuantity: quantity
  });
  executionIds.push(execution.id);
  await recordCopyExecutionEvidence({
    executionId: execution.id, evidenceType: 'paper_simulation', evidenceId: execution.clientOrderId,
    baseQuantity: quantity, quoteLeg: { currency: 'USD', amount: Number(quantity) * 10 },
    confirmationState: 'confirmed', completesExecution: true, occurredAt
  });
  const lot = await pool.query<{ id: string }>(
    'SELECT id FROM copy_position_master_lots WHERE acquisition_execution_id = $1', [execution.id]
  );
  return lot.rows[0].id;
}

async function claim(lotId: string, requestId = randomUUID(), quantity?: string) {
  const result = await claimLotExitExecution({
    lotId, userId: null, requestId, trigger: 'manual', requestedBaseQuantity: quantity
  });
  if (!executionIds.includes(result.execution.id)) executionIds.push(result.execution.id);
  return result;
}

async function fill(executionId: string, quantity: string, evidenceId = randomUUID(), completes = true) {
  const input = {
    executionId, evidenceId, evidenceType: 'paper_simulation' as const,
    baseQuantity: quantity, quoteLeg: { currency: 'USD' as const, amount: Number(quantity) * 12 },
    confirmationState: 'confirmed' as const, completesExecution: completes,
    occurredAt: new Date('2026-10-01T00:01:00Z')
  };
  return { input, result: await recordCopyExecutionEvidence(input) };
}

async function remaining(lotId: string) {
  const result = await pool.query<{ quantity: string }>(
    'SELECT remaining_quantity::text AS quantity FROM copy_position_master_lots WHERE id = $1', [lotId]
  );
  return Number(result.rows[0].quantity);
}

afterAll(async () => {
  await pool.query('DELETE FROM copy_position_master_lot_reductions WHERE sell_execution_id = ANY($1)', [executionIds]);
  await pool.query('DELETE FROM copy_position_applications WHERE execution_id = ANY($1)', [executionIds]);
  await pool.query('DELETE FROM copy_execution_evidence WHERE execution_id = ANY($1) AND execution_id IN (SELECT id FROM copy_executions WHERE exit_lot_id IS NOT NULL)', [executionIds]);
  await pool.query('DELETE FROM copy_execution_state_history WHERE execution_id = ANY($1)', [executionIds]);
  await pool.query('DELETE FROM copy_executions WHERE id = ANY($1) AND exit_lot_id IS NOT NULL', [executionIds]);
  await pool.query('DELETE FROM copy_position_master_lots WHERE acquisition_execution_id = ANY($1)', [executionIds]);
  await pool.query('DELETE FROM copy_execution_evidence WHERE execution_id = ANY($1)', [executionIds]);
  await pool.query('DELETE FROM copy_executions WHERE id = ANY($1)', [executionIds]);
  await pool.query('DELETE FROM copy_positions WHERE target_account = $1', [target]);
  await pool.query('DELETE FROM source_position_applications WHERE source_trade_id = ANY($1)', [sourceIds]);
  await pool.query('DELETE FROM source_trade_confirmation_history WHERE source_trade_id = ANY($1)', [sourceIds]);
  await pool.query('DELETE FROM source_trades WHERE id = ANY($1)', [sourceIds]);
  await pool.query('DELETE FROM wallet_positions WHERE wallet_address = $1', [master]);
});

describe('canonical lot exits', () => {
  it('claims exactly one execution concurrently and reserves the original paper inventory', async () => {
    const lotId = await acquire('10');
    const requestId = randomUUID();
    const results = await Promise.all([claim(lotId, requestId), claim(lotId, requestId)]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results[0].execution.id).toBe(results[1].execution.id);
    expect(results[0].execution).toMatchObject({
      sourceTradeId: null, exitLotId: lotId, exitTrigger: 'manual',
      executionMode: 'paper', targetAccount: target, requestedBaseQuantity: '10', reservedBaseQuantity: '10'
    });
    await expect(claim(lotId)).rejects.toThrow();
    await fill(results[0].execution.id, '10');
    expect(await remaining(lotId)).toBe(0);
  });

  it('reduces only the specified lot and is unchanged by partial-fill evidence replay', async () => {
    const lotA = await acquire('5');
    const lotB = await acquire('7');
    const exit = await claim(lotB);
    const { input } = await fill(exit.execution.id, '3', randomUUID(), false);
    await recordCopyExecutionEvidence(input);
    expect(await remaining(lotA)).toBe(5);
    expect(await remaining(lotB)).toBe(4);
    await expect(fill(exit.execution.id, '5')).rejects.toThrow('reserved lot inventory');
    expect(await remaining(lotB)).toBe(4);
    await fill(exit.execution.id, '4');
    expect(await remaining(lotB)).toBe(0);
    expect(await remaining(lotA)).toBe(5);
    await expect(claimLotExitExecution({ lotId: lotA, userId: randomUUID(), requestId: randomUUID(), trigger: 'manual' }))
      .rejects.toThrow('owning tenant');
    await fill((await claim(lotA)).execution.id, '5');
  });
});
