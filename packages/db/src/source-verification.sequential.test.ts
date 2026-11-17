import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { sourceBindingDigest, sourceContentDigest, sourceEvidenceDigest, sourceTokenQuantity,
  verifyBoundSourceEvidence, type SourceVerificationBinding, type SourceVerificationEvidence,
  type TrustedSourceVerifier } from './source-verification.js';
import { applyVerifiedSourceEvidenceWithClient, bindSourceObservationWithClient,
  hasAcceptedSourceVerificationWithClient, rebuildVerifiedSourcePositionWithClient,
  readVerifiedSourcePositionAssessmentWithClient } from './source-verification-store.js';

const now = new Date('2026-11-17T00:01:00.000Z');
const binding: SourceVerificationBinding = { chain: 'solana', network: 'inert-local-genesis-identity',
  sourceEventType: 'transaction', sourceEventId: 'fixture-tx', sourceEventIndex: 'fixture-wallet-event',
  transactionHash: 'fixture-tx', walletAddress: 'solana:fixture-wallet', tokenMint: 'solana:fixture-mint',
  side: 'buy', rawQuantity: '900719925474099200000001', quantityScale: 6,
  eventAt: '2026-11-17T00:00:00.000Z', amountUsd: '20', priceUsd: null, feeUsd: null };
function evidence(overrides: Partial<SourceVerificationEvidence> = {}): SourceVerificationEvidence {
  return { evidenceId: 'fixture-evidence-1', binding, finality: 'confirmed', blockHash: 'fixture-block',
    blockHeight: '100', revision: '1', reversesEvidenceId: null, observedAt: now.toISOString(),
    provenance: { providerId: 'inert-provider', authorityId: 'inert-authority', verifierVersion: 'fixture-v1', receiptId: 'receipt' },
    content: '{"inert":true}', contentDigest: sourceContentDigest('{"inert":true}'), ...overrides };
}
const provider = { providerId: 'inert-provider', authorityId: 'inert-authority', chain: 'solana' as const,
  network: binding.network, verifierVersion: 'fixture-v1', identityDigest: 'a'.repeat(64), validUntil: '2026-11-17T01:00:00.000Z' };
