import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  return {
    clientQuery,
    query: vi.fn(),
    // A real PoolClient is an EventEmitter and withTransaction attaches an
    // 'error' listener. The real `withTransaction` runs here, so BEGIN/COMMIT
    // show up in the statement log.
    connect: vi.fn(async () => ({
      query: clientQuery,
      release: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    }))
  };
});

vi.mock('./client.js', () => ({
  query: mocks.query,
  pool: { connect: mocks.connect }
}));

import {
  DEFAULT_LP_GUARDRAIL_CONFIG,
  getLpGuardrailConfig,
  resolveLpGuardrailConfig,
  upsertLpGuardrailConfig
} from './lp-guardrails.js';
import { forUser } from './tenancy.js';

const scope = forUser('11111111-1111-1111-1111-111111111111');

const configRow = (overrides: Record<string, unknown> = {}) => ({
  user_id: scope.userId,
  max_pool_allocation_pct: '40.00',
  profit_bank_pct: '25.00',
  reserve_sub_vault_chain: 'solana',
  reserve_sub_vault_address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  updated_at: new Date('2026-10-04T00:00:00Z'),
  ...overrides
});

/**
 * `query()` resolves the next queued row array, or an empty one — every test
 * states exactly the rows it expects, in call order, and nothing leaks between
 * tests because the queue is rebuilt in beforeEach.
 */
let queryQueue: unknown[][] = [];

beforeEach(() => {
  queryQueue = [];
  mocks.query.mockReset();
  mocks.query.mockImplementation(async () => queryQueue.shift() ?? []);
  mocks.clientQuery.mockReset();
  mocks.clientQuery.mockImplementation(async () => ({ rows: [] }));
});

describe('lp-guardrails', () => {
  it('resolves plan defaults when the user has no row', async () => {
    queryQueue.push([]);

    const resolved = await resolveLpGuardrailConfig(scope);

    expect(resolved.reserveSubVault).toBeNull();
    expect(resolved.maxPoolAllocationPct).toBe(DEFAULT_LP_GUARDRAIL_CONFIG.maxPoolAllocationPct);
    expect(resolved.profitBankPct).toBe(DEFAULT_LP_GUARDRAIL_CONFIG.profitBankPct);
  });

  it('maps a stored row, including the reserve pointer', async () => {
    queryQueue.push([configRow()]);

    const config = await getLpGuardrailConfig(scope);

    expect(config?.maxPoolAllocationPct).toBe(40);
    expect(config?.reserveSubVault).toEqual({
      chain: 'solana',
      address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'
    });
  });

  it('a partial update keeps the stored reserve pointer and allocation', async () => {
    queryQueue.push([configRow()], [configRow({ profit_bank_pct: '75.00' })]);

    await upsertLpGuardrailConfig(scope, { profitBankPct: 75 });

    const [sql, params] = mocks.query.mock.calls[1];
    expect(String(sql)).toContain('ON CONFLICT (user_id)');
    // max stays at the stored 40; reserve pointer is carried through untouched.
    expect(params[1]).toBe(40);
    expect(params[2]).toBe(75);
    expect(params[3]).toBe('solana');
    expect(params[4]).toBe('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin');
  });

  it('a partial update on a user with no row falls back to plan defaults', async () => {
    queryQueue.push([], [configRow()]);

    await upsertLpGuardrailConfig(scope, { profitBankPct: 75 });

    const [, params] = mocks.query.mock.calls[1];
    expect(params[1]).toBe(DEFAULT_LP_GUARDRAIL_CONFIG.maxPoolAllocationPct);
    expect(params[2]).toBe(75);
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  it('rejects out-of-range percents before writing', async () => {
    await expect(
      upsertLpGuardrailConfig(scope, { maxPoolAllocationPct: 0 })
    ).rejects.toThrow('(0..100]');
    await expect(
      upsertLpGuardrailConfig(scope, { profitBankPct: 101 })
    ).rejects.toThrow('[0..100]');
    // Only the existing-config reads ran; no INSERT was issued.
    expect(mocks.query.mock.calls.every(([sql]) => !String(sql).includes('INSERT'))).toBe(true);
  });
});
