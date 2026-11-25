import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PoolClient } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import { sourceBindingDigest, sourceContentDigest, type SourceVerificationEvidence } from '../../../packages/db/src/source-verification.js';
import { createWave4LoadProtectedCapture } from '../../../packages/db/src/wave4-load-capture-owned.js';
import type { FanoutTradeQueue } from '../../../apps/signal-engine/src/fanout-enqueue.js';
import { createLoadFixtureConsumers, type LoadFixtureConsumerPorts, type LoadFixtureInvocation } from './load-fixture-consumers.js';
import { createLoadDurableSqlObserver } from './load-durable-observer.js';
import { drainLoadAccounting, loadCaptureKinds, requireLoadFinalAccounting } from './load-durable-economics.js';
import { loadDigest, loadFixtureRequest, type LoadAdmission, type LoadFixture, type LoadHttpAttempt } from './load-durable-contract.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FIXTURE_WALLET = '33333333-3333-4333-8333-333333333333';
const FIXTURE_TOKEN = '33333333-3333-4333-8333-333333333334';
const ATTEMPT_WALLET = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_TOKEN = '44444444-4444-4444-8444-444444444445';
const ATTEMPT_WALLET_REPLAY = '44444444-4444-4444-8444-444444444446';
const AUTHORITY_ID = '55555555-5555-4555-8555-555555555555';
const APPROVAL_ID = '66666666-6666-4666-8666-666666666666';

const at = '2026-11-23T00:00:00.000Z';
const futureAt = '2026-11-23T00:05:00.000Z';
const scope = {
  runId: RUN,
  namespace: `wave4-load-${RUN}`,
  network: `solana:wave4-${RUN}`,
  backendIdentity: 'offline|unix|0|swat_app',
};
const walletAddress = 'solana:11111111111111111111111111111111';
const tokenMintWallet = 'solana:11111111111111111111111111111112';
const tokenMintToken = 'solana:11111111111111111111111111111113';

const providerIdentityDigest = createHash('sha256').update('inert-source-provider').digest('hex');

function makeInvocation(params: {
  kind: 'wallet' | 'token';
  fixtureId: string;
  attemptId: string;
  tokenMint: string;
  rawQuantity: string;
  quantityScale: number;
  base: { raw: string; scale: number };
  quoteBudget: { raw: string; scale: number };
  quote: { raw: string; scale: number };
  fee: { raw: string; scale: number };
  status?: number;
  startedAt?: string;
}): LoadFixtureInvocation {
  const fixture: LoadFixture = {
    scope,
    fixtureId: params.fixtureId,
    userId: USER,
    kind: params.kind,
    walletAddress,
    tokenMint: params.tokenMint,
    targetAccount: walletAddress,
    binding: {
      chain: 'solana',
      network: scope.network,
      sourceEventType: 'transaction',
      sourceEventId: `${scope.namespace}/${params.fixtureId}`,
      sourceEventIndex: '0',
      transactionHash: `${scope.namespace}/${params.fixtureId}`,
      walletAddress,
      tokenMint: params.tokenMint,
      side: 'buy',
      rawQuantity: params.rawQuantity,
      quantityScale: params.quantityScale,
      eventAt: at,
      amountUsd: '100',
      priceUsd: null,
      feeUsd: '0',
    },
    base: params.base,
    quoteBudget: params.quoteBudget,
    quote: params.quote,
    fee: params.fee,
    requestDigest: '',
  };
  (fixture as { requestDigest: string }).requestDigest = loadDigest(loadFixtureRequest(fixture));
  const attempt: LoadHttpAttempt = {
    attemptId: params.attemptId,
    fixtureId: params.fixtureId,
    runId: RUN,
    namespace: scope.namespace,
    userId: USER,
    requestDigest: fixture.requestDigest,
    route: params.kind === 'wallet' ? '/v1/me/wallets' : '/v1/me/tokens/backfill',
    status: params.status ?? 201,
    startedAt: params.startedAt ?? at,
    finishedAt: params.startedAt ?? at,
  };
  const content = `inert-receipt:${params.fixtureId}`;
  const evidence: SourceVerificationEvidence = {
    evidenceId: `inert-evidence-${params.fixtureId}`,
    binding: fixture.binding,
    finality: 'confirmed',
    blockHash: `inert-block-${params.fixtureId}`,
    blockHeight: '1',
    revision: '1',
    reversesEvidenceId: null,
    observedAt: at,
    provenance: {
      providerId: 'inert-provider',
      authorityId: AUTHORITY_ID,
      verifierVersion: 'inert-v1',
      receiptId: `inert-receipt-${params.fixtureId}`,
    },
    content,
    contentDigest: sourceContentDigest(content),
  };
  return { fixture, attempt, principal: { kind: 'user', userId: USER }, evidence };
}

/**
 * Inert canonical PostgreSQL state emulator for P7 offline qualification.
 * No production business/economic/observer logic is duplicated; real production
 * leaves drive every SQL insert, update, lock, and observer scan.
 */