function verifier(): TrustedSourceVerifier {
  return { validateProvider: vi.fn(async () => provider), verifyEvidence: vi.fn(async input => ({ accepted: true,
    evidenceDigest: input.evidenceDigest, identityDigest: provider.identityDigest })) };
}
// Stateful inert row store, not a PostgreSQL engine or concurrency/RLS proof.
function fixture() {
  const source = { wallet_address: binding.walletAddress, chain: binding.chain, token_mint: binding.tokenMint,
    direction: binding.side, transaction_hash: binding.transactionHash, source_event_type: binding.sourceEventType,
    source_event_id: binding.sourceEventId, source_event_index: binding.sourceEventIndex,
    token_amount: sourceTokenQuantity(binding.rawQuantity, binding.quantityScale), amount_usd: '20', price_usd: null,
    fee_usd: null, event_at: new Date(binding.eventAt), confirmation_state: 'observed' };
  const rows = new Map<string, { source_trade_id: string; evidence_digest: string; evidence: SourceVerificationEvidence }>();
  let head: { evidence_id: string; revision: string; confirmation_state: string; authority_id: string } | undefined;
  const history = new Set<string>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const state = { authorityEnabled: true, unsafe: false, network: binding.network, scale: binding.quantityScale, insertFailure: false };
  const client = { query: vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes('AS verified')) return { rows: [{ verified: !state.unsafe }] };
    if (sql.includes('AS accepted')) return { rows: [{ accepted: state.authorityEnabled && ['confirmed','finalized'].includes(source.confirmation_state) && !!head }] };
    if (sql.includes('FROM source_trades WHERE id')) return { rows: [source] };
    if (sql.includes('SELECT binding, binding_digest')) return { rows: [{ binding, binding_digest: sourceBindingDigest(binding) }] };
    if (sql.includes('FROM source_provider_authorities WHERE')) return { rows: [{ ...provider, provider_id: provider.providerId,
      identity_digest: provider.identityDigest, verifier_version: provider.verifierVersion, valid_until: new Date(provider.validUntil), enabled: state.authorityEnabled }] };
    if (sql.includes('INSERT INTO source_verified_evidence')) {
      if (state.insertFailure) throw new Error('inert storage failure');
      const id = values[0] as string;
      if (rows.has(id)) return { rows: [], rowCount: 0 };
      rows.set(id, { source_trade_id: values[1] as string, evidence_digest: values[3] as string,
        evidence: JSON.parse(values[12] as string) }); return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT source_trade_id, evidence_digest')) return { rows: rows.has(values[0] as string) ? [rows.get(values[0] as string)] : [] };
    if (sql.includes('SELECT head.evidence_id')) return { rows: head ? [head] : [] };
    if (sql.includes('AS exists')) return { rows: [{ exists: history.has(values[0] as string) }] };
    if (sql.includes('SELECT network, quantity_scale')) return { rows: [{ network: state.network, quantity_scale: state.scale }] };
    if (sql.includes('AS unsafe')) return { rows: [{ unsafe: state.unsafe }] };
    if (sql.includes('UPDATE source_trades SET')) source.confirmation_state = values[1] as string;
    if (sql.includes('INSERT INTO source_verification_heads')) {
      // Model SQL077 BEFORE INSERT, which executes before ON CONFLICT. An
      // existing reversed transition must use UPDATE, never an upsert INSERT.
      if (values[3] === 'reversed') throw new Error('SQL077 initial source head state mismatch');
      if (head) throw new Error('SQL077 duplicate initial source head');
      head = { evidence_id: values[1] as string, revision: values[2] as string,
        confirmation_state: values[3] as string, authority_id: provider.authorityId };
    }
    if (sql.includes('UPDATE source_verification_heads SET')) {
      if (!head || head.evidence_id !== values[4]) return { rows: [], rowCount: 0 };
      head = { evidence_id: values[1] as string, revision: values[2] as string,
        confirmation_state: values[3] as string, authority_id: provider.authorityId };
    }
    if (sql.includes('INSERT INTO source_verification_history')) history.add(values[1] as string);
    return { rows: [], rowCount: 1 };
  }) };
  return { client: client as unknown as PoolClient, calls, rows, history, state, source };
}
const apply = (f: ReturnType<typeof fixture>, item = evidence()) => applyVerifiedSourceEvidenceWithClient(f.client,
  { sourceTradeId: 'source', evidence: item, verifier: verifier(), now });

describe('exact provider-bound source evidence (inert offline verifier, no runtime authority)', () => {
  it('applies exact integer scale without Number precision loss', () => {
    expect(sourceTokenQuantity(binding.rawQuantity, 6)).toBe('900719925474099200.000001');
    expect(sourceTokenQuantity('1', 255)).toBe(`0.${'0'.repeat(254)}1`);
  });
  it('invokes both genuine verifier interface phases with exact digest/scope', async () => {
    const trusted = verifier();
    const result = await verifyBoundSourceEvidence({ expected: binding, evidence: evidence(), verifier: trusted, now });
    expect(trusted.validateProvider).toHaveBeenCalledOnce(); expect(trusted.verifyEvidence).toHaveBeenCalledOnce();
    expect(result.evidenceDigest).toBe(sourceEvidenceDigest(evidence()));
  });
  it.each(['network','transactionHash','sourceEventIndex','walletAddress','tokenMint','side','rawQuantity','quantityScale','eventAt'] as const)(
    'rejects wrong %s before provider validation', async field => {
      const trusted = verifier();
      const altered = { ...binding, [field]: field === 'quantityScale' ? 5 : field === 'side' ? 'sell'
        : field === 'rawQuantity' ? '1' : field === 'eventAt' ? '2026-11-17T00:00:01.000Z' : 'wrong' } as SourceVerificationBinding;
      await expect(verifyBoundSourceEvidence({ expected: binding, evidence: evidence({ binding: altered }), verifier: trusted, now })).rejects.toThrow();
      expect(trusted.validateProvider).not.toHaveBeenCalled();
    });
  it.each(['0','01','1.0','1e6','-1'])('rejects noncanonical/invalid raw quantity %s', async rawQuantity => {
    await expect(verifyBoundSourceEvidence({ expected: binding, evidence: evidence({ binding: { ...binding, rawQuantity } }), verifier: verifier(), now })).rejects.toThrow();
  });
  it('rejects content/evidence tampering and ambiguous Polymarket grouping', async () => {
    await expect(verifyBoundSourceEvidence({ expected: binding, evidence: evidence({ content: 'tampered' }), verifier: verifier(), now })).rejects.toThrow(/digest/);
    const ambiguous = { ...binding, chain: 'polygon' as const, sourceEventType: 'venue_trade' as const,
      sourceEventIndex: 'ambiguous-data-api-wallet-v1:wallet' };
    await expect(verifyBoundSourceEvidence({ expected: ambiguous, evidence: evidence({ binding: ambiguous }), verifier: verifier(), now })).rejects.toThrow(/not a unique/);
  });
  it.each(['missing','wrong-network','expired','rejected','wrong-digest'])('fails closed for %s provider/evidence', async fault => {
    const trusted = verifier();
    if (fault === 'missing') trusted.validateProvider = async () => null;
    if (fault === 'wrong-network') trusted.validateProvider = async () => ({ ...provider, network: 'wrong' });
    if (fault === 'expired') trusted.validateProvider = async () => ({ ...provider, validUntil: now.toISOString() });
    if (fault === 'rejected') trusted.verifyEvidence = async () => ({ accepted: false, evidenceDigest: '', identityDigest: provider.identityDigest });
    if (fault === 'wrong-digest') trusted.verifyEvidence = async () => ({ accepted: true, evidenceDigest: 'b'.repeat(64), identityDigest: provider.identityDigest });
    await expect(verifyBoundSourceEvidence({ expected: binding, evidence: evidence(), verifier: trusted, now })).rejects.toThrow();
  });
});

