import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn()
}));

vi.mock('./client.js', () => ({ query: mocks.query }));
vi.mock('./transaction.js', () => ({ withTransaction: mocks.withTransaction }));

import { recordCopyExecutionEvidence } from './copy-trade-lifecycle.js';

/**
 * The `copy_execution_evidence` write path, driven without Postgres (S4-M35).
 *
 * `packages/db` has no database available in this environment, so the transaction
 * boundary is stubbed and a fake client answers each statement by matching its SQL.
 * That is enough to assert the two things this fix turns on, both of which live in
 * the statement text and its parameters rather than in the server:
 *
 *   1. what gets written into `quote_quantity` versus `quote_native_quantity` —
 *      i.e. that a SOL amount is converted and never stored as if it were USD;
 *   2. that an unknown USD total is stored as NULL rather than as `0`.
 *
 * Server-enforced behaviour (the CHECK constraints, the immutability trigger, the
 * recursive ledger's arithmetic) is covered by
 * `tests/integration/copy-trade-lifecycle.integration.test.ts`, which needs a real
 * database and has not been run here.
 */

interface RecordedCall {
  sql: string;
  params: unknown[];
}

const EXECUTION_ID = '11111111-1111-1111-1111-111111111111';

function executionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    signal_id: null,
    source_trade_id: '22222222-2222-2222-2222-222222222222',
    chain: 'solana',
    target_account: 'solana:TargetAccount',
    user_id: null,
    token_mint: 'solana:Mint',
    direction: 'buy',
    execution_mode: 'live',
    client_order_id: 'copy-1',
    state: 'submitted',
    requested_base_quantity: '100',
    requested_quote_quantity: null,
    confirmed_base_quantity: '0',
    confirmed_quote_quantity: '0',
    quote_unassessed_fill_count: 0,
    reserved_base_quantity: '0',
    submission_attempts: 1,
    max_submission_attempts: 3,
    simulation_id: null,
    submission_type: 'transaction',
    submission_id: 'sig',
    next_reconciliation_at: null,
    reconciliation_claim_id: null,
    reconciliation_attempts: 0,
    max_reconciliation_attempts: 10,
    source_position_before_quantity: null,
    source_sell_fraction: null,
    ...overrides
  };
}

function positionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '33333333-3333-3333-3333-333333333333',
    target_account: 'solana:TargetAccount',
    chain: 'solana',
    token_mint: 'solana:Mint',
    user_id: null,
    confirmed_quantity: '100',
    reserved_sell_quantity: '0',
    cost_basis_usd: '187.5',
    total_acquired_quantity: '100',
    total_reduced_quantity: '0',
    unmatched_reduction_quantity: '0',
    cost_basis_unvalued_fill_count: 0,
    last_evidence_at: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides
  };
}

function lotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-5555-5555-555555555555',
    target_account: 'solana:TargetAccount',
    user_id: null,
    master_wallet_address: 'solana:MasterAccount',
    chain: 'solana',
    token_mint: 'solana:Mint',
    confirmed_quantity: '100',
    reserved_sell_quantity: '0',
    cost_basis_usd: '187.5',
    cost_basis_unvalued_fill_count: 0,
    total_acquired_quantity: '100',
    total_reduced_quantity: '0',
    unmatched_reduction_quantity: '0',
    last_evidence_at: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides
  };
}

/**
 * A client that answers by statement shape rather than by call index, so inserting
 * an unrelated statement into the write path does not silently shift every stubbed
 * response by one.
 */
function fakeClient(options: {
  totals: {
    confirmed_base_quantity: string;
    valued_quote_usd_sum: string | null;
    valued_fill_count: string;
    unvalued_fill_count: string;
    completes_execution: boolean;
  };
  evidenceQuoteQuantity?: string | null;
  evidenceNativeQuantity?: string | null;
  evidenceCurrency?: string | null;
  evidenceNativeUsdPrice?: string | null;
}) {
  const calls: RecordedCall[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM copy_executions') && sql.includes('FOR UPDATE')) {
        return { rows: [executionRow()] };
      }
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('FROM source_trades') && sql.includes('wallet_address')) {
        return { rows: [{ wallet_address: 'solana:MasterAccount' }] };
      }
      if (sql.includes('INSERT INTO copy_execution_evidence')) {
        return { rows: [] };
      }
      if (sql.includes('FROM copy_execution_evidence') && sql.includes('payload_matches')) {
        return {
          rows: [{
            id: '44444444-4444-4444-4444-444444444444',
            execution_id: EXECUTION_ID,
            evidence_type: 'chain_receipt',
            evidence_id: 'sig',
            base_quantity: '100',
            quote_quantity: options.evidenceQuoteQuantity ?? null,
            quote_native_quantity: options.evidenceNativeQuantity ?? null,
            quote_currency: options.evidenceCurrency ?? null,
            quote_native_usd_price: options.evidenceNativeUsdPrice ?? null,
            price_usd: null,
            confirmation_state: 'confirmed',
            completes_execution: true,
            occurred_at: new Date('2026-08-20T00:00:00.000Z'),
            payload_matches: true
          }]
        };
      }
      if (sql.includes('INSERT INTO copy_positions')) return { rows: [] };
      if (sql.includes('FROM copy_positions') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: positionRow().id }] };
      }
      if (sql.includes('INSERT INTO copy_position_lots')) return { rows: [] };
      if (sql.includes('FROM copy_position_lots') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: lotRow().id }] };
      }
      if (sql.includes('INSERT INTO copy_position_applications')) return { rows: [] };
      if (sql.includes('valued_quote_usd_sum')) {
        return { rows: [options.totals] };
      }
      if (sql.includes('UPDATE copy_positions position')) {
        return { rows: [positionRow()] };
      }
      if (sql.includes('UPDATE copy_position_lots lot')) {
        return { rows: [lotRow()] };
      }
      if (sql.includes('INSERT INTO copy_execution_state_history')) return { rows: [] };
      if (sql.includes('UPDATE copy_executions')) {
        return { rows: [executionRow({ state: 'confirmed' })] };
      }
      if (sql.includes('UPDATE signals')) return { rows: [] };
      throw new Error(`unstubbed statement: ${sql.slice(0, 120)}`);
    })
  };
  return { client, calls };
}

