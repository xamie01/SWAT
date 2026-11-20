import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('./client.js', () => ({ query: mocks.query }));
import * as risk from './risk-spend-owned.js';

// Faithful bounded SQL protocol fixture, not a PostgreSQL concurrency claim.
// Serializes on the policy row as the caller's transaction does; money stays text.
const policy = { epoch: '3', enabled: true, cap_usd: '100', accounting_ready: true };
let rows: Array<Record<string, unknown>>;
let sqls: string[];
let canonicalUsd: string | null;
let correctionAuthorized: boolean;
function client(): PoolClient {
  return { query: vi.fn(async (sql: string, values: unknown[] = []) => {
    sqls.push(sql);
    if (sql.includes('risk_policy_control')) return { rows: [{ ...policy }] };
    if (sql.includes('FROM copy_execution_valuation_corrections correction')) return { rows: correctionAuthorized ? [{ authorized: true }] : [] };
    if (sql.includes('FROM copy_executions execution')) return { rows: [{ state: 'confirmed', submission_id: 'opaque-submission', confirmed_usd: canonicalUsd, unvalued_count: '0', completes_execution: true }] };
    if (sql.includes('SELECT') && sql.includes('risk_spend_reservations')) return { rows: rows.map(r => ({ ...r })) };
    if (sql.includes('INSERT INTO risk_spend_reservations')) {
      const [account, chain, executionMode, executionId, requestedUsd, policyEpoch] = values;
      const row = { account, chain, execution_mode: executionMode, execution_id: executionId,
        requested_usd: requestedUsd, liability_usd: requestedUsd, confirmed_usd: '0',
        policy_epoch: policyEpoch, state: 'reserved' };
      rows.push(row); return { rows: [row] };
    }
    if (sql.includes('UPDATE risk_spend_reservations')) {
      const row = rows.find(r => r.execution_id === values[3]);
      if (!row) return { rows: [] };
      Object.assign(row, { state: values[4], confirmed_usd: values[5], liability_usd: values[6], valuation_correction_id: values[7] });
      return { rows: [{ ...row }] };
    }
    throw new Error(`Unexpected SQL ${sql}`);
  }) } as unknown as PoolClient;
}
const request = (executionId: string, overrides = {}) => ({
  account: 'operator', chain: 'solana' as const, executionMode: 'live' as const,
  executionId, requestedUsd: '60', policyEpoch: '3', ...overrides
});
const id1 = '00000000-0000-4000-8000-000000000001';
const id2 = '00000000-0000-4000-8000-000000000002';
beforeEach(() => { rows = []; sqls = []; canonicalUsd = null; correctionAuthorized = false; policy.epoch = '3'; policy.enabled = true; mocks.query.mockReset(); });

describe('package19 transactional spending reservations', () => {
  it('reserves 60 of cap 100 while pending and refuses the next 60', async () => {
    const tx = client();
    await expect(risk.reserveRiskSpend(tx, request(id1))).resolves.toMatchObject({ liabilityUsd: '60' });
    await expect(risk.reserveRiskSpend(tx, request(id2))).rejects.toThrow(/cap/i);
    expect(rows).toHaveLength(1);
    expect(sqls[0]).toMatch(/FOR UPDATE/);
    expect(sqls).not.toContain('COMMIT');
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('replays immutable terms without double reserving', async () => {
    const tx = client();
    await risk.reserveRiskSpend(tx, request(id1));
    await risk.reserveRiskSpend(tx, request(id1));
    expect(rows).toHaveLength(1);
    await expect(risk.reserveRiskSpend(tx, request(id1, { requestedUsd: '59' }))).rejects.toThrow(/immutable/i);
  });

  it('retains unknown and partial residual liabilities even after a stop', async () => {
    const tx = client();
    await risk.reserveRiskSpend(tx, request(id1));
    await risk.updateRiskSpendReservation(tx, { ...request(id1), state: 'unknown', confirmedUsd: null });
    expect(rows[0].liability_usd).toBe('60');
    policy.enabled = false;
    canonicalUsd = '20';
    await risk.updateRiskSpendReservation(tx, { ...request(id1), state: 'partial', confirmedUsd: '20' });
    expect(rows[0].liability_usd).toBe('60');
    await expect(risk.reserveRiskSpend(tx, request(id2))).rejects.toThrow(/stopped/i);
  });

  it('cannot release a possibly submitted order as a non-submission', async () => {
    const tx = client();
    await risk.reserveRiskSpend(tx, request(id1));
    await risk.updateRiskSpendReservation(tx, { ...request(id1), state: 'submitted', confirmedUsd: null });
    await expect(risk.updateRiskSpendReservation(tx, { ...request(id1), state: 'released', confirmedUsd: '0', provenNotSubmitted: true }))
      .rejects.toThrow(/submitted/i);
    expect(rows[0].liability_usd).toBe('60');
  });

  it('settles cumulative fills once, rejects reversal, and retains actual spend', async () => {
    const tx = client();
    await risk.reserveRiskSpend(tx, request(id1));
    const update = { ...request(id1), state: 'confirmed' as const, confirmedUsd: '40' };
    canonicalUsd = '40';
    await risk.updateRiskSpendReservation(tx, update);
    await risk.updateRiskSpendReservation(tx, update);
    expect(rows[0].liability_usd).toBe('40');
    await expect(risk.updateRiskSpendReservation(tx, { ...update, confirmedUsd: '30' })).rejects.toThrow(/revers/i);
    await expect(risk.reserveRiskSpend(tx, request(id2, { requestedUsd: '61' }))).rejects.toThrow(/cap/i);
  });

  it('authorized immutable correction adjusts confirmed debit once, unsupported identity cannot', async () => {
    const tx = client(); await risk.reserveRiskSpend(tx, request(id1)); canonicalUsd = '40';
    await risk.updateRiskSpendReservation(tx,{...request(id1),state:'confirmed',confirmedUsd:'40'});
    canonicalUsd = '30';
    await expect(risk.updateRiskSpendReservation(tx,{...request(id1),state:'confirmed',confirmedUsd:'30',valuationCorrectionId:'label'})).rejects.toThrow(/authorization/);
    expect(rows[0].liability_usd).toBe('40'); correctionAuthorized = true;
    await risk.updateRiskSpendReservation(tx,{...request(id1),state:'confirmed',confirmedUsd:'30',valuationCorrectionId:'persisted'});
    await risk.updateRiskSpendReservation(tx,{...request(id1),state:'confirmed',confirmedUsd:'30',valuationCorrectionId:'persisted'});
    expect(rows[0].confirmed_usd).toBe('30'); expect(rows[0].liability_usd).toBe('30');
  });
  it.each(['', 'NaN', '-1', '0', '1e2'])('rejects invalid USD reservation %s before reads', async requestedUsd => {
    await expect(risk.reserveRiskSpend(client(), request(id1, { requestedUsd }))).rejects.toThrow(/USD/i);
    expect(sqls).toEqual([]);
  });

  it('rejects stale epochs even on an idempotent retry', async () => {
    const tx = client();
    await risk.reserveRiskSpend(tx, request(id1));
    policy.epoch = '4';
    await expect(risk.reserveRiskSpend(tx, request(id1))).rejects.toThrow(/epoch/i);
    expect(rows[0].liability_usd).toBe('60');
  });

  it('fails closed when typed storage/current policy is unavailable', async () => {
    const tx = { query: vi.fn().mockRejectedValue(new Error('risk_policy_control unavailable')) } as unknown as PoolClient;
    await expect(risk.reserveRiskSpend(tx, request(id1))).rejects.toThrow(/unavailable/);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