describe('actual same-client source evidence lifecycle/history seam (mocked row storage)', () => {
  it('persists immutable evidence, state, application, history and economic replay on one client', async () => {
    const f = fixture(); expect(await apply(f)).toMatchObject({ applied: true, confirmationState: 'confirmed' });
    expect(f.history.size).toBe(1); expect(f.rows.size).toBe(1);
    expect(f.calls.some(({sql}) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql))).toBe(false);
    expect(f.calls.find(({sql}) => sql.includes('WITH RECURSIVE'))?.sql).toContain('ORDER BY source.event_at, source.id');
    expect(f.calls.find(({sql}) => sql.includes('WITH RECURSIVE'))?.sql).toContain('unvaluedAcquisitions');
  });
  it('replays/restarts from retained rows without a second application or economics history', async () => {
    const f = fixture(); await apply(f); f.calls.length = 0;
    expect(await apply(f)).toMatchObject({ replayed: true, applied: false });
    expect(f.calls.some(({sql}) => sql.includes('INSERT INTO source_position_applications'))).toBe(false);
    expect(f.history.size).toBe(1);
  });
  it('confirmed to finalized then reorg reversal is immutable and cannot resurrect', async () => {
    const f = fixture(); await apply(f);
    await apply(f, evidence({ evidenceId: 'final', finality: 'finalized', revision: '2' }));
    await apply(f, evidence({ evidenceId: 'reorg', finality: 'reversed', revision: '3', reversesEvidenceId: 'final' }));
    expect(f.source.confirmation_state).toBe('reversed'); expect(f.history.size).toBe(3);
    const headWrites = f.calls.filter(({sql}) => /(?:INSERT INTO|UPDATE) source_verification_heads/.test(sql));
    expect(headWrites.map(({sql}) => sql.trim().split(' ')[0])).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
    expect(headWrites[2]?.values).toEqual(['source', 'reorg', '3', 'reversed', 'final']);
    expect(headWrites.every(({sql}) => !sql.includes('ON CONFLICT'))).toBe(true);
    expect(await hasAcceptedSourceVerificationWithClient(f.client, 'source', now)).toBe(false);
    expect(f.calls.filter(({sql}) => sql.includes('INSERT INTO source_position_applications')).at(-1)?.values[4]).toBe(false);
    await expect(apply(f, evidence({ evidenceId: 'resurrect', finality: 'finalized', revision: '4' }))).rejects.toThrow(/resurrected/);
    expect(await apply(f, evidence())).toMatchObject({ replayed: true, confirmationState: 'reversed' });
  });
  it('rejects evidence ID collision, stale revision and wrong reversal target', async () => {
    const f = fixture(); await apply(f);
    await expect(apply(f, evidence({ blockHash: 'different' }))).rejects.toThrow(/collision/);
    await expect(apply(f, evidence({ evidenceId: 'stale', revision: '0', finality: 'finalized' }))).rejects.toThrow(/Out-of-order/);
    await expect(apply(f, evidence({ evidenceId: 'bad-reorg', revision: '2', finality: 'reversed', reversesEvidenceId: 'wrong' }))).rejects.toThrow(/current accepted/);
    expect(f.history.size).toBe(1);
  });
  it.each(['revoked','legacy','wrong-network','wrong-scale','storage-failure'])('refuses %s before application', async fault => {
    const f = fixture(); if (fault === 'revoked') f.state.authorityEnabled = false;
    if (fault === 'legacy') f.state.unsafe = true;
    if (fault === 'wrong-network') f.state.network = 'wrong';
    if (fault === 'wrong-scale') f.state.scale = 5;
    if (fault === 'storage-failure') f.state.insertFailure = true;
    await expect(apply(f)).rejects.toThrow();
    expect(f.calls.some(({sql}) => sql.includes('INSERT INTO source_position_applications'))).toBe(false);
    expect(f.history.size).toBe(0);
  });
  it('projection recovery uses retained applications and does not add history or authority', async () => {
    const f = fixture(); await apply(f); f.calls.length = 0;
    await rebuildVerifiedSourcePositionWithClient(f.client, 'source', null, now);
    expect(f.calls).toHaveLength(2); expect(f.calls[1]?.values[1]).toBeNull();
    expect(f.calls[1]?.sql).toContain('WHERE $2::text IS NOT NULL');
    expect(f.history.size).toBe(1);
  });
  it('recovery refuses unverified legacy projections before any economic overwrite', async () => {
    const f = fixture(); f.state.unsafe = true;
    await expect(rebuildVerifiedSourcePositionWithClient(f.client, 'source', null, now)).rejects.toThrow(/verified immutable/);
    expect(f.calls.some(({sql}) => sql.includes('WITH RECURSIVE'))).toBe(false);
  });
  it.each([{ count: '0', subtotal: '20.000000', total: '20', assessment: 'verified' },
    { count: '1', subtotal: '0', total: null, assessment: 'partial' },
    { count: '2', subtotal: '20', total: null, assessment: 'partial' }])(
    'read-side assessment does not turn unknown cost into known zero %j', async item => {
      const query = vi.fn(async (sql: string, values: unknown[]) => {
        expect(sql).toContain('JOIN source_verified_position_scopes scope');
        expect(sql).toContain('FOR SHARE OF position, scope');
        expect(values).toEqual([binding.walletAddress, binding.chain, binding.tokenMint]);
        return { rows: [{ quantity: '10', known_cost_basis_subtotal_usd: item.subtotal,
          unvalued_acquisition_count: item.count, network: binding.network, quantity_scale: 6 }] };
      });
      expect(await readVerifiedSourcePositionAssessmentWithClient({ query } as unknown as PoolClient,
        { walletAddress: binding.walletAddress, chain: binding.chain, tokenMint: binding.tokenMint }))
        .toMatchObject({ costBasisUsd: item.total, knownCostBasisSubtotalUsd: item.subtotal.replace(/\.000000$/, ''),
          unvaluedAcquisitionCount: Number(item.count), basisAssessment: item.assessment });
    });
  it('unverified read-side assessment is unavailable and snapshot SQL retains null total plus named subtotal', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(await readVerifiedSourcePositionAssessmentWithClient({ query } as unknown as PoolClient,
      { walletAddress: binding.walletAddress, chain: binding.chain, tokenMint: binding.tokenMint })).toBeNull();
    const f = fixture(); await apply(f);
    const projection = f.calls.find(({sql}) => sql.includes('WITH RECURSIVE'))!;
    expect(projection.sql).toContain("'costBasisUsd', CASE WHEN final.unvalued = 0 THEN updated.cost_basis_usd::text ELSE NULL END");
    expect(projection.sql).toContain("'knownCostBasisSubtotalUsd', updated.cost_basis_usd::text");
    expect(projection.sql).toContain('unvalued_acquisition_count = final.unvalued');
  });
  it('new bindings cannot silently attach/backfill inherited rows', async () => {
    const f = fixture();
    await expect(bindSourceObservationWithClient(f.client, 'source', binding, false)).rejects.toThrow(/missing immutable/);
    expect(f.calls.some(({sql}) => sql.includes('INSERT INTO source_verification_bindings'))).toBe(false);
  });
});
