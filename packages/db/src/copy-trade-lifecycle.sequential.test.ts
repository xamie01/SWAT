import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('./client.js', () => ({ query: mocks.query }));
vi.mock('./transaction.js', () => ({ withTransaction: mocks.withTransaction }));

import {
  advanceSourceTradeConfirmation, claimSourceSignalForCopyExecution, insertSourceTradeSignal,
  getCanonicalSourceTradeById, getSourceConfirmationReadiness, listSourceTradeSignalCandidates, recordSourceTradeEvent, requestCopyExecution,
  type SourceTradeEventInput
} from './copy-trade-lifecycle.js';

const SOURCE_ID = '11111111-1111-1111-1111-111111111111';
const WALLET = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'ab'.repeat(32)}`;
const EVENT_AT = new Date('2026-11-13T00:00:00.000Z');

function observation(): SourceTradeEventInput {
  return {
    chain: 'polygon', sourceEventType: 'venue_trade', sourceEventId: HASH,
    sourceEventIndex: `ambiguous-data-api-wallet-v1:${WALLET}`,
    transactionHash: HASH, walletAddress: WALLET, tokenMint: TOKEN,
    side: 'buy', quantity: '10', amountUsd: '5', priceUsd: '0.5', feeUsd: '0',
    eventAt: EVENT_AT, observedAt: EVENT_AT, confirmationState: 'observed',
    confirmationEvidenceId: `polymarket-data-api-observation:${HASH}`
  };
}

function sourceRow(state: string = 'confirmed') {
  return {
    id: SOURCE_ID, chain: 'polygon', source_event_type: 'venue_trade',
    source_event_id: HASH, source_event_index: `ambiguous-data-api-wallet-v1:${WALLET}`,
    transaction_hash: HASH, wallet_address: `polygon:${WALLET}`, token_mint: `polygon:${TOKEN}`,
    direction: 'buy', quantity: '10', amount_usd: '5', price_usd: '0.5', fee_usd: '0',
    event_at: EVENT_AT, observed_at: EVENT_AT, confirmation_state: state, payload_matches: true
  };
}

// This is a mocked persistence seam, not PostgreSQL acceptance. Capture writes so
// preserving historical rows/applications is observable without querying a DB.
function persistenceFixture(state = 'confirmed', inserted = false, payloadMatches = true) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const row = { ...sourceRow(state), payload_matches: payloadMatches };
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO source_trades')) {
        return { rows: inserted ? [{ id: SOURCE_ID }] : [], rowCount: inserted ? 1 : 0 };
      }
      if (sql.includes('FROM signals')) return { rows: [{ id: 'signal-1', status: 'eligible',
        source_trade_id: SOURCE_ID, source_side: 'buy', expires_at: null }], rowCount: 1 };
      if (sql.includes('INSERT INTO signals')) return { rows: [{ id: 'signal-1',
        source_trade_id: SOURCE_ID, chain: 'polygon', token_mint: row.token_mint,
        source_side: 'buy' }], rowCount: 1 };
      if (sql.includes('FROM copy_positions')) return { rows: [{ id: 'position-1' }], rowCount: 1 };
      if (sql.includes('INSERT INTO copy_executions')) return { rows: [{ id: 'execution-1',
        chain: 'polygon', direction: 'buy', requested_base_quantity: '1' }], rowCount: 1 };
      if (sql.includes('FROM source_trades')) return { rows: [row], rowCount: 1 };
      if (sql.includes('UPDATE wallet_positions')) {
        return { rows: [{ wallet_address: row.wallet_address, chain: row.chain,
          token_mint: row.token_mint, confirmed_quantity: '10', cost_basis_usd: '5',
          total_acquired_quantity: '10', total_reduced_quantity: '0',
          unmatched_reduction_quantity: '0', last_event_at: EVENT_AT }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    })
  };
  mocks.withTransaction.mockImplementation(async operation => operation(client));
  return { calls, row };
}

beforeEach(() => { vi.resetAllMocks(); });

describe('uncertified source observation persistence', () => {
  it('reports unavailable confirmation authority without a caller override or storage access', () => {
    expect(getSourceConfirmationReadiness()).toEqual({ ready: false,
      reason: 'source-confirmation-verifier-unavailable' });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it('does not enumerate historical applied rows as copy candidates', async () => {
    persistenceFixture('finalized');
    expect(await listSourceTradeSignalCandidates({ sourceTradeId: SOURCE_ID,
      maxEventAgeMs: 60_000, now: EVENT_AT })).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'finalized'] as const)(
    'refuses signal insertion from uncertified historical %s rows', async state => {
      const { calls } = persistenceFixture(state);
      await expect(insertSourceTradeSignal({ sourceTradeId: SOURCE_ID, confidence: 90,
        signalScore: 90, triggerData: {}, maxEventAgeMs: 60_000,
        maxPositionEvidenceAgeMs: 60_000, now: EVENT_AT }))
        .rejects.toThrow('Source confirmation verifier is unavailable');
      expect(calls.filter(({ sql }) => /^\s*(?:INSERT INTO|UPDATE|DELETE FROM)/.test(sql))).toEqual([]);
    }
  );

  it.each(['confirmed', 'finalized'] as const)(
    'refuses a direct copy request from uncertified historical %s rows', async state => {
      const { calls } = persistenceFixture(state);
      await expect(requestCopyExecution({ sourceTradeId: SOURCE_ID, targetAccount: WALLET,
        executionMode: 'paper', requestedBaseQuantity: '1' }))
        .rejects.toThrow('Source confirmation verifier is unavailable');
      expect(calls.filter(({ sql }) => /^\s*(?:INSERT INTO|UPDATE|DELETE FROM)/.test(sql))).toEqual([]);
    }
  );

  it.each(['confirmed', 'finalized'] as const)(
    'withholds a new execution claim from uncertified historical %s rows', async state => {
      const { calls } = persistenceFixture(state);
      expect(await claimSourceSignalForCopyExecution({ signalId: 'signal-1', targetAccount: WALLET,
        executionMode: 'paper', requestedBaseQuantity: '1', maxPositionEvidenceAgeMs: 60_000,
        now: EVENT_AT })).toMatchObject({ execution: null, created: false, claimed: false,
        reason: 'Source confirmation verifier is unavailable' });
      expect(calls.filter(({ sql }) => /^\s*(?:INSERT INTO|UPDATE|DELETE FROM)/.test(sql))).toEqual([]);
    }
  );

  it('withholds an existing execution retry before the historical execution lookup', async () => {
    const { calls } = persistenceFixture();
    mocks.withTransaction.mockImplementation(async operation => operation({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('FROM signals')) return { rows: [{ id: 'signal-1',
          status: 'executing', source_trade_id: SOURCE_ID, source_side: 'buy', expires_at: null }] };
        if (sql.includes('FROM source_trades')) return { rows: [sourceRow()] };
        if (sql.includes('FROM copy_executions')) return { rows: [{ id: 'execution-1',
          signal_id: 'signal-1', state: 'requested', source_trade_id: SOURCE_ID }] };
        return { rows: [] };
      })
    }));
    expect(await claimSourceSignalForCopyExecution({ signalId: 'signal-1', targetAccount: WALLET,
      executionMode: 'paper', requestedBaseQuantity: '1', maxPositionEvidenceAgeMs: 60_000,
      now: EVENT_AT })).toMatchObject({ execution: null, created: false, claimed: false,
      reason: 'Source confirmation verifier is unavailable' });
    expect(calls.some(({ sql }) => sql.includes('FROM copy_executions'))).toBe(false);
    expect(calls.some(({ sql }) => /^\s*(?:INSERT INTO|UPDATE|DELETE FROM)/.test(sql))).toBe(false);
  });

  it.each(['confirmed', 'finalized', 'reversed'] as const)(
    'refuses caller-supplied %s intake before persistence', async confirmationState => {
      persistenceFixture();
      await expect(recordSourceTradeEvent({ ...observation(), confirmationState,
        confirmationEvidenceId: 'independently-verified-finality:v1:caller-claim' }))
        .rejects.toThrow('Source confirmation verifier is unavailable');
      expect(mocks.withTransaction).not.toHaveBeenCalled();
      expect(mocks.query).not.toHaveBeenCalled();
    }
  );

  it.each(['observed', 'confirmed', 'finalized', 'reversed'] as const)(
    'does not treat arbitrary evidence text as authority to advance to %s', async confirmationState => {
      persistenceFixture(confirmationState);
      await expect(advanceSourceTradeConfirmation({ sourceTradeId: SOURCE_ID,
        confirmationState, evidenceId: 'certificate:v1:provider-receipt-success:slot-999',
        observedAt: EVENT_AT }))
        .rejects.toThrow('Source confirmation verifier is unavailable');
      expect(mocks.withTransaction).not.toHaveBeenCalled();
    }
  );

  it('includes fee null semantics in the immutable payload collision check', async () => {
    const { calls } = persistenceFixture();
    await recordSourceTradeEvent(observation());
    const comparison = calls.find(({ sql }) => sql.includes('AS payload_matches'));
    // PostgreSQL performs decimal equality; this asserts the generated statement,
    // not server execution. Null and zero fees must remain distinct.
    expect(comparison?.sql).toContain('AND fee_usd IS NOT DISTINCT FROM $13::numeric');
    expect(comparison?.params[12]).toBe('0');
  });

  it.each(['observed', 'confirmed', 'finalized', 'reversed'] as const)(
    'preserves stored %s state on repeated observation replay without applying positions', async state => {
      const { calls, row } = persistenceFixture(state);
      const original = { ...row };
      for (let replay = 0; replay < 2; replay += 1) {
        expect(await recordSourceTradeEvent(observation())).toMatchObject({ inserted: false,
          position: null, eligibleForCopy: false, event: { confirmationState: state } });
      }
      expect(row).toEqual(original);
      expect(calls.some(({ sql }) => /(?:INSERT INTO|UPDATE) (?:wallet_positions|source_position_applications)/.test(sql)))
        .toBe(false);
      expect(calls.filter(({ sql }) => sql.includes('INSERT INTO source_trade_confirmation_history')))
        .toHaveLength(2);
    }
  );

  it('persists a new observation without pretending to establish a confirmed position', async () => {
    persistenceFixture('observed', true);
    expect(await recordSourceTradeEvent(observation())).toMatchObject({ inserted: true,
      position: null, eligibleForCopy: false, event: { confirmationState: 'observed' } });
  });

  it('refuses an immutable identity collision without rewriting historical economics or appending provenance', async () => {
    const { calls, row } = persistenceFixture('finalized', false, false);
    const original = { ...row };
    await expect(recordSourceTradeEvent({ ...observation(), quantity: '11' }))
      .rejects.toThrow('different immutable payload');
    expect(row).toEqual(original);
    expect(calls.some(({ sql }) => sql.includes('INSERT INTO source_trade_confirmation_history'))).toBe(false);
    expect(calls.some(({ sql }) => /^\s*(?:UPDATE|DELETE FROM)/.test(sql))).toBe(false);
  });

  it('keeps canonical historical reads available without implying eligibility', async () => {
    mocks.query.mockResolvedValue([sourceRow('confirmed')]);
    expect(await getCanonicalSourceTradeById(SOURCE_ID)).toMatchObject({ id: SOURCE_ID,
      confirmationState: 'confirmed', quantity: '10' });
  });

  it('replays a historical confirmed observation without applying or rewriting positions', async () => {
    const { calls, row } = persistenceFixture();
    const original = { ...row };
    const result = await recordSourceTradeEvent(observation());
    expect(result).toMatchObject({ inserted: false, position: null, eligibleForCopy: false,
      event: { id: SOURCE_ID, confirmationState: 'confirmed', quantity: '10' } });
    expect(row).toEqual(original);
    expect(calls.filter(({ sql }) => /(?:INSERT INTO|UPDATE|DELETE FROM) (?:wallet_positions|source_position_applications|source_trades)/.test(sql)))
      .toEqual([expect.objectContaining({ sql: expect.stringContaining('INSERT INTO source_trades') })]);
    expect(calls.find(({ sql }) => sql.includes('INSERT INTO source_trade_confirmation_history'))?.params)
      .toEqual([SOURCE_ID, 'observed', observation().confirmationEvidenceId, EVENT_AT]);
  });
});