function findCall(calls: RecordedCall[], needle: string): RecordedCall {
  const call = calls.find((entry) => entry.sql.includes(needle));
  if (!call) throw new Error(`no statement contained ${needle}`);
  return call;
}

describe('recordCopyExecutionEvidence quote units', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.withTransaction.mockReset();
  });

  function runWith(
    options: Parameters<typeof fakeClient>[0],
    leg: Parameters<typeof recordCopyExecutionEvidence>[0]['quoteLeg']
  ) {
    const { client, calls } = fakeClient(options);
    mocks.withTransaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) => operation(client)
    );
    return recordCopyExecutionEvidence({
      executionId: EXECUTION_ID,
      evidenceType: 'chain_receipt',
      evidenceId: 'sig',
      baseQuantity: '100',
      quoteLeg: leg,
      confirmationState: 'confirmed',
      completesExecution: true,
      occurredAt: new Date('2026-08-20T00:00:00.000Z')
    }).then((result) => ({ result, calls }));
  }

  it('converts a Solana-live SOL leg to USD and keeps the native amount beside it', async () => {
    const { result, calls } = await runWith(
      {
        totals: {
          confirmed_base_quantity: '100',
          valued_quote_usd_sum: '187.5',
          valued_fill_count: '1',
          unvalued_fill_count: '0',
          completes_execution: true
        },
        evidenceQuoteQuantity: '187.5',
        evidenceNativeQuantity: '1.25',
        evidenceCurrency: 'SOL',
        evidenceNativeUsdPrice: '150'
      },
      { amount: '1.25', currency: 'SOL', nativeUsdPrice: 150 }
    );

    const insert = findCall(calls, 'INSERT INTO copy_execution_evidence');
    // params: [executionId, type, evidenceId, base, quoteUsd, native, currency, rate, ...]
    expect(insert.params[4]).toBe('187.5');
    // The regression this whole item exists to prevent: 1.25 SOL must not land in
    // the column named quote_quantity.
    expect(insert.params[4]).not.toBe('1.25');
    expect(insert.params[5]).toBe('1.25');
    expect(insert.params[6]).toBe('SOL');
    expect(insert.params[7]).toBe('150');
    expect(result.fillValuation).toMatchObject({
      code: 'valued',
      currency: 'SOL',
      nativeAmount: '1.25',
      usdAmount: '187.5'
    });
  });

  it('writes a USD leg unconverted, at a recorded rate of 1', async () => {
    const { calls } = await runWith(
      {
        totals: {
          confirmed_base_quantity: '100',
          valued_quote_usd_sum: '4.5',
          valued_fill_count: '1',
          unvalued_fill_count: '0',
          completes_execution: true
        },
        evidenceQuoteQuantity: '4.5',
        evidenceNativeQuantity: '4.5',
        evidenceCurrency: 'USD',
        evidenceNativeUsdPrice: '1'
      },
      { amount: '4.5', currency: 'USD' }
    );

    const insert = findCall(calls, 'INSERT INTO copy_execution_evidence');
    expect(insert.params[4]).toBe('4.5');
    expect(insert.params[5]).toBe('4.5');
    expect(insert.params[6]).toBe('USD');
    expect(insert.params[7]).toBe('1');
  });

  it('stores a NULL USD value but keeps the native record when the rate is unknown', async () => {
    const { result, calls } = await runWith(
      {
        totals: {
          confirmed_base_quantity: '100',
          valued_quote_usd_sum: null,
          valued_fill_count: '0',
          unvalued_fill_count: '1',
          completes_execution: true
        },
        evidenceQuoteQuantity: null,
        evidenceNativeQuantity: '1.25',
        evidenceCurrency: 'SOL',
        evidenceNativeUsdPrice: null
      },
      { amount: '1.25', currency: 'SOL', nativeUsdPrice: null }
    );

    const insert = findCall(calls, 'INSERT INTO copy_execution_evidence');
    expect(insert.params[4]).toBeNull();
    expect(insert.params[5]).toBe('1.25');
    expect(insert.params[6]).toBe('SOL');
    expect(insert.params[7]).toBeNull();
    expect(result.fillValuation.code).toBe('native-price-unknown');

    // Unknown must not be laundered into zero on the execution row either.
    const update = findCall(calls, 'confirmed_quote_quantity = $3::numeric');
    expect(update.params[2]).toBeNull();
    expect(update.params[4]).toBe(1);
    expect(result.confirmedQuoteTotal).toMatchObject({
      code: 'unvalued',
      usdAmount: null,
      complete: false,
      unvaluedFillCount: 1
    });
  });

  it('carries the unvalued fill count so a partial total is not read as settled', async () => {
    const { result, calls } = await runWith(
      {
        totals: {
          confirmed_base_quantity: '100',
          valued_quote_usd_sum: '187.5',
          valued_fill_count: '1',
          unvalued_fill_count: '2',
          completes_execution: true
        },
        evidenceQuoteQuantity: '187.5',
        evidenceNativeQuantity: '1.25',
        evidenceCurrency: 'SOL',
        evidenceNativeUsdPrice: '150'
      },
      { amount: '1.25', currency: 'SOL', nativeUsdPrice: 150 }
    );

    const update = findCall(calls, 'quote_unassessed_fill_count = $5::integer');
    expect(update.params[2]).toBe('187.5');
    expect(update.params[4]).toBe(2);
    expect(result.confirmedQuoteTotal.code).toBe('partially-valued');
    expect(result.confirmedQuoteTotal.complete).toBe(false);
  });

  it('writes nothing at all for a fill with no quote leg', async () => {
    const { result, calls } = await runWith(
      {
        totals: {
          confirmed_base_quantity: '100',
          valued_quote_usd_sum: null,
          valued_fill_count: '0',
          unvalued_fill_count: '1',
          completes_execution: true
        }
      },
      null
    );

    const insert = findCall(calls, 'INSERT INTO copy_execution_evidence');
    expect(insert.params[4]).toBeNull();
    expect(insert.params[5]).toBeNull();
    expect(insert.params[6]).toBeNull();
    expect(insert.params[7]).toBeNull();
    expect(result.fillValuation.code).toBe('no-quote-leg');
  });

  it('sums only the valued fills and counts the rest', async () => {
    const { calls } = await runWith(
      {
        totals: {
          confirmed_base_quantity: '100',
          valued_quote_usd_sum: '187.5',
          valued_fill_count: '1',
          unvalued_fill_count: '0',
          completes_execution: true
        },
        evidenceQuoteQuantity: '187.5',
        evidenceNativeQuantity: '1.25',
        evidenceCurrency: 'SOL',
        evidenceNativeUsdPrice: '150'
      },
      { amount: '1.25', currency: 'SOL', nativeUsdPrice: 150 }
    );

    const totals = findCall(calls, 'valued_quote_usd_sum');
    // The old statement was COALESCE(SUM(quote_quantity), 0), which reported the
    // same number whether one fill was unvalued or all of them were.
    expect(totals.sql).not.toContain('COALESCE(SUM(quote_quantity), 0)');
    expect(totals.sql).toContain('COUNT(*) FILTER (WHERE quote_quantity IS NOT NULL)');
    expect(totals.sql).toContain('COUNT(*) FILTER (WHERE quote_quantity IS NULL)');
  });

  it('refuses a pre-054 amount that never declared its unit when rebuilding a position', async () => {
    const { calls } = await runWith(
      {
        totals: {
          confirmed_base_quantity: '100',
          valued_quote_usd_sum: '187.5',
          valued_fill_count: '1',
          unvalued_fill_count: '0',
          completes_execution: true
        },
        evidenceQuoteQuantity: '187.5',
        evidenceNativeQuantity: '1.25',
        evidenceCurrency: 'SOL',
        evidenceNativeUsdPrice: '150'
      },
      { amount: '1.25', currency: 'SOL', nativeUsdPrice: 150 }
    );

    const rebuild = findCall(calls, 'UPDATE copy_positions position');
    // The unit gate: an amount only enters the cost basis if its row declares a
    // currency, so a legacy SOL amount falls through to base_quantity * price_usd.
    expect(rebuild.sql).toContain('WHEN evidence.quote_currency IS NOT NULL THEN evidence.quote_quantity');
    expect(rebuild.sql).toContain(
      'ledger.cost_basis + COALESCE(event.quote_usd, event.base_quantity * event.price_usd, 0)'
    );
    // And the ledger no longer prefers the raw column.
    expect(rebuild.sql).not.toContain('COALESCE(event.quote_quantity,');
    // Every buy the trailing zero swallowed is counted.
    expect(rebuild.sql).toContain('cost_basis_unvalued_fill_count = final.unvalued');
  });
});