function createCanonicalLoadDbFixture(currentTime: () => Date) {
  const nowDate = () => currentTime();
  const state = {
    sourceTrades: [] as Record<string, any>[],
    bindings: [] as Record<string, any>[],
    heads: [] as Record<string, any>[],
    verifiedEvidence: [] as Record<string, any>[],
    sourceApplications: [] as Record<string, any>[],
    signals: [] as Record<string, any>[],
    batches: [] as Record<string, any>[],
    deliveries: [] as Record<string, any>[],
    executions: [] as Record<string, any>[],
    policySnapshots: [] as Record<string, any>[],
    workerAttempts: [] as Record<string, any>[],
    evidence: [] as Record<string, any>[],
    trades: [] as Record<string, any>[],
    receipts: [] as Record<string, any>[],
    positions: [] as Record<string, any>[],
    positionApplications: [] as Record<string, any>[],
    lots: [] as Record<string, any>[],
    riskReservations: [] as Record<string, any>[],
    capacityLedger: [] as Record<string, any>[],
    admissions: [] as LoadAdmission[],
    canonicalByFixture: new Map<string, { sourceTradeId: string; signalId: string; executionId: string; jobId: string }>(),
    xidSeq: 1000,
    fenceSeq: 0,
  };

  function runQuery(role: string, sql: string, values: unknown[], txState: { xid: string; userScope: string; executionScope: string; readOnly: boolean; isolation: string }): { rows: any[]; rowCount: number } {
    const reply = (rows: any[] = [], rowCount = rows.length) => ({ rows: rows.map(r => structuredClone(r)), rowCount });

    if (sql.includes('pg_advisory_xact_lock')) return reply([]);
    if (sql.includes('SET LOCAL app.bypass_rls')) return reply([]);
    if (sql.includes("set_config('app.current_user_id', '', true)")) {
      txState.userScope = ''; txState.executionScope = ''; return reply([]);
    }
    if (sql.includes("set_config('app.current_user_id', $1, true)")) {
      txState.userScope = String(values[0] ?? ''); return reply([]);
    }
    if (sql.includes("set_config('app.worker_execution_id', $1, true)")) {
      txState.executionScope = String(values[0] ?? ''); return reply([]);
    }

    // Role & self-observation checks
    if (sql.includes('pg_catalog.pg_stat_activity')) {
      return reply([{
        current_role: role, session_role: role, role_setting: 'none', row_security: 'on', bypass: 'off',
        user_scope: txState.userScope, execution_scope: txState.executionScope,
        read_only: txState.readOnly ? 'on' : 'off', isolation: txState.isolation,
        backend_pid: 321, backend_start: '2026-11-23 00:00:00+00',
        transaction_id: txState.xid, explicit_transaction: true,
        database_oid: '42', database_name: 'offline', server_address: 'unix', server_port: 0,
        backend_identity: `offline|unix|0|${role}`, safe_role: true,
      }]);
    }
    if (sql.includes("current_setting('transaction_read_only') AS read_only")) {
      return reply([{
        role, session: role, rolsuper: false, rolbypassrls: false,
        row_security: 'on', read_only: txState.readOnly ? 'on' : 'off',
        isolation: txState.isolation, bypass: 'off',
      }]);
    }
    if (sql.includes('AS can_create') && sql.includes('pg_catalog.pg_roles')) {
      return reply([{
        role_name: role, session_role: role, rolsuper: false, rolbypassrls: false,
        rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false,
        has_memberships: false, owns_objects: false, can_create: false, row_security: 'on',
      }]);
    }

    // Protected capture RPCs
    if (sql === 'SELECT wave4_load.assert_invocation($1::jsonb) AS invocation') {
      const q = JSON.parse(String(values[0]));
      return reply([{
        invocation: {
          scope: q.scope, fixtureId: q.fixture.fixtureId, attemptId: q.attempt.attemptId,
          userId: q.fixture.userId, stage: q.stage,
          approval: {
            approval_id: APPROVAL_ID, run_id: q.scope.runId, fixture_id: q.fixture.fixtureId,
            stage: q.stage, runtime_role: role, database_oid: 42, server_address: 'unix',
            server_port: 0, backend_identity: `offline|unix|0|${role}`, revision: 'offline-v1', revoked_at: null,
          },
        },
      }]);
    }
    if (sql === 'SELECT wave4_load.bind_canonical($1::jsonb) AS outcome') {
      const q = JSON.parse(String(values[0]));
      const prev = state.canonicalByFixture.get(q.fixtureId);
      const outcomeKind: 'admitted' | 'replay' = !prev ? 'admitted' : 'replay';
      if (prev) {
        if (prev.sourceTradeId !== q.sourceTradeId || prev.signalId !== q.signalId
            || prev.executionId !== q.executionId || prev.jobId !== q.jobId) {
          throw new Error('replay changed original canonical obligation');
        }
      } else {
        state.canonicalByFixture.set(q.fixtureId, {
          sourceTradeId: q.sourceTradeId, signalId: q.signalId, executionId: q.executionId, jobId: q.jobId,
        });
      }
      const admittedAt = nowDate().toISOString();
      const existingAdm = state.admissions.find(a => a.attemptId === q.attemptId);
      if (!existingAdm) {
        const execRow = state.executions.find(e => e.id === q.executionId);
        const srcRow = state.sourceTrades.find(s => s.id === q.sourceTradeId);
        const fixtureId = q.fixtureId;
        const attemptRoute = state.signals.find(sig => sig.id === q.signalId);
        void attemptRoute;
        const bindingRow = state.bindings.find(b => b.source_trade_id === q.sourceTradeId);
        const kind: 'wallet' | 'token' = fixtureId === FIXTURE_WALLET ? 'wallet' : 'token';
        const reqDigest = loadDigest(loadFixtureRequest({
          scope: q.scope, fixtureId, userId: q.userId, kind,
          walletAddress: srcRow?.wallet_address ?? walletAddress,
          tokenMint: execRow?.token_mint ?? bindingRow?.binding?.tokenMint ?? tokenMintWallet,
        }));
        state.admissions.push({
          attemptId: q.attemptId, fixtureId, runId: q.scope.runId, namespace: q.scope.namespace,
          userId: q.userId, requestDigest: reqDigest, outcome: outcomeKind, reason: null,
          sourceTradeId: q.sourceTradeId, signalId: q.signalId, executionId: q.executionId,
          jobId: q.jobId, admittedAt,
        });
      }
      return reply([{
        outcome: {
          attempt_id: q.attemptId, run_id: q.scope.runId, fixture_id: q.fixtureId,
          user_id: q.userId, source_trade_id: q.sourceTradeId, signal_id: q.signalId,
          execution_id: q.executionId, job_id: q.jobId, outcome: outcomeKind, reason: null, admitted_at: admittedAt,
        },
      }]);
    }

    // Worker capability claim
    if (sql.includes('public.swat_claim_runtime_capability')) {
      const exec = state.executions.find(e => e.id === values[0]);
      if (!exec) return reply([]);
      exec.capability_id ??= randomUUID();
      return reply([{
        capability_id: exec.capability_id, revision: 'offline-cap-v1', execution_id: exec.id,
        user_id: exec.user_id, chain: exec.chain, token_mint: exec.token_mint,
        target_account: exec.target_account, execution_mode: exec.execution_mode,
        obligation_kind: 'fanout', obligation_id: exec.signal_id,
        backend_identity: scope.backendIdentity,
        observed_at: nowDate(), expires_at: new Date(nowDate().getTime() + 60_000),
      }]);
    }

    // Observer scans (must check BEFORE generic table handlers where patterns overlap)
    if (sql.includes('FROM public.source_trades outer_source')) {
      const prefix = String(values[0] ?? '').replace(/%$/, '');
      const tokens = (values[2] as string[]) ?? [];
      const rows = state.sourceTrades
        .filter(s => s.source_event_id.startsWith(prefix) || tokens.includes(s.token_mint))
        .map(s => {
          const b = state.bindings.find(x => x.source_trade_id === s.id);
          const h = state.heads.find(x => x.source_trade_id === s.id);
          const app = state.sourceApplications.find(x => x.source_trade_id === s.id);
          return {
            id: s.id, binding: b?.binding ?? null, bindingDigest: b?.binding_digest ?? null,
            evidenceId: h?.evidence_id ?? null, finality: h?.confirmation_state ?? null,
            applicationActive: app?.active ?? false,
            accepted: Boolean(b && h && app?.active && ['confirmed', 'finalized'].includes(s.confirmation_state)),
          };
        });
      return reply(rows);
    }
    if (sql.includes('FROM public.copy_executions WHERE token_mint=ANY($1::text[])')) {
      const tokens = (values[0] as string[]) ?? [];
      const srcIds = (values[1] as string[]) ?? [];
      const rows = state.executions
        .filter(e => tokens.includes(e.token_mint) || srcIds.includes(e.source_trade_id))
        .map(e => ({
          id: e.id, signalId: e.signal_id, sourceTradeId: e.source_trade_id, userId: e.user_id,
          targetAccount: e.target_account, chain: e.chain, tokenMint: e.token_mint, direction: e.direction,
          executionMode: e.execution_mode, state: e.state, requestedBase: e.requested_base_quantity,
          requestedQuote: e.requested_quote_quantity, confirmedBase: e.confirmed_base_quantity,
          confirmedQuote: e.confirmed_quote_quantity, quoteUnknown: String(e.quote_unassessed_fill_count),
        }));
      return reply(rows);
    }
    if (sql.includes('FROM public.source_fanout_deliveries delivery WHERE')) {
      const ids = (values[0] as string[]) ?? [];
      const signals = (values[1] as string[]) ?? [];
      const tokens = (values[2] as string[]) ?? [];
      const rows = state.deliveries
        .filter(d => ids.includes(d.execution_id) || signals.includes(d.signal_id) || tokens.includes(d.descriptor?.data?.tokenMint))
        .map(d => ({
          executionId: d.execution_id, signalId: d.signal_id, userId: d.user_id,
          targetAccount: d.target_account, executionMode: d.execution_mode,
          jobId: d.job_id, state: d.state, fence: d.fence, descriptor: d.descriptor,
        }));
      return reply(rows);
    }
    if (sql.includes('FROM public.copy_execution_worker_attempts')) {
      const ids = (values[0] as string[]) ?? [];
      return reply(state.workerAttempts.filter(a => ids.includes(a.execution_id)).map(a => ({
        executionId: a.execution_id, userId: a.user_id, fence: a.fence,
        policyRevision: a.policy_revision, riskEpoch: a.risk_epoch, state: a.state,
      })));
    }
    if (sql.includes('FROM public.worker_effective_execution_evidence evidence')) {
      const ids = (values[0] as string[]) ?? [];
      return reply(state.evidence.filter(ev => ids.includes(ev.execution_id)).map(ev => {
        const ex = state.executions.find(e => e.id === ev.execution_id)!;
        const app = state.positionApplications.find(a => a.evidence_id === ev.id);
        return {
          id: ev.id, executionId: ev.execution_id, userId: ex.user_id, sourceTradeId: ex.source_trade_id,
          evidenceId: ev.evidence_id, evidenceType: ev.evidence_type, confirmationState: ev.confirmation_state,
          completes: ev.completes_execution, base: ev.base_quantity, quote: ev.quote_quantity, fee: ev.fee_usd,
          quoteCurrency: ev.quote_currency, nativeQuote: ev.quote_native_quantity,
          nativePrice: ev.quote_native_usd_price, effectiveQuote: ev.quote_quantity, effectiveFee: ev.fee_usd,
          correctionId: null, applicationActive: app?.active ?? false,
        };
      }));
    }
    if (sql.includes('FROM public.trades')) {
      const ids = (values[0] as string[]) ?? [];
      const tokens = (values[1] as string[]) ?? [];
      return reply(state.trades.filter(t => ids.includes(t.copy_execution_id) || tokens.includes(t.token_mint)).map(t => ({
        id: t.id, executionId: t.copy_execution_id, userId: t.user_id, signalId: t.signal_id,
        sourceTradeId: t.source_trade_id, tokenMint: t.token_mint, chain: t.chain, direction: t.direction,
        executionMode: t.execution_mode, base: t.token_amount, quote: t.amount_usd, fee: t.fee_usd, status: t.status,
      })));
    }
    if (sql.includes('FROM public.copy_execution_financial_receipts') && sql.includes('LIMIT 10001')) {
      const ids = (values[0] as string[]) ?? [];
      return reply(state.receipts.filter(r => ids.includes(r.execution_id)));
    }
    if (sql.includes('FROM public.copy_position_applications application WHERE')) {
      const ids = (values[0] as string[]) ?? [];
      const tokens = (values[1] as string[]) ?? [];
      return reply(state.positionApplications.filter(a => ids.includes(a.execution_id) || tokens.includes(a.token_mint)).map(a => ({
        evidenceId: a.evidence_id, executionId: a.execution_id, positionId: a.position_id,
        userId: a.user_id, targetAccount: a.target_account, tokenMint: a.token_mint, chain: a.chain, active: a.active,
      })));
    }
    if (sql.includes('FROM public.copy_positions')) {
      const tokens = (values[0] as string[]) ?? [];
      return reply(state.positions.filter(p => tokens.includes(p.token_mint)).map(p => ({
        id: p.id, userId: p.user_id, targetAccount: p.target_account, tokenMint: p.token_mint,
        chain: p.chain, base: p.confirmed_quantity, basis: p.cost_basis_usd,
      })));
    }
    if (sql.includes('FROM public.copy_position_master_lots lot')) {
      const tokens = (values[0] as string[]) ?? [];
      const ids = (values[1] as string[]) ?? [];
      return reply(state.lots.filter(l => tokens.includes(l.token_mint) || ids.includes(l.acquisition_execution_id)).map(l => {
        const ex = state.executions.find(e => e.id === l.acquisition_execution_id)!;
        return {
          id: l.id, positionId: l.position_id, userId: l.user_id, tokenMint: l.token_mint, chain: l.chain,
          masterWalletAddress: l.master_wallet_address, acquisitionExecutionId: l.acquisition_execution_id,
          acquisitionEvidenceId: l.acquisition_evidence_id, acquisitionSourceTradeId: l.source_trade_id,
          acquisitionMode: ex.execution_mode, acquiredBase: l.acquired_quantity, remainingBase: l.remaining_quantity,
          acquiredBasis: l.acquired_cost_basis_usd, remainingBasis: l.remaining_cost_basis_usd,
        };
      }));
    }
    if (sql.includes('FROM public.risk_spend_reservations WHERE execution_id=ANY')) {
      const ids = (values[0] as string[]) ?? [];
      return reply(state.riskReservations.filter(r => ids.includes(r.execution_id)).map(r => ({
        executionId: r.execution_id, account: r.account, epoch: r.policy_epoch, state: r.state,
        debit: r.confirmed_usd, liability: r.liability_usd, chain: r.chain, executionMode: r.execution_mode,
      })));
    }
    if (sql.includes('FROM public.master_capacity_ledger WHERE source_trade_id=ANY')) {
      const srcIds = (values[0] as string[]) ?? [];
      const tokens = (values[1] as string[]) ?? [];
      return reply(state.capacityLedger.filter(c => srcIds.includes(c.source_trade_id) || tokens.includes(c.token_mint)).map(c => ({
        sourceTradeId: c.source_trade_id, executionMode: c.execution_mode, notional: c.notional_usd,
        chain: c.chain, tokenMint: c.token_mint, masterWalletAddress: c.master_wallet_address,
      })));
    }
    if (sql.includes('FROM public.copy_execution_valuation_corrections')) return reply([]);
    if (sql.includes('FROM public.copy_position_master_lot_reductions')) return reply([]);

    // Source intake & verification
    if (sql.includes('INSERT INTO source_trades')) {
      const exists = state.sourceTrades.find(s => s.chain === values[0] && s.source_event_type === values[10]
        && s.source_event_id === values[11] && s.source_event_index === values[12]);
      if (exists) return reply([], 0);
      const row = {
        id: randomUUID(), chain: values[0], transaction_hash: values[1], wallet_address: values[2],
        token_mint: values[3], direction: values[4], amount_usd: values[5], token_amount: values[6],
        price_usd: values[7], fee_usd: values[8], status: values[9], source_event_type: values[10],
        source_event_id: values[11], source_event_index: values[12], event_at: values[13], observed_at: values[14],
        confirmation_state: values[9], confirmation_updated_at: values[14],
      };
      state.sourceTrades.push(row);
      return reply([{ id: row.id }], 1);
    }
    if (sql.includes('AS payload_matches') && sql.includes('FROM source_trades')) {
      const row = state.sourceTrades.find(s => s.chain === values[0] && s.source_event_type === values[1]
        && s.source_event_id === values[2] && s.source_event_index === values[3]);
      if (!row) return reply([]);
      return reply([{ ...row, quantity: row.token_amount, payload_matches: true }]);
    }
    if (sql.includes('INSERT INTO source_verification_bindings')) {
      if (!state.bindings.some(b => b.source_trade_id === values[0])) {
        state.bindings.push({ source_trade_id: values[0], binding: JSON.parse(String(values[1])),
          binding_digest: values[2], network: values[3], raw_quantity: values[4], quantity_scale: values[5] });
      }
      return reply([]);
    }
    if (sql.includes('SELECT binding_digest FROM source_verification_bindings')) {
      const row = state.bindings.find(b => b.source_trade_id === values[0]);
      return reply(row ? [{ binding_digest: row.binding_digest }] : []);
    }
    if (sql.includes('INSERT INTO source_trade_confirmation_history')) return reply([]);
    if (sql.includes('SELECT wallet_address, chain, token_mint FROM source_trades WHERE id = $1')) {
      const row = state.sourceTrades.find(s => s.id === values[0]);
      return reply(row ? [{ wallet_address: row.wallet_address, chain: row.chain, token_mint: row.token_mint }] : []);
    }
    if (sql.includes('direction, transaction_hash, source_event_type') && sql.includes('FROM source_trades WHERE id = $1')) {
      const row = state.sourceTrades.find(s => s.id === values[0]);
      return reply(row ? [row] : []);
    }
    if (sql.includes('SELECT binding, binding_digest FROM source_verification_bindings')) {
      const row = state.bindings.find(b => b.source_trade_id === values[0]);
      return reply(row ? [{ binding: row.binding, binding_digest: row.binding_digest }] : []);
    }
    if (sql.includes('FROM source_provider_authorities')) {
      return reply([{
        identity_digest: providerIdentityDigest, provider_id: 'inert-provider',
        chain: 'solana', network: scope.network, verifier_version: 'inert-v1',
        valid_until: new Date(futureAt), enabled: true,
      }]);
    }
    if (sql.includes('INSERT INTO source_verified_evidence')) {
      if (state.verifiedEvidence.some(e => e.evidence_id === values[0])) return reply([], 0);
      state.verifiedEvidence.push({
        evidence_id: values[0], source_trade_id: values[1], binding_digest: values[2], evidence_digest: values[3],
        provider_id: values[4], authority_id: values[5], provider_identity_digest: values[6],
        provider_valid_until: values[7], verifier_version: values[8], finality: values[9],
        revision: String(values[10]), reverses_evidence_id: values[11], evidence: JSON.parse(String(values[12])),
      });
      return reply([], 1);
    }
    if (sql.includes('FROM source_verified_evidence WHERE evidence_id = $1')) {
      const row = state.verifiedEvidence.find(e => e.evidence_id === values[0]);
      return reply(row ? [{ source_trade_id: row.source_trade_id, evidence_digest: row.evidence_digest }] : []);
    }
    if (sql.includes('FROM source_verification_heads head')) {
      const h = state.heads.find(x => x.source_trade_id === values[0]);
      if (!h) return reply([]);
      const ev = state.verifiedEvidence.find(e => e.evidence_id === h.evidence_id)!;
      return reply([{ evidence_id: h.evidence_id, revision: h.revision, confirmation_state: h.confirmation_state, authority_id: ev.authority_id }]);
    }
    if (sql.includes('FROM source_verification_history WHERE evidence_id')) {
      return reply([{ exists: state.heads.some(h => h.evidence_id === values[0]) }]);
    }
    if (sql.includes('INSERT INTO source_verified_position_scopes') || sql.includes('INSERT INTO wallet_positions')
        || sql.includes('INSERT INTO source_verification_history') || sql.includes('WITH RECURSIVE scope AS')) {
      return reply([]);
    }
    if (sql.includes('FROM source_verified_position_scopes')) {
      const b = state.bindings.find(x => x.binding.walletAddress === values[0] && x.binding.tokenMint === values[2]);
      return reply([{ network: scope.network, quantity_scale: b?.quantity_scale ?? 9 }]);
    }
    if (sql.includes('AS unsafe') && sql.includes('FROM wallet_positions')) return reply([{ unsafe: false }]);
    if (sql.includes('INSERT INTO source_position_applications')) {
      const existing = state.sourceApplications.find(a => a.source_trade_id === values[0]);
      if (existing) existing.active = values[4];
      else state.sourceApplications.push({ source_trade_id: values[0], wallet_address: values[1], chain: values[2], token_mint: values[3], active: values[4] });
      return reply([]);
    }
    if (sql.includes('UPDATE source_trades SET confirmation_state')) {
      const row = state.sourceTrades.find(s => s.id === values[0]);
      if (row) { row.confirmation_state = values[1]; row.status = values[1]; }
      return reply([]);
    }
    if (sql.includes('INSERT INTO source_verification_heads')) {
      state.heads.push({ source_trade_id: values[0], evidence_id: values[1], revision: String(values[2]), confirmation_state: values[3] });
      return reply([]);
    }
    if (sql.includes('AS verified') && sql.includes('FROM source_trades source')) return reply([{ verified: true }]);
    if (sql.includes('SELECT true AS accepted FROM source_trades source')) {
      const s = state.sourceTrades.find(x => x.id === values[0]);
      const ok = Boolean(s && ['confirmed', 'finalized'].includes(s.confirmation_state) && state.heads.some(h => h.source_trade_id === s.id));
      return reply(ok ? [{ accepted: true }] : []);
    }

    // Signals
    if (sql.includes('SELECT source.wallet_address FROM source_trades source JOIN signals signal')) {
      const src = state.sourceTrades.find(s => s.id === values[0] && s.chain === values[2] && s.token_mint === values[3] && s.direction === values[4]);
      const sig = state.signals.find(x => x.id === values[1] && x.source_trade_id === values[0]);
      return reply(src && sig ? [{ wallet_address: src.wallet_address }] : []);
    }
    if (sql.includes('FROM source_trades') && sql.includes('WHERE id = $1')) {
      const row = state.sourceTrades.find(s => s.id === values[0]);
      return reply(row ? [{ ...row, quantity: row.token_amount }] : []);
    }
    if (sql.includes('INSERT INTO signals')) {
      const existing = state.signals.find(s => s.source_trade_id === values[12]);
      if (existing) return reply([], 0);
      const s = state.sourceTrades.find(x => x.id === values[12])!;
      const row = {
        id: randomUUID(), token_mint: values[1], chain: values[2], confidence: values[3], signal_score: values[4],
        trigger_data: JSON.parse(String(values[5])), status: 'eligible', detected_at: values[10],
        expires_at: new Date(new Date(values[10] as Date).getTime() + Number(values[11])),
        source_trade_id: values[12], source_side: values[13],
        source_position_before_quantity: values[14], source_position_evidence_at: values[15],
        source_sell_fraction: values[16],
      };
      state.signals.push(row);
      state.capacityLedger.push({
        source_trade_id: s.id, execution_mode: 'paper', notional_usd: null, notional_basis: 'unpriced',
        unassessed_fill_count: 0, chain: s.chain, token_mint: s.token_mint, master_wallet_address: s.wallet_address,
      });
      return reply([{
        id: row.id, source_trade_id: row.source_trade_id, chain: row.chain, token_mint: row.token_mint,
        source_side: row.source_side, source_position_before_quantity: row.source_position_before_quantity,
        source_sell_fraction: row.source_sell_fraction,
      }], 1);
    }
    if (sql.includes('FROM signals') && sql.includes('WHERE source_trade_id = $1')) {
      const row = state.signals.find(s => s.source_trade_id === values[0]);
      return reply(row ? [{
        id: row.id, source_trade_id: row.source_trade_id, chain: row.chain, token_mint: row.token_mint,
        source_side: row.source_side, source_position_before_quantity: row.source_position_before_quantity,
        source_sell_fraction: row.source_sell_fraction,
      }] : []);
    }
    if (sql.includes('SELECT id, source_trade_id, source_side FROM signals WHERE id = $1')) {
      const row = state.signals.find(s => s.id === values[0]);
      return reply(row ? [{ id: row.id, source_trade_id: row.source_trade_id, source_side: row.source_side }] : []);
    }
    if (sql.includes('FROM signals') && sql.includes('WHERE id = $1') && sql.includes('FOR UPDATE')) {
      const row = state.signals.find(s => s.id === values[0]);
      return reply(row ? [row] : []);
    }
    if (sql.includes('UPDATE signals') && sql.includes("status = 'executing'")) {
      const row = state.signals.find(s => s.id === values[0]);
      if (row) row.status = 'executing';
      return reply([]);
    }
    if (sql.includes('UPDATE signals') && sql.includes("status = 'executed'")) {
      const row = state.signals.find(s => s.id === values[0]);
      if (row) row.status = 'executed';
      return reply([]);
    }

    // Fanout candidates, policy, and batches/deliveries
    if (sql.includes('FROM user_wallet_subscriptions subscription')) {
      return reply([{
        user_id: USER, active_since: new Date('2026-11-01T00:00:00.000Z'), subscription_state: 'active',
        tier: 'pro', tier_expires_at: new Date('2030-01-01T00:00:00.000Z'),
        auto_execute: true, killed: false, min_signal_score: 80, max_concurrent_positions: 10, open_position_count: '0',
      }]);
    }
    if (sql.includes('FROM user_balances')) {
      return reply([{ user_id: USER, chain: 'solana', asset: 'USDC', amount: 1000000, decimals: 6,
        usd: 1000000, usd_priced_at: nowDate(), fetched_at: nowDate(), source: 'poller' }]);
    }
    if (sql.includes('FROM users account LEFT JOIN user_execution_settings')) {
      return reply([{ status: 'active', auto_execute: true, killed: false, mode: 'paper', state: 'active' }]);
    }
    if (sql.includes("FROM config WHERE key = 'blacklist'")) return reply([]);
    if (sql.includes("FROM config") && sql.includes("'trading'")) {
      const updatedAt = new Date('2026-11-01T00:00:00.000Z');
      return reply([
        { key: 'execution_config', value: { solana: 'paper', '*': 'paper' }, updated_at: updatedAt },
        { key: 'signals', value: { auto_execute_min_score: 80 }, updated_at: updatedAt },
        { key: 'trading', value: { enabled: true }, updated_at: updatedAt },
      ]);
    }
    if (sql.includes('SELECT status FROM users WHERE id = $1')) return reply([{ status: 'active' }]);
    if (sql.includes('FROM user_execution_settings WHERE user_id = $1')) {
      return reply([{ max_position_pct: '100', auto_execute: true, killed: false, min_signal_score: 80, updated_at: new Date('2026-11-01T00:00:00.000Z') }]);
    }
    if (sql.includes('FROM user_chain_execution_settings')) {
      return reply([{ mode: 'paper', max_slippage_bps: 100, updated_at: new Date('2026-11-01T00:00:00.000Z') }]);
    }
    if (sql.includes('FROM user_wallet_subscriptions WHERE user_id = $1')) {
      return reply([{ state: 'active', active_since: new Date('2026-11-01T00:00:00.000Z'), wound_down_at: null, ended_at: null, close_all_requested_at: null }]);
    }
    if (sql.includes('FROM risk_policy_control control')) {
      return reply([{ cap_usd: '99999999999999999999', enabled: true, accounting_ready: true, spent: '0', unknown: false }]);
    }
    if (sql.includes('INSERT INTO source_fanout_batches')) {
      let b = state.batches.find(x => x.signal_id === values[0]);
      if (!b) {
        b = { signal_id: values[0], source_trade_id: values[1], state: 'pending', fence: '0', lease_owner: null, lease_until: null, recipient_snapshot: null, exclusion_snapshot: null };
        state.batches.push(b);
      }
      return reply([{ signal_id: b.signal_id }]);
    }
    if (sql.includes('FROM source_fanout_batches WHERE signal_id = $1')) {
      const b = state.batches.find(x => x.signal_id === values[0]);
      return reply(b ? [b] : []);
    }
    if (sql.includes('UPDATE source_fanout_batches SET state = \'enumerating\'')) {
      const b = state.batches.find(x => x.signal_id === values[0] && x.source_trade_id === values[1] && x.state === 'pending');
      if (!b) return reply([]);
      b.state = 'enumerating'; b.fence = String(Number(b.fence) + 1); b.lease_owner = values[2]; b.lease_until = values[4];
      return reply([{ fence: b.fence }]);
    }
    if (sql.includes("UPDATE source_fanout_batches SET state = 'pending'")) {
      const b = state.batches.find(x => x.signal_id === values[0] && x.source_trade_id === values[1] && x.lease_owner === values[2] && x.fence === values[3]);
      if (!b) return reply([]);
      b.state = 'pending'; b.lease_owner = null; b.lease_until = null;
      return reply([{ signal_id: b.signal_id }]);
    }
    if (sql.includes('UPDATE source_fanout_batches SET state = \'complete\'')) {
      const b = state.batches.find(x => x.signal_id === values[0] && x.source_trade_id === values[1] && x.lease_owner === values[2] && x.fence === values[3]);
      if (!b) return reply([]);
      b.state = 'complete'; b.recipient_snapshot = JSON.parse(String(values[4])); b.exclusion_snapshot = JSON.parse(String(values[5]));
      b.lease_owner = null; b.lease_until = null;
      return reply([{ signal_id: b.signal_id }]);
    }
    if (sql.includes('FROM signals signal') && sql.includes('JOIN source_trades source ON source.id = signal.source_trade_id')) {
      const sig = state.signals.find(x => x.id === values[0]);
      const src = state.sourceTrades.find(x => x.id === values[1]);
      if (!sig || !src) return reply([]);
      return reply([{ chain: src.chain, token_mint: src.token_mint, wallet_address: src.wallet_address,
        direction: src.direction, event_at: src.event_at, confirmation_state: src.confirmation_state }]);
    }
    if (sql.includes('INSERT INTO source_fanout_deliveries')) {
      state.deliveries.push({
        signal_id: values[0], user_id: values[1], execution_mode: values[2], target_account: values[3],
        job_id: values[4], descriptor: JSON.parse(String(values[5])), execution_id: values[6],
        state: 'pending', fence: '1', lease_owner: null, lease_until: null, last_reason: null,
      });
      return reply([]);
    }
    if (sql.includes("FROM source_fanout_deliveries") && sql.includes("state <> 'completed'")) {
      return reply(state.deliveries.filter(d => d.signal_id === values[0] && d.state !== 'completed'));
    }
    if (sql.includes('FROM source_fanout_deliveries delivery') && sql.includes('JOIN source_fanout_batches batch')) {
      const d = state.deliveries.find(x => x.signal_id === values[0] && x.user_id === values[1] && x.execution_mode === values[2] && x.target_account === values[3]);
      if (!d) return reply([]);
      const b = state.batches.find(x => x.signal_id === d.signal_id)!;
      const src = state.sourceTrades.find(x => x.id === b.source_trade_id)!;
      return reply([{ ...d, scope_chain: src.chain, scope_token_mint: src.token_mint }]);
    }
    if (sql.includes('FROM source_fanout_deliveries') && sql.includes('WHERE signal_id = $1 AND user_id IS NOT DISTINCT FROM $2')) {
      const d = state.deliveries.find(x => x.signal_id === values[0] && x.user_id === values[1] && x.execution_mode === values[2] && x.target_account === values[3]);
      return reply(d ? [d] : []);
    }
    if (sql.includes('FROM source_fanout_deliveries') && sql.includes('WHERE execution_id = $1')) {
      const d = state.deliveries.find(x => x.execution_id === values[0] && x.signal_id === values[1]
        && x.user_id === values[2] && x.execution_mode === values[3] && x.target_account === values[4]);
      return reply(d ? [d] : []);
    }
    if (sql.includes("UPDATE source_fanout_deliveries SET state = 'claimed'")) {
      const d = state.deliveries.find(x => x.signal_id === values[0] && x.user_id === values[1] && x.execution_mode === values[2] && x.target_account === values[3]);
      if (!d) return reply([]);
      d.state = 'claimed'; d.fence = String(Number(d.fence) + 1); d.lease_owner = values[4]; d.lease_until = values[5];
      return reply([{ fence: d.fence }]);
    }
    if (sql.includes("UPDATE source_fanout_deliveries SET state = 'pending'")) {
      const d = state.deliveries.find(x => x.signal_id === values[0] && x.user_id === values[1] && x.execution_mode === values[2] && x.target_account === values[3]
        && x.lease_owner === values[4] && x.fence === values[5] && x.state === 'claimed');
      if (!d) return reply([]);
      d.state = 'pending'; d.lease_owner = null; d.lease_until = null;
      return reply([d]);
    }
    if (sql.includes("state = CASE WHEN state = 'pending' THEN 'queued'")) {
      const d = state.deliveries.find(x => x.signal_id === values[0] && x.user_id === values[1] && x.execution_mode === values[2] && x.target_account === values[3]);
      if (!d) return reply([]);
      if (d.state === 'pending') d.state = 'queued';
      return reply([{ signal_id: d.signal_id }]);
    }
    if (sql.includes('UPDATE source_fanout_deliveries SET state = $7')) {
      const d = state.deliveries.find(x => x.signal_id === values[0] && x.user_id === values[1] && x.execution_mode === values[2] && x.target_account === values[3]
        && x.lease_owner === values[4] && x.fence === values[5] && x.state === 'claimed');
      if (!d) return reply([]);
      d.state = values[6]; d.last_reason = values[7]; d.lease_owner = null; d.lease_until = null;
      return reply([{ signal_id: d.signal_id }]);
    }

    // Copy positions & executions
    if (sql.includes('INSERT INTO copy_positions')) {
      if (!state.positions.some(p => p.target_account === values[0] && p.chain === values[1] && p.token_mint === values[2] && p.user_id === values[3])) {
        state.positions.push({
          id: randomUUID(), target_account: values[0], chain: values[1], token_mint: values[2], user_id: values[3],
          confirmed_quantity: '0', reserved_sell_quantity: '0', cost_basis_usd: '0', total_acquired_quantity: '0',
          total_reduced_quantity: '0', unmatched_reduction_quantity: '0', cost_basis_unvalued_fill_count: 0, last_evidence_at: null,
        });
      }
      return reply([]);
    }
    if (sql.includes('SELECT id') && sql.includes('FROM copy_positions')) {
      const p = state.positions.find(x => x.target_account === values[0] && x.chain === values[1] && x.token_mint === values[2] && x.user_id === values[3]);
      return reply(p ? [{ id: p.id }] : []);
    }
    if (sql.includes('SELECT target_account, chain, token_mint, user_id FROM copy_executions WHERE id = $1')) {
      const ex = state.executions.find(e => e.id === values[0]);
      return reply(ex ? [{ target_account: ex.target_account, chain: ex.chain, token_mint: ex.token_mint, user_id: ex.user_id }] : []);
    }
    if (sql.includes('SELECT EXISTS(') && sql.includes('FROM copy_executions WHERE signal_id = $1')) {
      return reply([{ exists: state.executions.some(e => e.signal_id === values[0]) }]);
    }
    if (sql.includes('SELECT source_trade_id FROM master_capacity_ledger')) {
      const c = state.capacityLedger.find(x => x.source_trade_id === values[0] && x.execution_mode === values[1]);
      return reply(c ? [{ source_trade_id: c.source_trade_id }] : []);
    }
    if (sql.includes('SELECT confirmed_quote_quantity::text FROM copy_executions WHERE id = $1')) {
      const ex = state.executions.find(e => e.id === values[0]);
      return reply(ex ? [{ confirmed_quote_quantity: ex.confirmed_quote_quantity }] : []);
    }
    if (sql.includes('AS proven_non_submitted FROM copy_executions')) {
      const rows = state.executions
        .filter(e => (e.signal_id === values[0] && e.user_id === values[1] && e.execution_mode === values[2] && e.target_account === values[3]) || e.id === values[4])
        .map(e => ({
          ...e,
          proven_non_submitted: e.submission_id === null && e.submission_attempts === 0 && e.confirmed_base_quantity === '0'
            && ['requested', 'simulated', 'failed', 'cancelled'].includes(e.state)
            && !state.evidence.some(ev => ev.execution_id === e.id)
            && !state.workerAttempts.some(a => a.execution_id === e.id),
        }));
      return reply(rows);
    }
    if (sql.includes('SELECT id, target_account, chain, token_mint, user_id FROM copy_executions')) {
      const rows = state.executions.filter(e =>
        (e.signal_id === values[0] && e.user_id === values[1] && e.execution_mode === values[2] && e.target_account === values[3]) || e.id === values[4]);
      return reply(rows);
    }
    if (sql.includes('FROM copy_executions') && sql.includes('WHERE source_trade_id = $1')) {
      const ex = state.executions.find(e => e.source_trade_id === values[0] && e.target_account === values[1] && e.execution_mode === values[2] && e.user_id === values[3]);
      return reply(ex ? [ex] : []);
    }
    if (sql.includes('AS matches') && sql.includes('FROM copy_executions WHERE id = $1')) {
      const ex = state.executions.find(e => e.id === values[0]);
      return reply([{ matches: Boolean(ex && ex.requested_base_quantity === values[1] && ex.requested_quote_quantity === values[2]) }]);
    }
    if (sql.includes('INSERT INTO copy_executions')) {
      const row = {
        id: randomUUID(), signal_id: values[0], source_trade_id: values[1], exit_lot_id: null, exit_trigger: null,
        chain: values[2], target_account: values[3], token_mint: values[4], direction: values[5], execution_mode: values[6],
        client_order_id: values[7], requested_base_quantity: values[8], requested_quote_quantity: values[9],
        confirmed_base_quantity: '0', confirmed_quote_quantity: null, quote_unassessed_fill_count: 0,
        reserved_base_quantity: '0', state: 'requested', submission_attempts: 0, max_submission_attempts: values[10],
        simulation_id: null, submission_type: null, submission_id: null, next_reconciliation_at: null,
        reconciliation_claim_id: null, reconciliation_attempts: 0, max_reconciliation_attempts: values[11],
        source_position_before_quantity: values[12], source_sell_fraction: values[13], user_id: values[14],
      };
      state.executions.push(row);
      return reply([row]);
    }
    if (sql.includes('INSERT INTO copy_execution_state_history')) return reply([]);
    if (sql.includes('FROM copy_executions') && sql.includes('WHERE id = $1') && sql.includes('FOR UPDATE')) {
      const ex = state.executions.find(e => e.id === values[0]);
      return reply(ex ? [ex] : []);
    }
    if (sql.includes('SELECT id FROM copy_executions WHERE id = $1')) {
      const ex = state.executions.find(e => e.id === values[0] && e.user_id === values[1] && e.target_account === values[2] && e.chain === values[3] && e.token_mint === values[4]);
      return reply(ex ? [{ id: ex.id }] : []);
    }
    if (sql.includes('AS quantified_confirmed')) {
      const ex = state.executions.find(e => e.id === values[4]);
      if (!ex) return reply([]);
      const evs = state.evidence.filter(ev => ev.execution_id === ex.id && ['confirmed', 'finalized'].includes(ev.confirmation_state));
      const apps = state.positionApplications.filter(a => a.execution_id === ex.id && a.active);
      const quantified = ex.confirmed_base_quantity !== '0' && evs.some(ev => ev.completes_execution)
        && evs.every(ev => apps.some(a => a.evidence_id === ev.id));
      return reply([{
        state: ex.state,
        submission_id: ex.submission_id,
        quantified_confirmed: quantified,
        proven_non_submitted: ex.submission_id === null && ex.submission_attempts === 0 && ex.confirmed_base_quantity === '0' && evs.length === 0,
      }]);
    }
    if (sql.includes('UPDATE copy_executions') && sql.includes('SET simulation_id')) {
      const ex = state.executions.find(e => e.id === values[0]);
      if (!ex) return reply([]);
      if (values[1] === 'simulated') ex.simulation_id = values[2];
      return reply([ex]);
    }
    if (sql.includes('UPDATE copy_executions') && sql.includes('SET state = $2::text')) {
      const ex = state.executions.find(e => e.id === values[0]);
      if (!ex) return reply([]);
      ex.state = values[1];
      if (values[3]) ex.simulation_id = values[3];
      return reply([ex]);
    }
    if (sql.includes('UPDATE copy_executions') && sql.includes('SET confirmed_base_quantity')) {
      const ex = state.executions.find(e => e.id === values[0]);
      if (!ex) return reply([]);
      ex.confirmed_base_quantity = values[1]; ex.confirmed_quote_quantity = values[2];
      ex.state = values[3]; ex.quote_unassessed_fill_count = Number(values[4]);
      return reply([ex]);
    }

    // Policy snapshots
    if (sql.includes('INSERT INTO copy_execution_policy_snapshots')) {
      if (!state.policySnapshots.some(p => p.execution_id === values[0])) {
        state.policySnapshots.push({
          execution_id: values[0], user_id: values[1], chain: values[2], target_account: values[3],
          token_mint: values[4], master_wallet_address: values[5], execution_mode: values[6],
          snapshot: JSON.parse(String(values[7])), minimum_score: values[8],
        });
      }
      return reply([]);
    }
    if (sql.includes('FROM copy_execution_policy_snapshots')) {
      const p = state.policySnapshots.find(x => x.execution_id === values[0] && x.user_id === values[1]
        && x.chain === values[2] && x.target_account === values[3] && x.token_mint === values[4]
        && x.master_wallet_address === values[5] && x.execution_mode === values[6]);
      return reply(p ? [{ snapshot: p.snapshot }] : []);
    }

    // Risk policy control & reservations
    if (sql.includes('SELECT epoch::text FROM risk_policy_control')) return reply([{ epoch: '1' }]);
    if (sql.includes('SELECT epoch::text, enabled, cap_usd::text, accounting_ready FROM risk_policy_control')) {
      return reply([{ epoch: '1', enabled: true, cap_usd: '99999999999999999999', accounting_ready: true }]);
    }
    if (sql.includes('SELECT epoch FROM risk_policy_control')) return reply([{ epoch: '1' }]);
    if (sql.includes('FROM risk_spend_reservations') && sql.includes('FOR UPDATE')) {
      return reply(state.riskReservations.filter(r => r.account === values[0] && r.chain === values[1] && r.execution_mode === values[2]));
    }
    if (sql.includes('INSERT INTO risk_spend_reservations')) {
      const row = {
        account: values[0], chain: values[1], execution_mode: values[2], execution_id: values[3],
        requested_usd: values[4], policy_epoch: values[5], liability_usd: values[4], confirmed_usd: '0', state: 'reserved',
      };
      state.riskReservations.push(row);
      return reply([{ execution_id: row.execution_id, state: row.state, liability_usd: row.liability_usd, confirmed_usd: row.confirmed_usd }]);
    }
    if (sql.includes('AS confirmed_usd') && sql.includes('FROM copy_executions execution')) {
      const evs = state.evidence.filter(e => e.execution_id === values[3]);
      const sum = evs.reduce((acc, e) => acc + Number(e.quote_quantity ?? 0) + Number(e.fee_usd ?? 0), 0);
      void sum;
      const ex = state.executions.find(e => e.id === values[3])!;
      let confirmedUsd: string | null = null;
      if (evs.length > 0) {
        const total = evs.reduce((acc, e) => {
          const [qw, qf = ''] = String(e.quote_quantity).split('.');
          const [fw, ff = ''] = String(e.fee_usd).split('.');
          return acc + BigInt(qw!) * 10n ** 18n + BigInt(qf.padEnd(18, '0')) + BigInt(fw!) * 10n ** 18n + BigInt(ff.padEnd(18, '0'));
        }, 0n);
        const frac = (total % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
        confirmedUsd = `${total / 10n ** 18n}${frac ? `.${frac}` : ''}`;
      }
      return reply([{
        state: ex.state, submission_id: ex.submission_id, confirmed_usd: confirmedUsd,
        unvalued_count: '0', completes_execution: evs.some(e => e.completes_execution),
      }]);
    }
    if (sql.includes('UPDATE risk_spend_reservations')) {
      const r = state.riskReservations.find(x => x.account === values[0] && x.chain === values[1] && x.execution_mode === values[2] && x.execution_id === values[3]);
      if (!r) return reply([]);
      r.state = values[4]; r.confirmed_usd = values[5]; r.liability_usd = values[6];
      return reply([{ execution_id: r.execution_id, state: r.state, liability_usd: r.liability_usd, confirmed_usd: r.confirmed_usd }]);
    }

    // Worker attempts
    if (sql.includes('FROM copy_execution_evidence WHERE execution_id = $1') && sql.includes('SELECT EXISTS')) {
      return reply([{ exists: state.evidence.some(e => e.execution_id === values[0]) }]);
    }
    if (sql.includes('INSERT INTO copy_execution_worker_attempts')) {
      if (state.workerAttempts.some(a => a.execution_id === values[0])) return reply([]);
      const d = state.deliveries.find(x => x.execution_id === values[0]);
      const fence = d ? d.fence : String(++state.fenceSeq);
      state.workerAttempts.push({ execution_id: values[0], user_id: values[1], policy_revision: values[2], risk_epoch: values[3], fence, state: 'prepared' });
      return reply([{ fence }]);
    }
    if (sql.includes('UPDATE copy_execution_worker_attempts SET state = \'dispatched\'')) {
      const a = state.workerAttempts.find(x => x.execution_id === values[0] && x.user_id === values[1] && x.fence === values[2] && x.policy_revision === values[3] && x.risk_epoch === values[4] && x.state === 'prepared');
      if (!a) return reply([]);
      a.state = 'dispatched'; return reply([{ execution_id: a.execution_id }]);
    }
    if (sql.includes('SELECT execution_id FROM copy_execution_worker_attempts')) {
      const a = state.workerAttempts.find(x => x.execution_id === values[0] && x.user_id === values[1] && x.fence === values[2] && x.policy_revision === values[3] && x.risk_epoch === values[4] && x.state === 'dispatched');
      return reply(a ? [{ execution_id: a.execution_id }] : []);
    }
    if (sql.includes('UPDATE copy_execution_worker_attempts SET state = $2')) {
      const a = state.workerAttempts.find(x => x.execution_id === values[0]);
      if (a) a.state = values[1];
      return reply([]);
    }

    // Evidence, applications, lots, rebuild, trades, receipts
    if (sql.includes('INSERT INTO copy_execution_evidence')) {
      if (!state.evidence.some(e => e.execution_id === values[0] && e.evidence_type === values[1] && e.evidence_id === values[2])) {
        state.evidence.push({
          id: randomUUID(), execution_id: values[0], evidence_type: values[1], evidence_id: values[2],
          base_quantity: values[3], quote_quantity: values[4], quote_native_quantity: values[5],
          quote_currency: values[6], quote_native_usd_price: values[7], price_usd: values[8],
          confirmation_state: values[9], completes_execution: values[10], occurred_at: values[11],
          observed_at: values[12], fee_usd: values[13],
        });
      }
      return reply([]);
    }
    if (sql.includes('AS payload_matches') && sql.includes('FROM copy_execution_evidence')) {
      const ev = state.evidence.find(e => e.execution_id === values[0] && e.evidence_type === values[1] && e.evidence_id === values[2]);
      return reply(ev ? [{ ...ev, payload_matches: true }] : []);
    }
    if (sql.includes('INSERT INTO copy_position_applications')) {
      const existing = state.positionApplications.find(a => a.evidence_id === values[0]);
      if (existing) { existing.active = values[5]; }
      else {
        state.positionApplications.push({
          evidence_id: values[0], execution_id: values[1], target_account: values[2], chain: values[3],
          token_mint: values[4], active: values[5], user_id: values[6], position_id: values[7],
        });
      }
      return reply([]);
    }
    if (sql.includes('FROM source_trades source') && sql.includes('JOIN copy_executions execution ON execution.source_trade_id = source.id')) {
      const ex = state.executions.find(e => e.id === values[0]);
      const src = ex ? state.sourceTrades.find(s => s.id === ex.source_trade_id) : null;
      return reply(src && ex ? [{ wallet_address: src.wallet_address, direction: src.direction, signal_id: ex.signal_id }] : []);
    }
    if (sql.includes('INSERT INTO copy_position_master_lots')) {
      if (!state.lots.some(l => l.acquisition_evidence_id === values[8])) {
        state.lots.push({
          id: randomUUID(), position_id: values[0], user_id: values[1], master_wallet_address: values[2],
          chain: values[3], token_mint: values[4], signal_id: values[5], source_trade_id: values[6],
          acquisition_execution_id: values[7], acquisition_evidence_id: values[8],
          acquired_quantity: values[9], remaining_quantity: values[9],
          acquired_cost_basis_usd: String(values[10]), remaining_cost_basis_usd: String(values[10]),
        });
      }
      return reply([]);
    }
    if (sql.includes('AS confirmed_base_quantity') && sql.includes('SUM(base_quantity)')) {
      const evs = state.evidence.filter(e => e.execution_id === values[0]);
      const b = evs.reduce((acc, e) => acc + Number(e.base_quantity), 0);
      void b;
      const last = evs[evs.length - 1];
      return reply([{
        confirmed_base_quantity: last?.base_quantity ?? '0',
        valued_quote_usd_sum: last?.quote_quantity ?? null,
        valued_fill_count: String(evs.filter(e => e.quote_quantity !== null).length),
        unvalued_fill_count: '0',
        completes_execution: evs.some(e => e.completes_execution),
      }]);
    }
    if (sql.includes('WITH RECURSIVE ordered_events AS')) {
      const pos = state.positions.find(p => p.target_account === values[0] && p.chain === values[1] && p.token_mint === values[2] && p.user_id === values[3])!;
      const apps = state.positionApplications.filter(a => a.target_account === values[0] && a.chain === values[1] && a.token_mint === values[2] && a.user_id === values[3] && a.active);
      let qtyUnits = 0n;
      let costUnits = 0n;
      for (const a of apps) {
        const ev = state.evidence.find(e => e.id === a.evidence_id)!;
        const [bw, bf = ''] = String(ev.base_quantity).split('.');
        qtyUnits += BigInt(bw!) * 10n ** 18n + BigInt(bf.padEnd(18, '0'));
        const [qw, qf = ''] = String(ev.quote_quantity).split('.');
        costUnits += BigInt(qw!) * 10n ** 18n + BigInt(qf.padEnd(18, '0'));
      }
      const fmt = (v: bigint) => {
        const f = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
        return `${v / 10n ** 18n}${f ? `.${f}` : ''}`;
      };
      pos.confirmed_quantity = fmt(qtyUnits);
      pos.cost_basis_usd = fmt(costUnits);
      pos.total_acquired_quantity = pos.confirmed_quantity;
      pos.last_evidence_at = nowDate();
      return reply([pos]);
    }
    if (sql.includes('AS "evidenceCount"') && sql.includes('FROM worker_effective_execution_evidence')) {
      const evs = state.evidence.filter(e => e.execution_id === values[0]);
      const ev = evs[0]!;
      const [qw, qf = ''] = String(ev.quote_quantity).split('.');
      const [fw, ff = ''] = String(ev.fee_usd).split('.');
      const debitUnits = BigInt(qw!) * 10n ** 18n + BigInt(qf.padEnd(18, '0')) + BigInt(fw!) * 10n ** 18n + BigInt(ff.padEnd(18, '0'));
      const df = (debitUnits % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
      const debit = `${debitUnits / 10n ** 18n}${df ? `.${df}` : ''}`;
      return reply([{
        base: ev.base_quantity, quote: ev.quote_quantity, debit, fee: ev.fee_usd,
        unknown: '0', quoteUnknown: '0', completes: ev.completes_execution,
        evidenceCount: String(evs.length), invalidCorrections: '0',
      }]);
    }
    if (sql.includes('AS authorized') && sql.includes('FROM worker_effective_execution_evidence')) return reply([{ authorized: true }]);
    if (sql.includes('UPDATE copy_executions execution SET') && sql.includes('confirmed_quote_quantity = totals.quote')) {
      const ex = state.executions.find(e => e.id === values[0] && e.user_id === values[1]);
      const ev = state.evidence.find(e => e.execution_id === values[0]);
      if (ex && ev) { ex.confirmed_quote_quantity = ev.quote_quantity; ex.quote_unassessed_fill_count = 0; }
      return reply(ex ? [{ id: ex.id }] : []);
    }
    if (sql.includes('UPDATE master_capacity_ledger ledger SET')) {
      const c = state.capacityLedger.find(x => x.source_trade_id === values[0] && x.execution_mode === values[1]);
      if (!c) return reply([]);
      const exIds = state.executions.filter(e => e.source_trade_id === values[0] && e.execution_mode === values[1]).map(e => e.id);
      const ev = state.evidence.find(e => exIds.includes(e.execution_id));
      if (ev) { c.notional_usd = ev.quote_quantity; c.notional_basis = 'marked-to-price'; }
      return reply([{ source_trade_id: c.source_trade_id }]);
    }
    if (sql.includes('UPDATE copy_positions position SET cost_basis_usd = final.basis')) {
      const pos = state.positions.find(p => p.target_account === values[0] && p.chain === values[1] && p.token_mint === values[2] && p.user_id === values[3]);
      if (!pos) return reply([]);
      const apps = state.positionApplications.filter(a => a.position_id === pos.id && a.active);
      let basisUnits = 0n;
      for (const a of apps) {
        const ev = state.evidence.find(e => e.id === a.evidence_id)!;
        const [qw, qf = ''] = String(ev.quote_quantity).split('.');
        const [fw, ff = ''] = String(ev.fee_usd).split('.');
        basisUnits += BigInt(qw!) * 10n ** 18n + BigInt(qf.padEnd(18, '0')) + BigInt(fw!) * 10n ** 18n + BigInt(ff.padEnd(18, '0'));
      }
      const bf = (basisUnits % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
      pos.cost_basis_usd = `${basisUnits / 10n ** 18n}${bf ? `.${bf}` : ''}`;
      return reply([{ id: pos.id }]);
    }
    if (sql.includes('UPDATE copy_position_master_lots lot SET')) {
      for (const l of state.lots) {
        if (l.user_id === values[3] && l.chain === values[1] && l.token_mint === values[2]) {
          const ev = state.evidence.find(e => e.id === l.acquisition_evidence_id && e.execution_id === l.acquisition_execution_id);
          if (ev) {
            const [qw, qf = ''] = String(ev.quote_quantity).split('.');
            const [fw, ff = ''] = String(ev.fee_usd).split('.');
            const u = BigInt(qw!) * 10n ** 18n + BigInt(qf.padEnd(18, '0')) + BigInt(fw!) * 10n ** 18n + BigInt(ff.padEnd(18, '0'));
            const f = (u % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
            const total = `${u / 10n ** 18n}${f ? `.${f}` : ''}`;
            l.acquired_cost_basis_usd = total; l.remaining_cost_basis_usd = total;
          }
        }
      }
      return reply([]);
    }
    if (sql.includes('INSERT INTO trades')) {
      const existing = state.trades.find(t => t.copy_execution_id === values[28]);
      if (existing) return reply([{ id: existing.id }]);
      const row = {
        id: randomUUID(), signal_id: values[0], token_mint: values[2], chain: values[3], direction: values[4],
        amount_usd: values[6], token_amount: values[7], fee_usd: values[9], execution_mode: values[12],
        executor: values[13], status: values[14], source_trade_id: values[27], copy_execution_id: values[28],
        user_id: values[30],
      };
      state.trades.push(row);
      return reply([{ id: row.id }]);
    }
    if (sql.includes('INSERT INTO copy_execution_financial_receipts')) {
      if (state.receipts.some(r => r.receipt_id === values[0])) return reply([]);
      state.receipts.push({
        receipt_id: values[0], execution_id: values[1], user_id: values[2], trade_id: values[3],
        worker_fence: values[4], accounting_complete: values[5], snapshot: JSON.parse(String(values[6])),
      });
      return reply([{ receipt_id: values[0] }]);
    }
    if (sql.includes('SELECT receipt_id FROM copy_execution_financial_receipts')) {
      const r = state.receipts.find(x => x.execution_id === values[0] && x.user_id === values[1] && x.accounting_complete);
      return reply(r ? [{ receipt_id: r.receipt_id }] : []);
    }

    throw new Error(`Unscripted P7 offline SQL (${role}): ${sql}`);
  }

  function makeTransaction(role: string, options: { readOnly?: boolean; isolation?: string } = {}) {
    return async <T>(action: (client: PoolClient) => Promise<T>): Promise<T> => {
      const saved = structuredClone({
        ...state,
        canonicalByFixture: [...state.canonicalByFixture.entries()],
      });
      const txState = {
        xid: String(++state.xidSeq),
        userScope: '',
        executionScope: '',
        readOnly: options.readOnly ?? false,
        isolation: options.isolation ?? 'read committed',
      };
      const client = {
        query: async (sql: string, values: unknown[] = []) => runQuery(role, sql, values, txState),
      } as unknown as PoolClient;
      try {
        return await action(client);
      } catch (err) {
        Object.assign(state, {
          ...saved,
          canonicalByFixture: new Map(saved.canonicalByFixture),
        });
        throw err;
      }
    };
  }

  return { state, makeTransaction };
}

describe('P7 synthetic consumer -> durable ledger end-to-end pipeline', () => {
  it('connects wallet + token + replay consumers through capture, queue, worker, observer, and exact BigInt drain conservation', async () => {
    let clockMs = Date.parse(at);
    const currentNow = () => new Date(clockMs);
    const db = createCanonicalLoadDbFixture(currentNow);
    const protectedCapture = createWave4LoadProtectedCapture();

    const walletInv = makeInvocation({
      kind: 'wallet',
      fixtureId: FIXTURE_WALLET,
      attemptId: ATTEMPT_WALLET,
      tokenMint: tokenMintWallet,
      rawQuantity: '9007199254740993000000000000000001',
      quantityScale: 18,
      base: { raw: '9007199254740993000000000000000002', scale: 18 },
      quoteBudget: { raw: '18014398509481986000000000000000005', scale: 18 },
      quote: { raw: '18014398509481986000000000000000004', scale: 18 },
      fee: { raw: '1', scale: 18 },
      status: 201,
    });
    const tokenInv = makeInvocation({
      kind: 'token',
      fixtureId: FIXTURE_TOKEN,
      attemptId: ATTEMPT_TOKEN,
      tokenMint: tokenMintToken,
      rawQuantity: '1000000000',
      quantityScale: 9,
      base: { raw: '5000000000', scale: 9 },
      quoteBudget: { raw: '20000000000', scale: 9 },
      quote: { raw: '20000000000', scale: 9 },
      fee: { raw: '20000000', scale: 9 },
      status: 201,
    });
    const replayWalletInv: LoadFixtureInvocation = {
      ...walletInv,
      attempt: {
        ...walletInv.attempt,
        attemptId: ATTEMPT_WALLET_REPLAY,
        status: 200,
        startedAt: at,
        finishedAt: at,
      },
    };

    const consumerPorts: LoadFixtureConsumerPorts = {
      scope,
      sourceTransaction: db.makeTransaction('swat_source_provider_writer'),
      protectedCapture,
      verifier: {
        validateProvider: async () => ({
          providerId: 'inert-provider',
          authorityId: AUTHORITY_ID,
          identityDigest: providerIdentityDigest,
          chain: 'solana',
          network: scope.network,
          verifierVersion: 'inert-v1',
          validUntil: futureAt,
        }),
        verifyEvidence: async ({ evidenceDigest }) => ({
          accepted: true,
          evidenceDigest,
          identityDigest: providerIdentityDigest,
        }),
      },
      policy: {
        transaction: db.makeTransaction('swat_fanout'),
        operatorAutoExecute: () => false,
        mode: async () => ({ configuredMode: 'paper', effectiveMode: 'paper', liveOptedIn: false, reason: 'paper' }),
        safety: async () => ({ isSafe: true }),
        capacity: async () => ({ capacity: { outcome: 'admit' }, decision: null, logLine: 'admit' }),
        paperTargetAccount: () => walletAddress,
        now: currentNow,
        minimumBalanceUsd: 0,
        minimumSignalScore: 80,
        maximumSourceEventAgeMs: 60_000,
        log: () => {},
        warn: () => {},
        error: () => {},
      },
      fanoutOwner: 'inert-fanout-owner',
      now: currentNow,
      maximumAgeMs: 60_000,
      signalTerms: { confidence: 95, signalScore: 90, triggerData: {}, maxEventAgeMs: 60_000, maxPositionEvidenceAgeMs: 60_000 },
      clusterTier: 'elite',
      workerTransaction: db.makeTransaction('swat_app'),
      authorize: async () => ({
        kind: 'granted',
        authority: {
          adapterId: 'inert-paper-adapter',
          chain: 'solana',
          principal: { kind: 'user', userId: USER },
          settlementAddress: walletAddress,
          signingAddress: walletAddress,
          capabilities: ['paper-simulate'],
          expiresAt: new Date(futureAt),
        } as any,
      }),
      platformMode: async () => 'paper',
      paperValuation: {
        providerId: 'inert-valuation-provider',
        providerIdentity: 'inert-valuation-identity',
        networkForChain: () => scope.network,
        readValuation: async execution => {
          const isWallet = execution.tokenMint === tokenMintWallet;
          return {
            providerId: 'inert-valuation-provider',
            providerIdentity: 'inert-valuation-identity',
            chain: 'solana',
            network: scope.network,
            tokenMint: execution.tokenMint,
            baseDecimals: isWallet ? 18 : 9,
            quoteCurrency: 'USD',
            priceUsd: isWallet ? '2' : '4',
            observedAt: currentNow(),
            expiresAt: new Date(currentNow().getTime() + 60_000),
            evidenceId: `val-${execution.id}`,
            simulationModelId: 'inert-paper-v1',
            simulatedFeeBps: isWallet ? '0' : '10',
            simulatedFixedFeeUsd: isWallet ? '0.000000000000000001' : '0',
          };
        },
      },
      followerSizing: {
        providerId: 'inert-sizing-provider',
        providerIdentity: 'inert-sizing-identity',
        networkForChain: () => scope.network,
        readBalance: async (_client, identity) => ({
          providerId: 'inert-sizing-provider',
          providerIdentity: 'inert-sizing-identity',
          evidenceId: `bal-${identity.tokenMint}`,
          userId: USER,
          chain: 'solana',
          network: scope.network,
          targetAccount: identity.targetAccount,
          executionMode: 'paper',
          availableUsd: identity.tokenMint === tokenMintWallet ? '18014398509481986.000000000000000005' : '20',
          observedAt: currentNow(),
          expiresAt: new Date(currentNow().getTime() + 60_000),
        }),
      },
      workerOwner: 'inert-worker-owner',
    };

    const consumers = createLoadFixtureConsumers(consumerPorts);

    // 1. Source + Fanout prepare for wallet and token fixtures
    const walletPrep = await consumers.wallet(walletInv);
    const tokenPrep = await consumers.token(tokenInv);
    expect(walletPrep.plan.users).toHaveLength(1);
    expect(tokenPrep.plan.users).toHaveLength(1);

    // 2. Replay HTTP attempt on wallet fixture before worker completion
    const replayPrep = await consumers.wallet(replayWalletInv);
    expect(replayPrep.plan.users).toHaveLength(1);
    expect(replayPrep.plan.users[0]!.data.copyExecutionId).toBe(walletPrep.plan.users[0]!.data.copyExecutionId);
    expect(db.state.admissions).toHaveLength(3);
    expect(db.state.admissions.filter(a => a.outcome === 'admitted')).toHaveLength(2);
    expect(db.state.admissions.filter(a => a.outcome === 'replay')).toHaveLength(1);
    expect(db.state.executions).toHaveLength(2);
    expect(db.state.deliveries).toHaveLength(2);

    // 3. Queue delivery
    const queueAdded: { name: string; data: unknown; options: unknown }[] = [];
    const queue: FanoutTradeQueue = {
      add: async (name, data, options) => {
        queueAdded.push({ name, data, options });
        return { id: (options as any).jobId };
      },
    };
    await consumers.enqueue(walletPrep, queue);
    await consumers.enqueue(tokenPrep, queue);
    expect(queueAdded).toHaveLength(2);
    expect(db.state.deliveries.every(d => d.state === 'queued')).toBe(true);

    // 4. Worker execution
    const walletExec = await consumers.execute(walletPrep, walletPrep.plan.users[0]!);
    const tokenExec = await consumers.execute(tokenPrep, tokenPrep.plan.users[0]!);
    expect(walletExec).toEqual({ sourceOnly: true, runtimeAccepted: false, economicSuccess: false });
    expect(tokenExec).toEqual({ sourceOnly: true, runtimeAccepted: false, economicSuccess: false });
    expect(db.state.executions.every(e => e.state === 'confirmed')).toBe(true);
    expect(db.state.deliveries.every(d => d.state === 'completed')).toBe(true);
    expect(db.state.receipts).toHaveLength(2);
    expect(db.state.receipts.every(r => r.accounting_complete === true)).toBe(true);

    // 5. Durable observer + Drain accounting
    const observer = createLoadDurableSqlObserver({
      transaction: db.makeTransaction('swat_load_observer', { readOnly: true, isolation: 'repeatable read' }),
      assertObserverWithClient: async () => {},
      now: currentNow,
    });
    const loadDeadline = clockMs;
    const drainDeadline = loadDeadline + 10_000;
    const drain = await drainLoadAccounting(
      { scope, loadDeadline, drainDeadline, maximumPolls: 2, pollIntervalMs: 10, phases: ['load', 'drain'] },
      {
        now: () => clockMs,
        stopAdmission: async () => {},
        capture: async ({ kind, phase }) => ({
          scope, kind, phase, capturedAt: currentNow().toISOString(), records: [{ observed: true }],
        }),
        wait: async ({ milliseconds }) => { clockMs += milliseconds; },
        accounting: async () => ({
          scope,
          fixtures: [walletInv.fixture, tokenInv.fixture],
          attempts: [walletInv.attempt, tokenInv.attempt, replayWalletInv.attempt],
          admissions: db.state.admissions,
          durable: await observer({ scope, fixtures: [walletInv.fixture, tokenInv.fixture] }),
        }),
      }
    );

    expect(drain.captures).toHaveLength(loadCaptureKinds.length * 2);
    expect(drain.accounting).toMatchObject({
      attempts: 3,
      admitted: 2,
      replays: 1,
      sourceOnly: true,
      runtimeAccepted: false,
      liveCapabilityAccepted: false,
      protectedRuntimeAccepted: false,
      totals: {
        base: '9007199254740998.000000000000000002',
        quote: '18014398509482006.000000000000000004',
        fee: '0.020000000000000001',
        debit: '18014398509482006.020000000000000005',
      },
    });

    // 6. Negative conservation check: dropping a receipt or mutating position base must fail drain/requireLoadFinalAccounting
    const validDurable = await observer({ scope, fixtures: [walletInv.fixture, tokenInv.fixture] });
    expect(() => requireLoadFinalAccounting({
      scope,
      fixtures: [walletInv.fixture, tokenInv.fixture],
      attempts: [walletInv.attempt, tokenInv.attempt, replayWalletInv.attempt],
      admissions: db.state.admissions,
      durable: { ...validDurable, receipts: validDurable.receipts.slice(1) },
    })).toThrow(/missing, extra, unknown or orphan durable economics/);

    const originalPosBase = db.state.positions[0]!.confirmed_quantity;
    db.state.positions[0]!.confirmed_quantity = '1';
    await expect(drainLoadAccounting(
      { scope, loadDeadline, drainDeadline, maximumPolls: 1, pollIntervalMs: 10, phases: ['drain'] },
      {
        now: () => clockMs,
        stopAdmission: async () => {},
        capture: async ({ kind, phase }) => ({
          scope, kind, phase, capturedAt: currentNow().toISOString(), records: [{ observed: true }],
        }),
        wait: async () => {},
        accounting: async () => ({
          scope,
          fixtures: [walletInv.fixture, tokenInv.fixture],
          attempts: [walletInv.attempt, tokenInv.attempt, replayWalletInv.attempt],
          admissions: db.state.admissions,
          durable: await observer({ scope, fixtures: [walletInv.fixture, tokenInv.fixture] }),
        }),
      }
    )).rejects.toThrow(/conservation mismatch/);
    db.state.positions[0]!.confirmed_quantity = originalPosBase;
  });
});

describe('P7 pool-free import isolation', () => {
  it('loads all P7 modules without pg.Pool/pg.Client construction or ambient/dist DB imports', async () => {
    const rootDir = fileURLToPath(new URL('../../../', import.meta.url));
    const temp = mkdtempSync(join(tmpdir(), 'swat-p7-load-isolated-'));
    const config = join(temp, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({
      compilerOptions: {
        baseUrl: resolve(rootDir),
        paths: {
          '@swat/db/dist/*.js': ['packages/db/src/*.ts'],
          '@swat/shared': ['packages/shared/src/index.ts'],
        },
      },
    }));
    const script = `
      import { createRequire } from 'node:module';
      import { resolve } from 'node:path';
      const require = createRequire(import.meta.url);
      const pg = require(require.resolve('pg', { paths: ['./packages/db'] }));
      let constructors = 0;
      const trap = name => class { constructor() { constructors++; throw new Error('Forbidden PG ' + name); } };
      pg.Pool = trap('Pool');
      pg.Client = trap('Client');
      const { tsImport } = await import('tsx/esm/api');
      const loaded = new Set();
      const load = p => tsImport(p, { parentURL: import.meta.url, onImport: url => loaded.add(new URL(url).pathname) });
      const targets = [
        './packages/db/src/wave4-load-contract.ts',
        './packages/db/src/wave4-load-capture-owned.ts',
        './tests/qualification/wave4/load-durable-contract.ts',
        './tests/qualification/wave4/load-fixture-consumers.ts',
        './tests/qualification/wave4/load-durable-observer.ts',
        './tests/qualification/wave4/load-durable-economics.ts',
      ];
      for (const t of targets) await load(t);
      const allLoaded = new Set([...loaded, ...Object.keys(require.cache)]);
      const forbidden = ['index.ts', 'client.ts', 'transaction.ts', 'tenancy.ts'].map(n => resolve('packages/db/src', n));
      if ([...allLoaded].some(p => forbidden.includes(p) || p.startsWith(resolve('packages/db/dist') + '/'))) {
        throw new Error('Ambient/stale DB import detected');
      }
      if (constructors !== 0) throw new Error('Owned P7 graph constructed PG');
      let control = false;
      try { await load('./packages/db/src/lp-copy-trading.ts'); } catch (e) { control = String(e).includes('Forbidden PG Pool'); }
      if (!control || constructors !== 1) throw new Error('Real ambient positive control failed');
      console.log(JSON.stringify({ constructors: 0, control, loadedCount: allLoaded.size }));
    `;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
        cwd: rootDir,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, TSX_TSCONFIG_PATH: config, NODE_ENV: 'test', DATABASE_URL: 'postgres://swat_app:offline@127.0.0.1:1/offline', DATABASE_READ_URL: '' },
      });
      expect(JSON.parse(stdout.trim())).toMatchObject({ constructors: 0, control: true });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 35_000);
});
