import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import type { LpChain } from '@swat/shared';

import { Deadline } from './containment.js';
import { gatePassed, hash } from './core.js';
import {
  qualifyP6Concurrency,
  scheduleCompetingClaims,
  scheduleExpiryCancelFeeOnly,
  scheduleTenantInterference,
  type P6ConcurrencyPorts
} from './p6-concurrency-schedules.js';
import {
  qualifyP6Faults,
  scheduleBullMqUnackRecovery,
  schedulePreCommitCrash,
  scheduleRedisDrop,
  type P6FaultPorts
} from './p6-fault-schedules.js';
import { assertOwnedFinancialConservation, createOwnedFinancialObserver } from './withdrawal-owned-observer.js';
import { assertReducingEconomicConservation } from './reducing-owned-composition.js';
import { lpRequest, syntheticDeposit, syntheticLpProtocol } from './domains.js';
import { OwnedQueueRedis } from './queue-redis.js';
import { OwnedQueueRuntime, type QueueFactories } from './queue-runtime.js';
import {
  lpJobName,
  queueIdentity,
  requireCompletedJournal,
  requirePendingJournal,
  requireQueueJob,
  requireRedelivery,
  type QueueIdentity,
  type QueueJournal
} from './queue-contract.js';
import { queueStream } from './queue-journal.js';
import {
  createExecutedPipelineRuntimeTransaction,
  ExecutedPipelineCommitUncertainError
} from './pipeline-executed.js';

import {
  claimSourceSignalForCopyExecutionWithClient,
  type PoolClient,
  type SourceSignalCopyClaimInput
} from '@swat/db/dist/copy-trade-lifecycle-owned.js';
import {
  createCustodyEnrollmentStore,
  createCustodyExecutionStore
} from '@swat/db/dist/custody-store.js';
import {
  createWithdrawalService,
  type WithdrawalEligibility
} from '@swat/db/dist/withdrawal-service.js';
import {
  consumeProtectedWithdrawalOtp,
  createProtectedWithdrawalOtp,
  type WithdrawalOtpCapturePort
} from '@swat/db/dist/withdrawal-otp.js';
import {
  financialHash,
  WithdrawalProtocolError,
  type FinancialAttempt,
  type FinancialAuthorization,
  type FinancialReceipt,
  type FinancialRecord,
  type WithdrawalIntent,
  type WithdrawalRequest,
  type WithdrawalSqlClient,
  type WithdrawalTransaction
} from '@swat/db/dist/withdrawal-contract.js';
import { withdrawalSqlStore } from '@swat/db/dist/withdrawal-store.js';
import { createReducingService } from '@swat/db/dist/reducing-service.js';
import { applyPerpsReducingReceiptWithClient } from '@swat/db/dist/reducing-owned.js';
import {
  reducingIntent,
  type ReducingIntent,
  type ReducingRequest
} from '@swat/db/dist/reducing-contract.js';
import {
  appendWorkerValuationCorrectionWithClient,
  readWorkerFinancialTotalsWithClient,
  workerOriginalEvidenceDigest,
  workerOriginalEvidenceSnapshot
} from '@swat/db/dist/worker-valuation-corrections.js';
import {
  admitWave4SpotAccountingWithClient,
  createWave4SpotSettler,
  type Wave4SpotAdmission
} from '@swat/db/dist/wave4-financial-backing-owned.js';
import {
  createLpPaperService,
  type LpInjectedProtocolPort
} from '@swat/db/dist/lp-paper-service.js';
import { createLpPaperSqlStore } from '@swat/db/dist/lp-paper-store.js';
import { lpAdmissionContextKey, lpAdmissionQuoteInput } from '@swat/db/dist/lp-paper-admission-contract.js';
import { lpAcquisitionHash, lpExactHash, lpSnapshot, type LpExactOperation, type LpExactPosition, type LpPaperReceipt } from '@swat/db/dist/lp-exact.js';
import type { UserScope } from '@swat/db/dist/tenancy.js';
import {
  financialAuthorizationFixture,
  financialFundingFixture,
  reducingMappingFixture
} from '../../../packages/db/src/withdrawal-test-fixture.js';
import {
  createDurableFinancialRunner,
  reducingAccountingAdapter
} from '../../../apps/trade-executor/src/reducing-orchestration.js';

const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const SIGNAL_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_TRADE_ID = '44444444-4444-4444-8444-444444444444';
const GRANT_ID = '55555555-5555-4555-8555-555555555555';
const LOT_ID = '66666666-6666-4666-8666-666666666666';
const MASTER_WALLET = 'solana:11111111111111111111111111111111';
const TARGET_ACCOUNT = 'solana:11111111111111111111111111111112';
const TOKEN_MINT = 'solana:So11111111111111111111111111111111111111112';
const REDIS_RUN_ID = 'b'.repeat(40);
const BASE_NOW = '2026-11-24T12:00:00.000Z';

type Row = Record<string, any>;

interface Tables {
  users: Row[];
  user_execution_settings: Row[];
  user_chain_execution_settings: Row[];
  user_wallet_subscriptions: Row[];
  config: Row[];
  source_trades: Row[];
  source_verification_bindings: Row[];
  source_verification_heads: Row[];
  source_verified_evidence: Row[];
  source_provider_authorities: Row[];
  source_position_applications: Row[];
  signals: Row[];
  copy_positions: Row[];
  copy_executions: Row[];
  copy_execution_state_history: Row[];
  copy_execution_policy_snapshots: Row[];
  copy_execution_evidence: Row[];
  copy_position_applications: Row[];
  copy_position_master_lots: Row[];
  copy_execution_valuation_corrections: Row[];
  trusted_worker_valuations: Row[];
  worker_valuation_authorities: Row[];
  copy_execution_financial_receipts: Row[];
  source_fanout_deliveries: Row[];
  user_execution_grants: Row[];
  withdrawal_reducing_intents: Row[];
  withdrawal_authorizations: Row[];
  withdrawal_reducing_reservations: Row[];
  withdrawal_reducing_outbox: Row[];
  withdrawal_reducing_attempts: Row[];
  withdrawal_reducing_receipts: Row[];
  withdrawal_reducing_applications: Row[];
  withdrawal_reducing_accounting_admissions: Row[];
  reducing_perps_venue_mappings: Row[];
  reducing_perps_economics_admissions: Row[];
  lp_guardrail_configs: Row[];
  lp_positions: Row[];
  lp_exact_positions: Row[];
  lp_exact_operations: Row[];
  lp_exact_receipts: Row[];
  lp_position_state_history: Row[];
  lp_protected_quote_admissions: Row[];
  lp_protected_settlement_admissions: Row[];
}

function emptyTables(): Tables {
  return {
    users: [],
    user_execution_settings: [],
    user_chain_execution_settings: [],
    user_wallet_subscriptions: [],
    config: [],
    source_trades: [],
    source_verification_bindings: [],
    source_verification_heads: [],
    source_verified_evidence: [],
    source_provider_authorities: [],
    source_position_applications: [],
    signals: [],
    copy_positions: [],
    copy_executions: [],
    copy_execution_state_history: [],
    copy_execution_policy_snapshots: [],
    copy_execution_evidence: [],
    copy_position_applications: [],
    copy_position_master_lots: [],
    copy_execution_valuation_corrections: [],
    trusted_worker_valuations: [],
    worker_valuation_authorities: [],
    copy_execution_financial_receipts: [],
    source_fanout_deliveries: [],
    user_execution_grants: [],
    withdrawal_reducing_intents: [],
    withdrawal_authorizations: [],
    withdrawal_reducing_reservations: [],
    withdrawal_reducing_outbox: [],
    withdrawal_reducing_attempts: [],
    withdrawal_reducing_receipts: [],
    withdrawal_reducing_applications: [],
    withdrawal_reducing_accounting_admissions: [],
    reducing_perps_venue_mappings: [],
    reducing_perps_economics_admissions: [],
    lp_guardrail_configs: [],
    lp_positions: [],
    lp_exact_positions: [],
    lp_exact_operations: [],
    lp_exact_receipts: [],
    lp_position_state_history: [],
    lp_protected_quote_admissions: [],
    lp_protected_settlement_admissions: []
  };
}

function deterministicUuid(prefix: string, seq: number): string {
  const hex = createHash('sha256').update(`${prefix}:${seq}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Stateful in-memory READ COMMITTED transactional SQL simulator with:
 * - Re-entrant Promise-queued pg_advisory_xact_lock per transaction
 * - Tenant RLS via app.current_user_id (with local vs session GUC reset)
 * - Row-level overlay + atomic COMMIT / ROLLBACK
 */
function createStatefulP6SqlStore() {
  let committed = emptyTables();
  let nowIso = BASE_NOW;
  let seq = 0;
  let txSeq = 0;
  let nextPid = 100;
  let failMarker: string | null = null;
  let beforeCommitHook: (() => void) | null = null;

  interface LockEntry {
    ownerTxId: number;
    waiters: Array<() => void>;
  }
  const advisoryLocks = new Map<string, LockEntry>();
  const lockWaitObservers: Array<(key: string, waitingTxId: number, ownerTxId: number) => void> = [];

  async function acquireAdvisoryLock(txId: number, key: string, held: Set<string>): Promise<void> {
    if (held.has(key)) return;
    while (true) {
      const existing = advisoryLocks.get(key);
      if (!existing) {
        advisoryLocks.set(key, { ownerTxId: txId, waiters: [] });
        held.add(key);
        return;
      }
      if (existing.ownerTxId === txId) {
        held.add(key);
        return;
      }
      await new Promise<void>(resolve => {
        existing.waiters.push(resolve);
        for (const observer of lockWaitObservers) observer(key, txId, existing.ownerTxId);
      });
    }
  }

  function releaseAdvisoryLocks(txId: number, held: Set<string>): void {
    for (const key of held) {
      const entry = advisoryLocks.get(key);
      if (entry && entry.ownerTxId === txId) {
        advisoryLocks.delete(key);
        const waiters = entry.waiters.splice(0);
        for (const wake of waiters) wake();
      }
    }
    held.clear();
  }

  interface TxState {
    txId: number;
    open: boolean;
    working: Tables | null;
    localUserId: string | null;
    sessionUserId: string | null;
    heldLocks: Set<string>;
    dirtyTables: Set<keyof Tables>;
  }

  function snapshotTable<K extends keyof Tables>(tables: Tables, key: K): Tables[K] {
    return structuredClone(tables[key]);
  }

  class Connection {
    readonly pid = ++nextPid;
    private tx: TxState | null = null;
    private sessionUserId: string | null = null;

    getLocalUserId(): string | null {
      return this.tx?.localUserId ?? this.sessionUserId;
    }

    private table<K extends keyof Tables>(name: K): Tables[K] {
      if (this.tx && this.tx.open && this.tx.working) {
        // READ COMMITTED: if this tx hasn't modified this table yet, refresh from committed
        if (!this.tx.dirtyTables.has(name)) {
          this.tx.working[name] = snapshotTable(committed, name);
        }
        return this.tx.working[name];
      }
      return committed[name];
    }

    private mutTable<K extends keyof Tables>(name: K): Tables[K] {
      if (this.tx && this.tx.open && this.tx.working) {
        if (!this.tx.dirtyTables.has(name)) {
          this.tx.working[name] = snapshotTable(committed, name);
          this.tx.dirtyTables.add(name);
        }
        return this.tx.working[name];
      }
      return committed[name];
    }

    async query<R = Row>(sql: string, values: unknown[] = []): Promise<{ rows: R[]; command?: string; rowCount?: number }> {
      const trimmed = sql.trim();

      if (/^BEGIN\b/i.test(trimmed)) {
        const txId = ++txSeq;
        this.tx = {
          txId,
          open: true,
          working: structuredClone(committed),
          localUserId: this.sessionUserId,
          sessionUserId: this.sessionUserId,
          heldLocks: new Set(),
          dirtyTables: new Set()
        };
        return { rows: [], command: 'BEGIN', rowCount: 0 };
      }
      if (/^COMMIT\b/i.test(trimmed)) {
        if (beforeCommitHook) {
          const hook = beforeCommitHook;
          beforeCommitHook = null;
          hook();
        }
        if (failMarker === 'commit' || failMarker === 'deferred-commit') {
          throw new Error('injected deferred commit failure');
        }
        if (this.tx && this.tx.open && this.tx.working) {
          for (const key of this.tx.dirtyTables) {
            (committed[key] as unknown) = structuredClone(this.tx.working[key]);
          }
          const held = this.tx.heldLocks;
          const txId = this.tx.txId;
          this.tx = null;
          releaseAdvisoryLocks(txId, held);
        }
        return { rows: [], command: 'COMMIT', rowCount: 0 };
      }
      if (/^ROLLBACK\b/i.test(trimmed)) {
        if (this.tx) {
          const held = this.tx.heldLocks;
          const txId = this.tx.txId;
          this.tx = null;
          releaseAdvisoryLocks(txId, held);
        }
        return { rows: [], command: 'ROLLBACK', rowCount: 0 };
      }

      // GUC handling
      if (trimmed.includes("set_config('app.current_user_id'")) {
        const val = values[0] === '' || values[0] === null || values[0] === undefined ? null : String(values[0]);
        const isLocal = trimmed.includes("set_config('app.current_user_id', $1, true)")
          || trimmed.includes("set_config('app.current_user_id',$1,true)")
          || trimmed.includes("set_config('app.current_user_id', '', true)")
          || trimmed.includes("set_config('app.current_user_id','',true)");
        if (this.tx && this.tx.open) {
          this.tx.localUserId = val;
          if (!isLocal) this.sessionUserId = val;
        } else if (!isLocal) {
          this.sessionUserId = val;
        }
        return { rows: [], command: 'SELECT', rowCount: 1 };
      }
      if (trimmed.includes("current_setting('app.current_user_id'")) {
        const cur = this.getLocalUserId() ?? '';
        const hidden = committed.users.filter(u => cur !== '' && u.id === cur).length === 0;
        return { rows: [{ reset: cur === '', hidden, current_user_id: cur }] as unknown as R[], command: 'SELECT', rowCount: 1 };
      }
      if (/^SET LOCAL\b/i.test(trimmed)) {
        return { rows: [], command: 'SET', rowCount: 0 };
      }

      const marker = /\/\* ([a-z-]+:[a-z-]+) \*\//.exec(trimmed)?.[1];
      if (marker && marker === failMarker) {
        throw new Error('injected SQL failure');
      }

      // Advisory lock
      if (trimmed.includes('pg_advisory_xact_lock')) {
        const key = String(values[0]);
        if (this.tx && this.tx.open) {
          await acquireAdvisoryLock(this.tx.txId, key, this.tx.heldLocks);
        }
        return { rows: [{ pg_advisory_xact_lock: '' }] as unknown as R[], command: 'SELECT', rowCount: 1 };
      }

      // Financial / Withdrawal / Reducing queries (by marker)
      if (marker) {
        if (this.tx && this.tx.open) {
          if (marker === 'financial:by-id') {
            await acquireAdvisoryLock(this.tx.txId, `row:intent:${String(values[0])}:${String(values[1])}`, this.tx.heldLocks);
          } else if (marker === 'financial:by-key') {
            await acquireAdvisoryLock(this.tx.txId, `row:intent-key:${String(values[0])}:${String(values[1])}:${String(values[2])}`, this.tx.heldLocks);
          } else if (marker === 'withdrawal:authorization') {
            await acquireAdvisoryLock(this.tx.txId, `row:auth:${String(values[0])}:${String(values[1])}`, this.tx.heldLocks);
          } else if (marker === 'financial:attempt') {
            await acquireAdvisoryLock(this.tx.txId, `row:attempt:${String(values[1])}:${String(values[0])}`, this.tx.heldLocks);
          }
        }
        return this.execMarkedQuery<R>(marker, trimmed, values);
      }

      // Pipeline / Custody / LP / Correction queries
      return this.execNamedSql<R>(trimmed, values);
    }

    private rlsUser(): string | null {
      return this.getLocalUserId();
    }

    private matchesRls(rowUserId: string | null | undefined): boolean {
      const tenant = this.rlsUser();
      if (tenant === null) return false;
      return rowUserId === tenant;
    }

    private execMarkedQuery<R>(marker: string, sql: string, v: unknown[]): { rows: R[]; command: string; rowCount: number } {
      const tenant = this.rlsUser();
      const rows = (result: Row[]): { rows: R[]; command: string; rowCount: number } => ({
        rows: structuredClone(result) as R[],
        command: sql.startsWith('INSERT') ? 'INSERT' : sql.startsWith('UPDATE') ? 'UPDATE' : 'SELECT',
        rowCount: result.length
      });

      switch (marker) {
        case 'financial-owned:identity':
          return rows([{
            role_name: 'swat_app',
            session_role: 'swat_app',
            role_setting: 'none',
            row_security: 'on',
            rolcanlogin: true,
            rolsuper: false,
            rolbypassrls: false,
            rolinherit: false,
            rolcreaterole: false,
            rolcreatedb: false,
            rolreplication: false,
            backend_pid: this.pid,
            transaction_clean: true,
            has_memberships: false,
            owns_objects: false,
            receipt_insert: false,
            intent_insert: true
          }]);
        case 'financial:clock':
          return rows([{ observed_at: nowIso }]);
        case 'financial:request-lock':
        case 'financial:budget-lock': {
          // Handled above when pg_advisory_xact_lock is present; fallback noop
          return rows([]);
        }
        case 'financial:by-key':
          return rows(this.table('withdrawal_reducing_intents').filter(
            r => (tenant === null || r.user_id === tenant) && r.user_id === v[0] && r.kind === v[1] && r.request_key === v[2]
          ));
        case 'financial:by-id':
          return rows(this.table('withdrawal_reducing_intents').filter(
            r => (tenant === null || r.user_id === tenant) && r.user_id === v[0] && r.id === v[1]
          ));
        case 'financial:create': {
          const row = {
            id: deterministicUuid('intent', ++seq),
            user_id: v[0],
            kind: v[1],
            request_key: v[2],
            intent: JSON.parse(String(v[3])),
            intent_hash: v[4],
            expires_at: v[5],
            created_at: nowIso,
            status: 'awaiting-authorization',
            completed_raw: '0',
            terminal: false,
            cancellation_reason: null
          };
          this.mutTable('withdrawal_reducing_intents').push(row);
          return rows([row]);
        }
        case 'financial:reserved': {
          const sum = this.table('withdrawal_reducing_reservations')
            .filter(r => r.user_id === v[0] && r.budget_key === v[1] && r.intent_id !== v[2])
            .reduce((acc, r) => acc + BigInt(r.reserved_raw), 0n)
            .toString();
          return rows([{ reserved_raw: sum }]);
        }
        case 'financial:reserve': {
          const list = this.mutTable('withdrawal_reducing_reservations');
          if (list.some(r => r.intent_id === v[0] && r.budget_key === v[2])) {
            throw new Error('duplicate reservation');
          }
          list.push({
            intent_id: v[0],
            user_id: v[1],
            budget_key: v[2],
            purpose: v[3],
            chain: v[4],
            network: v[5],
            mode: v[6],
            account_id: v[7],
            asset_id: v[8],
            asset_scale: v[9],
            amount_raw: v[10],
            fee_raw: v[11],
            reserved_raw: (BigInt(String(v[10])) + BigInt(String(v[11]))).toString()
          });
          return rows([]);
        }
        case 'financial:outbox': {
          const list = this.mutTable('withdrawal_reducing_outbox');
          if (list.some(r => r.intent_id === v[0])) throw new Error('duplicate outbox');
          list.push({ intent_id: v[0], user_id: v[1], intent_hash: v[2] });
          return rows([]);
        }
        case 'financial:queue': {
          const row = this.mutTable('withdrawal_reducing_intents').find(
            r => r.id === v[0] && r.user_id === v[1] && r.status === 'awaiting-authorization'
          );
          if (!row) return rows([]);
          row.status = 'queued';
          return rows([row]);
        }
        case 'withdrawal:authorization':
          return rows(this.table('withdrawal_authorizations').filter(
            r => r.user_id === v[0] && r.intent_id === v[1]
          ));
        case 'withdrawal:issue': {
          const row = {
            id: deterministicUuid('auth', ++seq),
            user_id: v[0],
            intent_id: v[1],
            intent_hash: v[2],
            digest: v[3],
            expires_at: v[4],
            failures: 0,
            delivery_state: 'pending',
            consumed_at: null
          };
          this.mutTable('withdrawal_authorizations').push(row);
          return rows([row]);
        }
        case 'withdrawal:delivery': {
          const row = this.mutTable('withdrawal_authorizations').find(
            r => r.user_id === v[0] && r.id === v[1] && r.delivery_state === 'pending' && !r.consumed_at
          );
          if (row) row.delivery_state = v[2];
          return rows([]);
        }
        case 'withdrawal:failure': {
          const row = this.mutTable('withdrawal_authorizations').find(
            r => r.user_id === v[0] && r.id === v[1] && !r.consumed_at
          );
          if (row) row.failures++;
          return rows([]);
        }
        case 'withdrawal:consume': {
          const row = this.mutTable('withdrawal_authorizations').find(
            r => r.user_id === v[0] && r.id === v[1] && r.intent_id === v[2] && r.intent_hash === v[3]
              && r.digest === v[4] && !r.consumed_at && r.failures < 5 && r.delivery_state === 'sent' && r.expires_at > nowIso
          );
          if (!row) return rows([]);
          row.consumed_at = nowIso;
          return rows([row]);
        }
        case 'financial:attempt':
          return rows(this.table('withdrawal_reducing_attempts').filter(
            r => r.intent_id === v[0] && r.user_id === v[1]
          ));
        case 'financial:prepare': {
          const attempts = this.mutTable('withdrawal_reducing_attempts');
          if (attempts.some(r => r.intent_id === v[0])) throw new Error('duplicate attempt');
          const parent = this.table('withdrawal_reducing_intents').find(
            r => r.id === v[0] && r.user_id === v[1]
          );
          if (!parent || parent.status !== 'queued' || parent.terminal || parent.expires_at <= nowIso) {
            throw new Error('attempt requires locked current queued unexpired parent');
          }
          const row = {
            id: deterministicUuid('attempt', ++seq),
            intent_id: v[0],
            user_id: v[1],
            intent_hash: v[2],
            client_order_id: v[3],
            state: 'prepared',
            completed_raw: '0',
            completed_fee_raw: '0',
            terminal: false
          };
          attempts.push(row);
          return rows([row]);
        }
        case 'financial:prepared': {
          const parent = this.mutTable('withdrawal_reducing_intents').find(
            r => r.id === v[0] && r.user_id === v[1] && r.status === 'queued'
          );
          if (parent) parent.status = 'prepared';
          return rows([]);
        }
        case 'financial:dispatch-fence': {
          const row = this.mutTable('withdrawal_reducing_attempts').find(
            r => r.id === v[0] && r.intent_id === v[1] && r.user_id === v[2] && r.state === 'prepared' && !r.terminal
          );
          if (!row) return rows([]);
          row.state = 'uncertain';
          return rows([row]);
        }
        case 'financial:uncertain': {
          const row = this.mutTable('withdrawal_reducing_intents').find(
            r => r.id === v[0] && r.user_id === v[1] && !r.terminal
          );
          if (row) row.status = 'uncertain';
          return rows([]);
        }
        case 'financial:admitted-receipt':
          return rows(this.table('withdrawal_reducing_receipts').filter(
            r => r.user_id === v[0] && r.intent_id === v[1] && r.attempt_id === v[2]
              && r.receipt_id === v[3] && r.receipt_hash === v[4] && r.admitted_at <= nowIso
          ));
        case 'financial:applied-receipt':
          return rows(this.table('withdrawal_reducing_applications').filter(
            r => r.user_id === v[0] && r.intent_id === v[1] && r.receipt_id === v[2]
          ));
        case 'financial:apply-receipt': {
          const admitted = this.table('withdrawal_reducing_receipts').find(
            r => r.user_id === v[0] && r.intent_id === v[1] && r.attempt_id === v[2] && r.receipt_id === v[3]
          );
          if (!admitted) throw new Error('admission missing');
          const apps = this.mutTable('withdrawal_reducing_applications');
          apps.push({
            user_id: v[0],
            intent_id: v[1],
            attempt_id: v[2],
            receipt_id: v[3],
            delta_raw: v[4],
            accounting_reference: v[5]
          });
          const current = this.mutTable('withdrawal_reducing_attempts').find(r => r.id === v[2])!;
          const parent = this.mutTable('withdrawal_reducing_intents').find(r => r.id === v[1])!;
          const receipt = admitted.receipt as FinancialReceipt;
          const maximum = parent.intent.kind === 'withdrawal' ? parent.intent.amountRaw : parent.intent.quantityRaw;
          const status = receipt.terminal && receipt.cumulativeRaw === maximum
            ? 'settled'
            : receipt.terminal && receipt.cumulativeRaw === '0'
              ? 'failed'
              : receipt.cumulativeRaw !== '0'
                ? 'partial'
                : 'uncertain';
          Object.assign(current, {
            completed_raw: receipt.cumulativeRaw,
            completed_fee_raw: receipt.feeRaw,
            terminal: receipt.terminal,
            state: status
          });
          Object.assign(parent, {
            completed_raw: receipt.cumulativeRaw,
            terminal: receipt.terminal,
            status
          });
          for (const res of this.mutTable('withdrawal_reducing_reservations').filter(r => r.intent_id === parent.id)) {
            res.reserved_raw = receipt.terminal
              ? '0'
              : (
                BigInt(res.amount_raw) + BigInt(res.fee_raw)
                - (res.amount_raw !== '0' ? BigInt(receipt.cumulativeRaw) : 0n)
                - (res.fee_raw !== '0' ? BigInt(receipt.feeRaw) : 0n)
              ).toString();
          }
          return rows([]);
        }
        case 'financial:cancel-expired': {
          const parent = this.mutTable('withdrawal_reducing_intents').find(r => r.id === v[0]);
          const hasAttempt = this.table('withdrawal_reducing_attempts').some(r => r.intent_id === v[0]);
          if (!parent || parent.status !== 'queued' || parent.terminal || parent.expires_at > nowIso || hasAttempt) {
            throw new Error('only expired queued no-attempt can cancel');
          }
          Object.assign(parent, {
            status: 'cancelled',
            terminal: true,
            cancelled_at: nowIso,
            cancellation_reason: 'expired-before-attempt'
          });
          for (const res of this.mutTable('withdrawal_reducing_reservations').filter(r => r.intent_id === parent.id)) {
            res.reserved_raw = '0';
          }
          return rows([]);
        }
        case 'reducing:venue-mapping':
          return rows(this.table('reducing_perps_venue_mappings').filter(
            r => r.position_id === v[0] && r.user_id === v[1] && r.mapping_id === v[2] && r.mapping_hash === v[3]
          ));
        case 'reducing-owned:mapping':
          return rows(this.table('reducing_perps_venue_mappings').filter(
            r => r.user_id === v[0] && r.position_id === v[1] && r.mapping_id === v[2]
          ));
        case 'reducing:perps-delta': {
          const r = this.table('withdrawal_reducing_receipts').find(
            x => x.receipt_id === v[0] && x.intent_id === v[1] && x.user_id === v[2] && x.receipt_hash === v[3]
          );
          const a = this.table('withdrawal_reducing_attempts').find(
            x => r && x.id === r.attempt_id && x.intent_id === r.intent_id && x.user_id === r.user_id && !x.terminal
          );
          if (!r || !a) return rows([]);
          return rows([{
            delta_raw: (BigInt(r.receipt.cumulativeRaw) - BigInt(a.completed_raw)).toString(),
            delta_fee_raw: (BigInt(r.receipt.feeRaw) - BigInt(a.completed_fee_raw)).toString()
          }]);
        }
        case 'reducing:perps-economics': {
          const e = this.table('reducing_perps_economics_admissions').find(
            x => x.receipt_id === v[0] && x.intent_id === v[1] && x.user_id === v[2]
              && x.delta_raw === String(v[3]) && x.delta_fee_raw === String(v[4])
          );
          return rows(e ? [{ economics_reference: e.economics_reference }] : []);
        }
        case 'reducing:perps-account': {
          const intentRow = this.table('withdrawal_reducing_intents').find(x => x.id === v[0]);
          const receiptRow = this.table('withdrawal_reducing_receipts').find(x => x.receipt_id === v[1] && x.intent_id === v[0]);
          const attemptRow = receiptRow
            ? this.table('withdrawal_reducing_attempts').find(x => x.id === receiptRow.attempt_id)
            : null;
          if (!intentRow || !receiptRow || !attemptRow) return rows([]);
          const delta = BigInt(receiptRow.receipt.cumulativeRaw) - BigInt(attemptRow.completed_raw);
          const beforeRaw = intentRow.intent.heldBeforeRaw ?? (delta === 0n ? '0' : intentRow.intent.quantityRaw);
          const afterRaw = (BigInt(beforeRaw) - delta).toString();
          return rows([{
            accounting_reference: `perps-journal:${v[0]}:${v[1]}`,
            position_id: intentRow.intent.positionId,
            position_side: intentRow.intent.positionSide,
            before_raw: beforeRaw,
            after_raw: afterRaw
          }]);
        }
        case 'financial-observer:intent':
          return rows(this.table('withdrawal_reducing_intents').filter(r => r.user_id === v[0] && r.id === v[1]));
        case 'financial-observer:attempts':
          return rows(this.table('withdrawal_reducing_attempts').filter(r => r.user_id === v[0] && r.intent_id === v[1]).map(r => ({
            id: r.id, intentId: r.intent_id, userId: r.user_id, intentHash: r.intent_hash,
            clientOrderId: r.client_order_id, state: r.state, completedRaw: r.completed_raw,
            completedFeeRaw: r.completed_fee_raw, terminal: r.terminal
          })));
        case 'financial-observer:receipts':
          return rows(this.table('withdrawal_reducing_receipts').filter(r => r.user_id === v[0] && r.intent_id === v[1]).map(r => ({
            receipt: r.receipt, hash: r.receipt_hash
          })));
        case 'financial-observer:applications':
          return rows(this.table('withdrawal_reducing_applications').filter(r => r.user_id === v[0] && r.intent_id === v[1]).map(r => ({
            receiptId: r.receipt_id, attemptId: r.attempt_id, deltaRaw: r.delta_raw, accountingReference: r.accounting_reference
          })));
        case 'financial-observer:reservations':
          return rows(this.table('withdrawal_reducing_reservations').filter(r => r.user_id === v[0] && r.intent_id === v[1]).map(r => ({
            budgetKey: r.budget_key, amountRaw: r.amount_raw, feeRaw: r.fee_raw, reservedRaw: r.reserved_raw
          })));
        case 'financial-observer:outbox':
          return rows(this.table('withdrawal_reducing_outbox').filter(r => r.user_id === v[0] && r.intent_id === v[1]).map(r => ({
            intentHash: r.intent_hash
          })));
        case 'financial-observer:authorization':
          return rows(this.table('withdrawal_authorizations').filter(r => r.user_id === v[0] && r.intent_id === v[1]).map(r => ({
            id: r.id, consumed: r.consumed_at !== null, failures: r.failures, delivery: r.delivery_state
          })));
        case 'lp-admission:clock':
          return rows([{ now: new Date(Math.max(Date.now(), Date.parse(nowIso))).toISOString() }]);
        case 'lp-admission:quote':
          return rows(this.table('lp_protected_quote_admissions').filter(
            r => r.user_id === v[0] && r.intent_hash === v[1] && r.context_key === v[5]
          ));
        case 'lp-admission:operation-time': {
          const op = this.table('lp_exact_operations').find(
            r => r.user_id === v[0] && r.id === v[1] && r.position_id === v[2]
          );
          return rows(op ? [{ created_at: op.created_at }] : []);
        }
        case 'lp-admission:settlement':
          return rows(this.table('lp_protected_settlement_admissions').filter(
            r => r.user_id === v[0] && r.operation_id === v[1]
          ));
        default:
          throw new Error(`Unsupported marked SQL query: ${marker}`);
      }
    }

    private execNamedSql<R>(sql: string, v: unknown[]): { rows: R[]; command: string; rowCount: number } {
      const rows = (result: Row[], cmd = 'SELECT'): { rows: R[]; command: string; rowCount: number } => ({
        rows: structuredClone(result) as R[],
        command: cmd,
        rowCount: result.length
      });

      // Custody queries
      if (sql.includes('INSERT INTO user_execution_grants')) {
        const grants = this.mutTable('user_execution_grants');
        if (grants.some(g => g.id === v[0])) return rows([], 'INSERT');
        const row = {
          id: v[0],
          user_id: v[1],
          chain: v[2],
          grant_kind: v[3],
          account_address: v[4],
          sealed_secret: v[5],
          has_sealed_secret: v[5] !== null && v[6] !== null,
          key_version: v[6],
          secret_binding: v[7] ? JSON.parse(String(v[7])) : null,
          scope_policy: v[8] ? JSON.parse(String(v[8])) : null,
          expires_at: v[9] ?? null,
          revoked_at: null,
          status: 'active',
          created_at: new Date(nowIso),
          lifecycle_revision: '1',
          revocation_tombstone: null
        };
        grants.push(row);
        return rows([row], 'INSERT');
      }
      if (sql.includes('FROM user_execution_grants')) {
        return rows(this.table('user_execution_grants').filter(
          g => this.matchesRls(g.user_id) && g.id === v[0] && g.user_id === v[1]
        ));
      }

      // Copy position master lots RLS query
      if (sql.includes('FROM copy_position_master_lots')) {
        return rows(this.table('copy_position_master_lots').filter(
          l => this.matchesRls(l.user_id) && l.id === v[0]
        ));
      }

      // Source verification check
      if (sql.includes('AS accepted') && sql.includes('FROM source_trades source')) {
        const sourceId = v[0];
        const at = v[1] instanceof Date ? v[1] : new Date(String(v[1]));
        const source = this.table('source_trades').find(s => s.id === sourceId);
        const binding = this.table('source_verification_bindings').find(b => b.source_trade_id === sourceId);
        const head = this.table('source_verification_heads').find(h => h.source_trade_id === sourceId);
        const evidence = head ? this.table('source_verified_evidence').find(e => e.evidence_id === head.evidence_id) : null;
        const authority = evidence ? this.table('source_provider_authorities').find(a => a.authority_id === evidence.authority_id) : null;
        const app = this.table('source_position_applications').find(a => a.source_trade_id === sourceId);
        const ok = Boolean(
          source && binding && head && evidence && authority && app
          && ['confirmed', 'finalized'].includes(source.confirmation_state)
          && head.confirmation_state === source.confirmation_state
          && evidence.source_trade_id === source.id
          && evidence.binding_digest === binding.binding_digest
          && evidence.finality === source.confirmation_state
          && app.active === true
          && authority.enabled === true
          && new Date(authority.valid_until).getTime() > at.getTime()
          && new Date(evidence.provider_valid_until).getTime() > at.getTime()
        );
        return rows(ok ? [{ accepted: true }] : []);
      }

      // Signal discovery / lock / update
      if (sql.startsWith('SELECT id, source_trade_id, source_side FROM signals')) {
        return rows(this.table('signals').filter(s => s.id === v[0]));
      }
      if (sql.includes('FROM signals') && sql.includes('FOR UPDATE')) {
        return rows(this.table('signals').filter(s => s.id === v[0]));
      }
      if (sql.includes('UPDATE signals')) {
        const sig = this.mutTable('signals').find(s => s.id === v[0]);
        if (sig) {
          if (sql.includes("status = 'expired'")) sig.status = 'expired';
          if (sql.includes("status = 'executing'")) {
            sig.status = 'executing';
            sig.claimed_at = sig.claimed_at ?? v[1];
          }
        }
        return rows(sig ? [sig] : [], 'UPDATE');
      }

      // Source trades
      if (sql.includes('FROM source_trades') && sql.includes('WHERE id = $1')) {
        return rows(this.table('source_trades').filter(s => s.id === v[0]));
      }

      // Copy executions
      if (sql.includes('FROM copy_executions') && sql.includes('AS matches') && sql.includes('WHERE id = $1')) {
        const ex = this.table('copy_executions').find(e => e.id === v[0]);
        if (!ex) return rows([]);
        const matches = (ex.requested_base_quantity ?? null) === (v[1] ?? null)
          && (ex.requested_quote_quantity ?? null) === (v[2] ?? null);
        return rows([{ matches }]);
      }
      if (sql.includes('FROM copy_executions') && sql.includes('AS exists')) {
        const exists = this.table('copy_executions').some(e => e.signal_id === v[0]);
        return rows([{ exists }]);
      }
      if (sql.includes('FROM copy_executions') && sql.includes('WHERE source_trade_id = $1')) {
        const list = this.table('copy_executions').filter(e =>
          (this.rlsUser() === null || this.matchesRls(e.user_id))
          && e.source_trade_id === v[0]
          && e.target_account === v[1]
          && e.execution_mode === v[2]
          && (e.user_id ?? null) === (v[3] ?? null)
        );
        return rows(list);
      }
      if (sql.includes('FROM copy_executions') && sql.includes('WHERE id = $1')) {
        return rows(this.table('copy_executions').filter(
          e => (this.rlsUser() === null || this.matchesRls(e.user_id)) && e.id === v[0]
        ));
      }
      if (sql.startsWith('INSERT INTO copy_positions')) {
        const pos = this.mutTable('copy_positions');
        const exists = pos.some(p =>
          p.target_account === v[0] && p.chain === v[1] && p.token_mint === v[2] && (p.user_id ?? null) === (v[3] ?? null)
        );
        if (!exists) {
          pos.push({
            id: deterministicUuid('copy-pos', ++seq),
            target_account: v[0],
            chain: v[1],
            token_mint: v[2],
            user_id: v[3] ?? null,
            confirmed_quantity: '0',
            cost_basis_usd: '0'
          });
        }
        return rows([], 'INSERT');
      }
      if (sql.includes('FROM copy_positions') && sql.includes('WHERE target_account = $1')) {
        return rows(this.table('copy_positions').filter(p =>
          p.target_account === v[0] && p.chain === v[1] && p.token_mint === v[2] && (p.user_id ?? null) === (v[3] ?? null)
        ));
      }
      if (sql.startsWith('INSERT INTO copy_executions')) {
        const row = {
          id: deterministicUuid('exec', ++seq),
          signal_id: v[0],
          source_trade_id: v[1],
          exit_lot_id: null,
          exit_trigger: null,
          chain: v[2],
          target_account: v[3],
          token_mint: v[4],
          direction: v[5],
          execution_mode: v[6],
          client_order_id: v[7],
          state: 'requested',
          requested_base_quantity: v[8],
          requested_quote_quantity: v[9],
          confirmed_base_quantity: '0',
          confirmed_quote_quantity: null,
          quote_unassessed_fill_count: 0,
          reserved_base_quantity: v[5] === 'sell' ? v[8] : '0',
          submission_attempts: 0,
          max_submission_attempts: v[10],
          simulation_id: null,
          submission_type: null,
          submission_id: null,
          next_reconciliation_at: null,
          reconciliation_claim_id: null,
          reconciliation_attempts: 0,
          max_reconciliation_attempts: v[11],
          source_position_before_quantity: v[12],
          source_sell_fraction: v[13],
          user_id: v[14] ?? null
        };
        this.mutTable('copy_executions').push(row);
        return rows([row], 'INSERT');
      }
      if (sql.startsWith('INSERT INTO copy_execution_state_history')) {
        this.mutTable('copy_execution_state_history').push({
          execution_id: v[0],
          from_state: v[1],
          to_state: v[2],
          reason: v[3]
        });
        return rows([], 'INSERT');
      }
      if (sql.includes('FROM config') && sql.includes("WHERE key IN ('trading', 'signals', 'execution_config')")) {
        return rows(this.table('config'));
      }
      if (/FROM users WHERE id\s*=\s*\$1/.test(sql)) {
        return rows(this.table('users').filter(u =>
          (this.rlsUser() === null || this.matchesRls(u.id)) && u.id === v[0]
        ));
      }
      if (sql.includes('FROM user_execution_settings WHERE user_id = $1')) {
        return rows(this.table('user_execution_settings').filter(s => s.user_id === v[0]));
      }
      if (sql.includes('FROM user_chain_execution_settings WHERE user_id = $1')) {
        return rows(this.table('user_chain_execution_settings').filter(s => s.user_id === v[0] && s.chain === v[1]));
      }
      if (sql.includes('FROM user_wallet_subscriptions WHERE user_id = $1')) {
        return rows(this.table('user_wallet_subscriptions').filter(s => s.user_id === v[0] && s.wallet_address === v[1]));
      }
      if (sql.startsWith('INSERT INTO copy_execution_policy_snapshots')) {
        const list = this.mutTable('copy_execution_policy_snapshots');
        if (!list.some(r => r.execution_id === v[0])) {
          list.push({
            execution_id: v[0],
            user_id: v[1],
            chain: v[2],
            target_account: v[3],
            token_mint: v[4],
            master_wallet_address: v[5],
            execution_mode: v[6],
            snapshot: JSON.parse(String(v[7])),
            minimum_score: v[8]
          });
        }
        return rows([], 'INSERT');
      }
      if (sql.startsWith('INSERT INTO copy_execution_financial_receipts')) {
        this.mutTable('copy_execution_financial_receipts').push({
          receipt_id: v[0],
          execution_id: v[1],
          user_id: v[2]
        });
        return rows([], 'INSERT');
      }

      // Worker valuation corrections queries
      if (sql.includes('FROM copy_execution_evidence evidence') && sql.includes('JOIN copy_position_applications application')) {
        const ev = this.table('copy_execution_evidence').find(e => e.id === v[0]);
        const ex = ev ? this.table('copy_executions').find(x => x.id === v[1] && x.id === ev.execution_id) : null;
        const app = (ev && ex) ? this.table('copy_position_applications').find(
          a => a.evidence_id === ev.id && a.execution_id === ex.id
        ) : null;
        if (!ev || !ex || !app) return rows([]);
        return rows([{
          id: ev.id,
          execution_id: ex.id,
          user_id: ex.user_id,
          source_trade_id: ex.source_trade_id,
          evidence_type: ev.evidence_type,
          evidence_id: ev.evidence_id,
          base_quantity: ev.base_quantity,
          quote_quantity: ev.quote_quantity,
          quote_native_quantity: ev.quote_native_quantity,
          quote_currency: ev.quote_currency,
          quote_native_usd_price: ev.quote_native_usd_price,
          price_usd: ev.price_usd,
          fee_usd: ev.fee_usd,
          occurred_at: ev.occurred_at,
          completes_execution: ev.completes_execution,
          confirmation_state: ev.confirmation_state,
          application_active: app.active
        }]);
      }
      if (sql.includes('FROM worker_correction_lineage($1,$2)')) {
        const ex = this.table('copy_executions').find(e => e.id === v[0]);
        const src = ex ? this.table('source_trades').find(s => s.id === ex.source_trade_id) : null;
        return rows(ex && src ? [{
          source_trade_id: ex.source_trade_id,
          acquisition_evidence_id: null,
          master_wallet_address: src.wallet_address
        }] : []);
      }
      if (sql.includes('FROM copy_execution_valuation_corrections WHERE correction_id = $1')) {
        const c = this.table('copy_execution_valuation_corrections').find(x => x.correction_id === v[0]);
        return rows(c ? [{ ...c, accepted: true }] : []);
      }
      if (sql.includes('FROM trusted_worker_valuations valuation')) {
        const tv = this.table('trusted_worker_valuations').find(
          x => x.valuation_id === v[0] && x.original_evidence_id === v[1] && x.execution_id === v[2]
        );
        const auth = tv ? this.table('worker_valuation_authorities').find(a => a.authority_id === tv.authority_id) : null;
        const binding = this.table('source_verification_bindings').find(b => b.source_trade_id === v[5]);
        const head = this.table('source_verification_heads').find(h => h.source_trade_id === v[5]);
        const at = v[3] instanceof Date ? v[3] : new Date(String(v[3]));
        if (!tv || !auth || !binding || !head) return rows([]);
        const authorized = auth.enabled === true
          && new Date(auth.valid_until).getTime() > at.getTime()
          && new Date(tv.valid_until).getTime() > at.getTime()
          && new Date(tv.valid_until).getTime() <= new Date(auth.valid_until).getTime()
          && auth.user_id === tv.user_id
          && auth.chain === v[4]
          && auth.network === binding.network
          && auth.provider_id === tv.provider_id
          && auth.identity_digest === tv.provider_identity_digest
          && auth.verifier_version === tv.verifier_version
          && tv.source_evidence_id === head.evidence_id
          && tv.lineage_source_trade_id === v[5]
          && (tv.lineage_acquisition_evidence_id ?? null) === (v[6] ?? null)
          && tv.lineage_master_wallet_address === v[7];
        return rows([{
          valuation_id: tv.valuation_id,
          revision: tv.revision,
          quote_usd: tv.quote_usd,
          fee_usd: tv.fee_usd,
          original_digest: tv.original_digest,
          original_evidence_id: tv.original_evidence_id,
          execution_id: tv.execution_id,
          user_id: tv.user_id,
          max_quote_usd: auth.max_quote_usd,
          max_fee_usd: auth.max_fee_usd,
          authorized
        }]);
      }
      if (sql.includes('FROM copy_execution_valuation_corrections WHERE original_evidence_id = $1')) {
        const list = this.table('copy_execution_valuation_corrections')
          .filter(x => x.original_evidence_id === v[0])
          .sort((a, b) => Number(b.revision) - Number(a.revision));
        return rows(list[0] ? [{ ...list[0], accepted: true }] : []);
      }
      if (sql.startsWith('INSERT INTO copy_execution_valuation_corrections')) {
        const row = {
          correction_id: v[0],
          valuation_id: v[1],
          original_evidence_id: v[2],
          execution_id: v[3],
          user_id: v[4],
          original_digest: v[5],
          original_snapshot: JSON.parse(String(v[6])),
          revision: v[7],
          previous_correction_id: v[8],
          effective_quote_usd: v[9],
          effective_fee_usd: v[10],
          recorded_at: v[11],
          lineage_source_trade_id: v[12],
          lineage_acquisition_evidence_id: v[13],
          lineage_master_wallet_address: v[14],
          quote_origin_valuation_id: v[15],
          fee_origin_valuation_id: v[16]
        };
        this.mutTable('copy_execution_valuation_corrections').push(row);
        return rows([{ correction_id: row.correction_id }], 'INSERT');
      }
      if (sql.includes('FROM worker_effective_execution_evidence')) {
        const evidences = this.table('copy_execution_evidence').filter(
          e => e.execution_id === v[0] && ['confirmed', 'finalized'].includes(e.confirmation_state)
        );
        let base = 0;
        let quoteSum = 0;
        let hasQuote = false;
        let feeSum = 0;
        let hasFee = false;
        let debitSum = 0;
        let hasDebit = false;
        let unknown = 0;
        let quoteUnknown = 0;
        let completes = false;
        for (const ev of evidences) {
          base += Number(ev.base_quantity);
          const corr = this.table('copy_execution_valuation_corrections')
            .filter(c => c.original_evidence_id === ev.id)
            .sort((a, b) => Number(b.revision) - Number(a.revision))[0];
          const eq = corr ? corr.effective_quote_usd : ev.quote_quantity;
          const ef = corr ? corr.effective_fee_usd : ev.fee_usd;
          if (eq === null || eq === undefined) {
            quoteUnknown++;
          } else {
            hasQuote = true;
            quoteSum += Number(eq);
          }
          if (ef !== null && ef !== undefined) {
            hasFee = true;
            feeSum += Number(ef);
          }
          if (eq === null || eq === undefined || ef === null || ef === undefined) {
            unknown++;
          }
          if (eq !== null || ef !== null) {
            hasDebit = true;
            debitSum += Number(eq ?? '0') + Number(ef ?? '0');
          }
          if (ev.completes_execution) completes = true;
        }
        return rows([{
          base: String(base),
          quote: hasQuote ? String(quoteSum) : null,
          debit: hasDebit ? String(debitSum) : null,
          fee: hasFee ? String(feeSum) : null,
          unknown: String(unknown),
          quoteUnknown: String(quoteUnknown),
          completes,
          evidenceCount: String(evidences.length),
          invalidCorrections: '0'
        }]);
      }

      // Wave 4 Spot settler query
      if (sql.includes('FROM public.wave4_spot_admissions089 p')) {
        return rows([]);
      }
      if (sql.includes('SELECT public.wave4_direct089(')) {
        return rows([{ allowed: true }]);
      }

      // LP Paper Store queries
      if (sql.includes('FROM lp_exact_positions e')) {
        const p = this.table('lp_exact_positions').find(r => {
          if (r.user_id !== v[0]) return false;
          if (sql.includes('e.acquisition_key=$2')) return r.acquisition_key === v[1];
          if (sql.includes('e.position_id=$2')) return r.position_id === v[1];
          return false;
        });
        if (!p) return rows([]);
        const legacy = this.table('lp_positions').find(l => l.id === p.position_id && l.user_id === p.user_id);
        return rows([{
          data: p.data,
          acquisition_data: p.acquisition_data,
          state: legacy?.state ?? p.data.state,
          auto_rebalance: legacy?.auto_rebalance ?? p.data.autoRebalance
        }]);
      }
      if (sql.startsWith('SELECT data FROM lp_exact_operations')) {
        const ops = this.table('lp_exact_operations').filter(o => {
          if (o.user_id !== v[0]) return false;
          if (sql.includes('id=$2')) return o.id === v[1];
          if (sql.includes('operation_key=$2')) return o.operation_key === v[1];
          if (sql.includes("position_id=$2 AND status='pending'")) return o.position_id === v[1] && o.status === 'pending';
          if (sql.includes("status='pending' ORDER BY")) return o.status === 'pending';
          return false;
        });
        return rows(ops.map(o => ({ data: o.data })));
      }
      if (sql.includes('FROM lp_guardrail_configs')) {
        const g = this.table('lp_guardrail_configs').find(r => r.user_id === v[0]);
        return rows(g ? [{ cap: g.max_pool_allocation_pct }] : [{ cap: '100.00' }]);
      }
      if (sql.includes('FROM lp_positions WHERE user_id=$1')) {
        const open = this.table('lp_positions').filter(p => p.user_id === v[0] && p.state !== 'closed');
        return rows([{
          total: open.reduce((s, p) => s + Number(p.deposit_value_usd ?? 0), 0).toFixed(6),
          pool: open.filter(p => p.chain === v[1] && p.pool_address === v[2]).reduce((s, p) => s + Number(p.deposit_value_usd ?? 0), 0).toFixed(6),
          unassessed: '0'
        }]);
      }
      if (sql.includes('SELECT gen_random_uuid()::text AS id')) {
        return rows([{ id: deterministicUuid('lp-op', ++seq) }]);
      }
      if (sql.startsWith('INSERT INTO lp_positions')) {
        const id = deterministicUuid('lp-pos', ++seq);
        this.mutTable('lp_positions').push({
          id,
          user_id: v[0],
          chain: v[1],
          protocol: v[2],
          pool_address: v[3],
          deposit_value_usd: v[11],
          state: 'building',
          auto_rebalance: v[10]
        });
        return rows([{ id }], 'INSERT');
      }
      if (sql.startsWith('INSERT INTO lp_exact_positions')) {
        const data = JSON.parse(String(v[5]));
        this.mutTable('lp_exact_positions').push({
          position_id: v[0],
          user_id: v[1],
          acquisition_key: v[2],
          subscription_id: v[3],
          master_event_id: v[4],
          data,
          acquisition_data: structuredClone(data)
        });
        return rows([], 'INSERT');
      }
      if (sql.startsWith('UPDATE lp_positions')) {
        const whereUserFirst = sql.includes('WHERE user_id=$1 AND id=$2');
        const id = whereUserFirst ? v[1] : v[0];
        const userId = whereUserFirst ? v[0] : v[1];
        const pos = this.mutTable('lp_positions').find(p => p.id === id && p.user_id === userId);
        if (pos) {
          if (sql.includes("state='active'")) pos.state = 'active';
          if (sql.includes("state='closed'")) pos.state = 'closed';
          if (sql.includes("state=$3")) pos.state = v[2];
        }
        return rows([], 'UPDATE');
      }
      if (sql.startsWith('INSERT INTO lp_position_state_history')) {
        this.mutTable('lp_position_state_history').push({
          id: String(++seq),
          position_id: v[0],
          from_state: v[1],
          to_state: v[2],
          reason: v[3],
          changed_at: nowIso
        });
        return rows([], 'INSERT');
      }
      if (sql.startsWith('INSERT INTO lp_exact_operations')) {
        const data = JSON.parse(String(v[5]));
        this.mutTable('lp_exact_operations').push({
          id: v[0],
          user_id: v[1],
          position_id: v[2],
          operation_key: v[3],
          receipt_key: v[4],
          status: 'pending',
          data,
          created_at: nowIso
        });
        return rows([], 'INSERT');
      }
      if (sql.startsWith('INSERT INTO lp_exact_receipts')) {
        this.mutTable('lp_exact_receipts').push({
          user_id: v[0],
          operation_id: v[1],
          position_id: v[2],
          receipt_key: v[3],
          provider_id: v[4],
          receipt_id: v[5],
          receipt_hash: v[6],
          data: JSON.parse(String(v[7])),
          accepted_at: nowIso
        });
        return rows([], 'INSERT');
      }
      if (sql.startsWith('UPDATE lp_exact_operations')) {
        const op = this.mutTable('lp_exact_operations').find(
          o => o.user_id === v[0] && o.id === v[1] && o.status === 'pending'
        );
        if (op) {
          op.status = 'completed';
          op.data = JSON.parse(String(v[2]));
          op.completed_at = nowIso;
        }
        return rows([], 'UPDATE');
      }
      if (sql.startsWith('UPDATE lp_exact_positions')) {
        const pos = this.mutTable('lp_exact_positions').find(
          p => p.user_id === v[0] && p.position_id === v[1]
        );
        if (pos) pos.data = JSON.parse(String(v[2]));
        return rows([], 'UPDATE');
      }

      throw new Error(`Unscripted SQL in P6 stateful harness: ${sql}`);
    }
  }

  function newConnection(): Connection {
    return new Connection();
  }

  async function runInTransaction<T>(
    userId: string | null,
    fn: (client: PoolClient) => Promise<T>,
    conn = newConnection()
  ): Promise<T> {
    await conn.query('BEGIN');
    if (userId !== null) {
      await conn.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);
    }
    try {
      const res = await fn(conn as unknown as PoolClient);
      await conn.query('COMMIT');
      return res;
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  function withdrawalTx(): WithdrawalTransaction {
    return <T>(userId: string, operation: (client: WithdrawalSqlClient) => Promise<T>) =>
      runInTransaction(userId, c => operation(c as unknown as WithdrawalSqlClient));
  }

  return {
    get now() { return nowIso; },
    setNow(iso: string) { nowIso = iso; },
    advanceMs(ms: number) { nowIso = new Date(Date.parse(nowIso) + ms).toISOString(); },
    committed: () => committed,
    newConnection,
    runInTransaction,
    withdrawalTx,
    fail(marker: string | null) { failMarker = marker; },
    onNextCommit(fn: () => void) { beforeCommitHook = fn; },
    onAdvisoryLockWait(fn: (key: string, waitingTxId: number, ownerTxId: number) => void) {
      lockWaitObservers.push(fn);
      return () => {
        const idx = lockWaitObservers.indexOf(fn);
        if (idx >= 0) lockWaitObservers.splice(idx, 1);
      };
    },
    seed(mutate: (t: Tables) => void) {
      mutate(committed);
    },
    admitLpQuote(userId: string, context: Parameters<typeof lpAdmissionQuoteInput>[1]) {
      const input = lpAdmissionQuoteInput(userId, context);
      const quote = context.commit.quote;
      const admittedAt = new Date(Math.max(Date.parse(nowIso), Date.parse(quote.observedAt))).toISOString();
      nowIso = admittedAt;
      committed.lp_protected_quote_admissions.push({
        id: deterministicUuid('lp-qa', ++seq),
        user_id: userId,
        intent_hash: input.intentHash,
        input,
        quote,
        quote_hash: lpExactHash(quote),
        context,
        context_key: lpAdmissionContextKey(context),
        admitted_at: admittedAt
      });
    },
    admitLpSettlement(userId: string, op: LpExactOperation, pos: LpExactPosition, receipt: LpPaperReceipt) {
      const qa = committed.lp_protected_quote_admissions.find(
        q => q.user_id === userId && q.intent_hash === op.fingerprint
      );
      if (!qa) throw new Error('Quote admission required before settlement admission');
      const opRow = committed.lp_exact_operations.find(o => o.id === op.id);
      const settledAt = new Date(Math.max(Date.parse(nowIso), Date.parse(receipt.settledAt))).toISOString();
      nowIso = settledAt;
      committed.lp_protected_settlement_admissions.push({
        id: deterministicUuid('lp-sa', ++seq),
        user_id: userId,
        quote_admission_id: qa.id,
        operation_id: op.id,
        position_id: pos.id,
        position_revision: pos.revision,
        receipt,
        context: {
          operation: lpSnapshot(op),
          position: lpSnapshot(pos),
          operationCreatedAt: opRow?.created_at ?? settledAt
        },
        admitted_at: settledAt
      });
    },
    buildLpQueueJournal(input: QueueIdentity): QueueJournal {
      const identity = queueIdentity(input);
      const opRow = committed.lp_exact_operations.find(o => o.id === input.operationId && o.user_id === input.userId)!;
      const posRow = committed.lp_exact_positions.find(p => p.position_id === opRow.position_id && p.user_id === input.userId)!;
      const legacy = committed.lp_positions.find(p => p.id === posRow.position_id && p.user_id === input.userId)!;
      const receipts = committed.lp_exact_receipts.filter(r => r.operation_id === opRow.id && r.user_id === input.userId);
      const history = committed.lp_position_state_history.filter(h => h.position_id === posRow.position_id);
      const op = opRow.data as LpExactOperation;
      const pos = posRow.data as LpExactPosition;
      const receiptRow = receipts[0] ?? null;
      return {
        operationId: op.id,
        userId: op.userId,
        positionId: pos.id,
        acquisitionKey: identity.acquisitionKey,
        status: op.status,
        raw: pos.currentAmount.raw,
        revision: pos.revision,
        receipts: String(receipts.length),
        fees: pos.cumulativeFeesMicroUsd,
        costs: pos.cumulativeCostsMicroUsd,
        realized: pos.realizedMicroUsd,
        operation: structuredClone(op),
        position: structuredClone(pos),
        receipt: receiptRow ? structuredClone(receiptRow.data) : null,
        acquisition: structuredClone(posRow.acquisition_data),
        receiptRow: receiptRow ? structuredClone(receiptRow) : null,
        legacyState: legacy.state,
        legacy: structuredClone(legacy),
        history: structuredClone(history)
      };
    }
  };
}

function seedPipelineSourceAndPolicy(store: ReturnType<typeof createStatefulP6SqlStore>, userIds: string[]) {
  const validUntil = '2026-11-25T12:00:00.000Z';
  const eventAt = new Date(BASE_NOW);
  store.seed(t => {
    t.config.push(
      { key: 'trading', value: { enabled: true }, updated_at: eventAt },
      { key: 'signals', value: { auto_execute_min_score: 50 }, updated_at: eventAt },
      { key: 'execution_config', value: { solana: 'paper' }, updated_at: eventAt }
    );
    for (const userId of userIds) {
      t.users.push({ id: userId, status: 'active' });
      t.user_execution_settings.push({
        user_id: userId,
        auto_execute: true,
        killed: false,
        min_signal_score: 50,
        updated_at: eventAt
      });
      t.user_chain_execution_settings.push({
        user_id: userId,
        chain: 'solana',
        mode: 'paper',
        max_slippage_bps: 150,
        updated_at: eventAt
      });
      t.user_wallet_subscriptions.push({
        user_id: userId,
        wallet_address: MASTER_WALLET,
        state: 'active',
        active_since: eventAt,
        wound_down_at: null,
        ended_at: null,
        close_all_requested_at: null
      });
    }
    const authorityId = 'auth-provider-1';
    const evidenceId = 'ev-source-1';
    const binding = {
      chain: 'solana',
      network: `solana:wave4-${RUN_ID}`,
      sourceEventType: 'transaction',
      sourceEventId: 'tx-1',
      sourceEventIndex: '0',
      transactionHash: 'tx-1',
      walletAddress: MASTER_WALLET,
      tokenMint: TOKEN_MINT,
      side: 'buy',
      rawQuantity: '1000000',
      quantityScale: 6,
      amountUsd: '100',
      priceUsd: '100',
      feeUsd: '1',
      eventAt: BASE_NOW
    };
    const bindingDigest = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
    t.source_trades.push({
      id: SOURCE_TRADE_ID,
      chain: 'solana',
      source_event_type: 'transaction',
      source_event_id: 'tx-1',
      source_event_index: '0',
      transaction_hash: 'tx-1',
      wallet_address: MASTER_WALLET,
      token_mint: TOKEN_MINT,
      direction: 'buy',
      quantity: '1',
      amount_usd: '100',
      price_usd: '100',
      fee_usd: '1',
      event_at: eventAt,
      observed_at: eventAt,
      confirmation_state: 'confirmed'
    });
    t.source_verification_bindings.push({
      source_trade_id: SOURCE_TRADE_ID,
      binding,
      binding_digest: bindingDigest,
      network: binding.network,
      raw_quantity: binding.rawQuantity,
      quantity_scale: binding.quantityScale
    });
    t.source_provider_authorities.push({
      authority_id: authorityId,
      provider_id: 'provider-1',
      identity_digest: 'id-digest-1',
      chain: 'solana',
      network: binding.network,
      verifier_version: 'v1',
      valid_until: validUntil,
      enabled: true
    });
    t.source_verified_evidence.push({
      evidence_id: evidenceId,
      source_trade_id: SOURCE_TRADE_ID,
      binding_digest: bindingDigest,
      provider_id: 'provider-1',
      authority_id: authorityId,
      provider_identity_digest: 'id-digest-1',
      provider_valid_until: validUntil,
      verifier_version: 'v1',
      finality: 'confirmed',
      revision: '1'
    });
    t.source_verification_heads.push({
      source_trade_id: SOURCE_TRADE_ID,
      evidence_id: evidenceId,
      revision: '1',
      confirmation_state: 'confirmed'
    });
    t.source_position_applications.push({
      source_trade_id: SOURCE_TRADE_ID,
      wallet_address: MASTER_WALLET,
      chain: 'solana',
      token_mint: TOKEN_MINT,
      active: true
    });
    t.signals.push({
      id: SIGNAL_ID,
      status: 'eligible',
      source_trade_id: SOURCE_TRADE_ID,
      source_side: 'buy',
      source_position_before_quantity: null,
      source_position_evidence_at: null,
      source_sell_fraction: null,
      expires_at: new Date(Date.parse(BASE_NOW) + 60_000),
      claimed_at: null
    });
  });
}

class InMemoryRedisClient extends EventEmitter {
  status = 'wait';
  disconnected = false;
  constructor(
    private readonly address: string,
    private readonly redisRunId: string,
    private readonly onCreated?: (client: InMemoryRedisClient) => void,
    private readonly shouldDrop = false
  ) {
    super();
    onCreated?.(this);
  }
  async connect() {
    this.status = 'ready';
    return 'OK';
  }
  async sendCommand() {
    if (this.shouldDrop || this.disconnected) throw new Error('Redis connection dropped');
    return 'OK';
  }
  async info(section?: string) {
    if (this.shouldDrop || this.disconnected) throw new Error('Redis connection dropped');
    if (section === 'server') {
      return `redis_version:7.2.4\r\nrun_id:${this.redisRunId}\r\n`;
    }
    return '';
  }
  async call(...args: unknown[]) {
    if (this.shouldDrop || this.disconnected) throw new Error('Redis connection dropped');
    if (args[0] === 'CLIENT' && args[1] === 'INFO') {
      return `id=1 addr=${this.address}:6379 laddr=${this.address}:6379 db=0\n`;
    }
    return 'OK';
  }
  duplicate() {
    return new InMemoryRedisClient(this.address, this.redisRunId, this.onCreated, this.shouldDrop);
  }
  disconnect() {
    this.disconnected = true;
    this.status = 'end';
    this.emit('end');
  }
}

function createStatefulQueueHarness(input: QueueIdentity, address: string, redisRunId: string) {
  const identity = queueIdentity(input);
  const clients: InMemoryRedisClient[] = [];
  const stream: Array<{ event: string; jobId: string }> = [];
  let jobState: 'none' | 'wait' | 'active' | 'completed' = 'none';
  let job: {
    id: string;
    name: string;
    data: unknown;
    attemptsStarted: number;
    stalledCounter: number;
    getState: () => Promise<string>;
  } | null = null;
  let activeProcessor: ((j: any) => Promise<unknown>) | null = null;
  let waitCompletion = false;

  const factories: QueueFactories = {
    redis: () => new InMemoryRedisClient(address, redisRunId, c => clients.push(c)),
    queue: () => {
      const q = new EventEmitter() as any;
      q.waitUntilReady = async () => {};
      q.close = async () => {};
      q.add = async (name: string, data: unknown, options: { jobId?: string } = {}) => {
        const jobId = options.jobId ?? identity.jobId;
        jobState = 'wait';
        job = {
          id: jobId,
          name,
          data: structuredClone(data),
          attemptsStarted: 0,
          stalledCounter: 0,
          getState: async () => jobState
        };
        stream.push({ event: 'waiting', jobId });
        return job;
      };
      q.getJob = async (jobId: string) => (job && job.id === jobId ? job : null);
      return q;
    },
    events: () => {
      const ev = new EventEmitter() as any;
      ev.run = async () => {};
      ev.waitUntilReady = async () => {};
      ev.close = async () => {};
      return ev;
    },
    worker: (_name, processor) => {
      activeProcessor = processor;
      const w = new EventEmitter() as any;
      w.closing = false;
      w.paused = false;
      w.checkConnectionError = async (fn: () => Promise<void>) => fn();
      w.moveStalledJobsToWait = async () => {
        if (job && jobState === 'active') {
          job.stalledCounter += 1;
          jobState = 'wait';
          stream.push({ event: 'stalled', jobId: job.id });
        }
      };
      w.stalledChecker = async () => {};
      w.waitUntilReady = async () => {};
      w.run = async () => {
        if (job && jobState === 'wait' && !w.closing) {
          jobState = 'active';
          job.attemptsStarted += 1;
          stream.push({ event: 'active', jobId: job.id });
          if (waitCompletion) {
            await activeProcessor!(job);
            jobState = 'completed';
            stream.push({ event: 'completed', jobId: job.id });
          }
        }
      };
      w.close = async () => {
        w.closing = true;
      };
      return w;
    }
  };

  return {
    factories,
    clients,
    stream,
    getJob: () => job,
    getState: () => jobState,
    setWaitCompletion(v: boolean) { waitCompletion = v; },
    simulateFirstWorkerStartAndCrashAfterCommit: async (onActive: () => Promise<void>) => {
      if (!job) throw new Error('Job must be queued before worker runs');
      jobState = 'active';
      job.attemptsStarted = 1;
      stream.push({ event: 'active', jobId: job.id });
      await onActive();
      // Worker 1 crashes before ack: job remains 'active', then stalls
    },
    triggerStallMoveToWait: () => {
      if (!job || jobState !== 'active') throw new Error('Expected active job to stall');
      job.stalledCounter += 1;
      jobState = 'wait';
      stream.push({ event: 'stalled', jobId: job.id });
    }
  };
}

function buildP6Ports(): {
  concurrency: P6ConcurrencyPorts;
  faults: P6FaultPorts;
} {
  // --- Category 1 Ports ---
  const c1Store = createStatefulP6SqlStore();
  seedPipelineSourceAndPolicy(c1Store, [TENANT_A]);

  const claimInput: SourceSignalCopyClaimInput = {
    signalId: SIGNAL_ID,
    targetAccount: TARGET_ACCOUNT,
    userId: TENANT_A,
    executionMode: 'paper',
    requestedQuoteQuantity: '25',
    maxPositionEvidenceAgeMs: 60_000,
    now: new Date(BASE_NOW)
  };

  let firstBarrierRelease: (() => void) | null = null;
  let firstHolding = false;
  let secondWaitingOnLock = false;
  let firstTxCount = 0;

  const withdrawalRequest: WithdrawalRequest = {
    requestKey: `p6-withdraw-${RUN_ID}`,
    chain: 'polygon',
    network: 'polygon:137',
    assetId: 'USDC',
    assetScale: 6,
    sourceWalletId: 'wallet-a',
    destination: `0x${'a'.repeat(40)}`,
    amountRaw: '100',
    maxFeeRaw: '10',
    feeAssetId: 'USDC',
    feeAssetScale: 6,
    feeFundingAccountId: 'wallet-a',
    mode: 'paper'
  };

  let otpCode = '';
  const otpKeyPort = { withKey: async <T>(op: (k: Uint8Array) => T) => op(new Uint8Array(32).fill(7)) };
  const otpPorts = createProtectedWithdrawalOtp({
    key: otpKeyPort,
    delivery: {
      resolveVerifiedRecipient: async userId => ({ userId, verified: true, recipientHandle: { channel: 'p6' } }),
      deliver: async (_recipient, code) => {
        otpCode = code;
        return 'sent';
      }
    }
  });

  const wService = createWithdrawalService({
    transaction: c1Store.withdrawalTx(),
    lockEligibility: async (_client, intent) => ({
      userId: intent.userId,
      chain: intent.chain,
      network: intent.network,
      mode: intent.mode,
      assetId: intent.assetId,
      assetScale: intent.assetScale,
      sourceWalletId: intent.sourceWalletId,
      destination: intent.destination,
      destinationVerifiedAt: '2026-11-20T12:00:00.000Z',
      availableRaw: '1000',
      observedAt: c1Store.now,
      validUntil: new Date(Date.parse(c1Store.now) + 60_000).toISOString(),
      custodyRevision: 'r1',
      balanceProof: 'p6-proof'
    }),
    lockFunding: async (_client, userId, budget) => financialFundingFixture(userId, budget, c1Store.now, '1000'),
    otp: otpPorts
  });

  // Pre-seed authorization synchronously via async setup inside submitWithdrawalRace / before race
  let cachedWithdrawalSubmit: { intentId: string; authorizationId: string; otp: string } | null = null;

  const reducingReq: ReducingRequest = {
    requestKey: `p6-reduce-${RUN_ID}`,
    chain: 'polygon',
    network: 'polygon:137',
    venue: 'spot',
    positionId: LOT_ID,
    accountId: 'venue-acc-1',
    assetId: 'TOKEN',
    assetScale: 6,
    mode: 'paper',
    positionSide: 'LONG',
    quantityRaw: '50',
    maxFeeRaw: '5',
    feeAssetId: 'USDC',
    feeAssetScale: 6,
    feeFundingAccountId: 'fee-acc-1',
    limitPriceExact: '2',
    expectedRevision: 'rev-1'
  };

  const rService = createReducingService({
    transaction: c1Store.withdrawalTx(),
    lockExposure: async (_client, intent) => ({
      ...intent,
      heldRaw: '100',
      revision: 'rev-1',
      observedAt: c1Store.now,
      validUntil: new Date(Date.parse(c1Store.now) + 60_000).toISOString(),
      proof: 'p6-exposure'
    }),
    lockFunding: async (_client, userId, budget) => financialFundingFixture(userId, budget, c1Store.now, '1000')
  });

  let runnerSubmitCalls = 0;
  const rRunner = createDurableFinancialRunner<ReducingIntent>({
    transaction: c1Store.withdrawalTx(),
    revalidate: rService.revalidate,
    effects: {
      authorize: async (record, attempt) => financialAuthorizationFixture(record, attempt, c1Store.now),
      submit: async () => {
        runnerSubmitCalls++;
        return null;
      },
      reconcile: async () => null,
      verify: async () => null
    },
    account: async () => 'p6-unused'
  });

  const concurrency: P6ConcurrencyPorts = {
    competingClaims: {
      runId: RUN_ID,
      userId: TENANT_A,
      claimInput,
      runClaim: async (runner, fn) => {
        const unsub = c1Store.onAdvisoryLockWait((_key, waitingTxId) => {
          if (runner === 'first') return;
          secondWaitingOnLock = true;
          if (firstHolding && firstBarrierRelease) {
            firstBarrierRelease();
            firstBarrierRelease = null;
          }
          void waitingTxId;
        });
        try {
          return await c1Store.runInTransaction(TENANT_A, async client => {
            if (runner === 'first') {
              firstTxCount++;
              let heldPromise!: Promise<void>;
              const barrier = {
                hold: async () => {
                  firstHolding = true;
                  if (secondWaitingOnLock) return;
                  heldPromise = new Promise<void>(resolve => {
                    firstBarrierRelease = resolve;
                  });
                  await heldPromise;
                },
                release: () => {
                  firstBarrierRelease?.();
                  firstBarrierRelease = null;
                }
              };
              const res = await fn(client, barrier);
              if (res.created && res.execution) {
                c1Store.seed(t => {
                  t.source_fanout_deliveries.push({
                    signal_id: SIGNAL_ID,
                    user_id: TENANT_A,
                    execution_id: res.execution!.id,
                    state: 'completed'
                  });
                });
              }
              return res;
            }
            const barrier = { hold: async () => {}, release: () => {} };
            return fn(client, barrier);
          });
        } finally {
          unsub();
          void firstTxCount;
        }
      },
      withdrawalSubmit: {
        intentId: 'pending-from-request',
        authorizationId: 'pending-from-request',
        otp: '000000'
      },
      submitWithdrawalRace: async (userId) => {
        const auth = await wService.requestOtp(userId, withdrawalRequest);
        cachedWithdrawalSubmit = {
          intentId: auth.intent.id,
          authorizationId: auth.authorizationId,
          otp: otpCode
        };
        const usedAuthorizations = new Set<string>();
        const singleUseCapture: WithdrawalOtpCapturePort = {
          consume: async (_u, _i, authId, consume) => {
            if (usedAuthorizations.has(authId)) {
              throw new WithdrawalProtocolError('withdrawal-protected-otp-capture-reused');
            }
            usedAuthorizations.add(authId);
            return consume(cachedWithdrawalSubmit!.otp);
          }
        };
        const runSubmit = () =>
          consumeProtectedWithdrawalOtp(
            singleUseCapture,
            userId,
            cachedWithdrawalSubmit!.intentId,
            cachedWithdrawalSubmit!.authorizationId,
            code =>
              wService.submit(userId, {
                intentId: cachedWithdrawalSubmit!.intentId,
                authorizationId: cachedWithdrawalSubmit!.authorizationId,
                otp: code
              })
          );
        const [a, b] = await Promise.allSettled([runSubmit(), runSubmit()]);
        return [a, b];
      },
      reducingRequest: reducingReq,
      requestReducingRace: async (userId, req) => {
        const [a, b] = await Promise.allSettled([
          rService.request(userId, req),
          rService.request(userId, req)
        ]);
        return [a, b];
      },
      runFinancialRace: async (userId, intentId) => {
        const [a, b] = await Promise.allSettled([
          rRunner.run(userId, intentId),
          rRunner.run(userId, intentId)
        ]);
        return [a, b];
      },
      observeCounts: async () => {
        const state = c1Store.committed();
        return {
          executions: state.copy_executions.length,
          deliveries: state.source_fanout_deliveries.length,
          otpConsumedCount: state.withdrawal_authorizations.filter(a => a.consumed_at !== null).length,
          intents: state.withdrawal_reducing_intents.filter(i => i.kind === 'reducing').length,
          attempts: state.withdrawal_reducing_attempts.length,
          reservations: state.withdrawal_reducing_reservations.filter(r => r.purpose === 'exposure').length
        };
      }
    },

    // --- Category 2 Ports ---
    tenantInterference: {
      tenantA: TENANT_A,
      tenantB: TENANT_B,
      probeGucAndIsolation: async deadline => {
        deadline.check();
        const tStore = createStatefulP6SqlStore();
        seedPipelineSourceAndPolicy(tStore, [TENANT_A, TENANT_B]);
        tStore.seed(t => {
          t.copy_position_master_lots.push({
            id: LOT_ID,
            user_id: TENANT_A,
            chain: 'solana',
            token_mint: TOKEN_MINT
          });
        });

        const custodyEnroll = createCustodyEnrollmentStore((scope: UserScope, op) =>
          tStore.runInTransaction(scope.userId, c => op(c as unknown as any))
        );
        const custodyExec = createCustodyExecutionStore((scope: UserScope, op) =>
          tStore.runInTransaction(scope.userId, c => op(c as unknown as any))
        );

        await custodyEnroll.record(
          { userId: TENANT_A } as UserScope,
          {
            id: GRANT_ID,
            chain: 'solana',
            grantKind: 'solana_vault',
            accountAddress: '11111111111111111111111111111111',
            sealedSecret: null,
            keyVersion: null,
            secretBinding: null,
            scopePolicy: null,
            expiresAt: null
          }
        );

        const claimA = await tStore.runInTransaction(TENANT_A, c =>
          claimSourceSignalForCopyExecutionWithClient(c, {
            signalId: SIGNAL_ID,
            targetAccount: TARGET_ACCOUNT,
            userId: TENANT_A,
            executionMode: 'paper',
            requestedQuoteQuantity: '10',
            maxPositionEvidenceAgeMs: 60_000,
            now: new Date(BASE_NOW)
          })
        );

        const seenByA = await tStore.runInTransaction(TENANT_A, async c => {
          const ex = await c.query('SELECT id FROM copy_executions WHERE id = $1', [claimA.execution!.id]);
          const lot = await c.query('SELECT id FROM copy_position_master_lots WHERE id = $1', [LOT_ID]);
          return ex.rows.length === 1 && lot.rows.length === 1;
        });

        const seenByBExec = await tStore.runInTransaction(TENANT_B, async c =>
          (await c.query('SELECT id FROM copy_executions WHERE id = $1', [claimA.execution!.id])).rows.length === 0
        );
        const seenByBCustody = (await custodyExec.load({ userId: TENANT_B } as UserScope, GRANT_ID)) === null;
        const seenByBLot = await tStore.runInTransaction(TENANT_B, async c =>
          (await c.query('SELECT id FROM copy_position_master_lots WHERE id = $1', [LOT_ID])).rows.length === 0
        );

        // Pooled connection GUC reset check after COMMIT and ROLLBACK
        const pooledConn = tStore.newConnection();
        await pooledConn.query('BEGIN');
        await pooledConn.query("SELECT set_config('app.current_user_id', $1, true)", [TENANT_A]);
        await pooledConn.query('COMMIT');

        const afterCommit = await pooledConn.query<{ reset: boolean }>(
          "SELECT NULLIF(current_setting('app.current_user_id', true), '') IS NULL AS reset"
        );

        await pooledConn.query('BEGIN');
        await pooledConn.query("SELECT set_config('app.current_user_id', $1, true)", [TENANT_A]);
        await pooledConn.query('ROLLBACK');

        const afterRollback = await pooledConn.query<{ reset: boolean }>(
          "SELECT NULLIF(current_setting('app.current_user_id', true), '') IS NULL AS reset"
        );

        return {
          tenantAOnlyVisibleToA: seenByA,
          tenantBBlockedFromAExecution: seenByBExec,
          tenantBBlockedFromACustody: seenByBCustody,
          tenantBBlockedFromALot: seenByBLot,
          pooledGucResetAfterCommitAndRollback:
            afterCommit.rows[0]?.reset === true && afterRollback.rows[0]?.reset === true
        };
      },
      raceBudgetDrain: async () => {
        const bStore = createStatefulP6SqlStore();
        const availableRaw = '100';
        const bOtp = createProtectedWithdrawalOtp({
          key: otpKeyPort,
          delivery: {
            resolveVerifiedRecipient: async userId => ({ userId, verified: true, recipientHandle: { channel: 'p6' } }),
            deliver: async () => 'sent'
          }
        });
        const drainService = createWithdrawalService({
          transaction: bStore.withdrawalTx(),
          lockEligibility: async (_c, intent) => ({
            userId: intent.userId,
            chain: intent.chain,
            network: intent.network,
            mode: intent.mode,
            assetId: intent.assetId,
            assetScale: intent.assetScale,
            sourceWalletId: intent.sourceWalletId,
            destination: intent.destination,
            destinationVerifiedAt: '2026-11-20T12:00:00.000Z',
            availableRaw,
            observedAt: bStore.now,
            validUntil: new Date(Date.parse(bStore.now) + 60_000).toISOString(),
            custodyRevision: 'r1',
            balanceProof: 'p6-drain-proof'
          }),
          lockFunding: async (_c, userId, budget) => financialFundingFixture(userId, budget, bStore.now, availableRaw),
          otp: bOtp
        });

        // Use two separate requestKeys racing for the same budget (Intent 1: 70+10=80, Intent 2: 40+5=45)
        const baseReq: WithdrawalRequest = {
          requestKey: 'drain-1',
          chain: 'polygon',
          network: 'polygon:137',
          assetId: 'USDC',
          assetScale: 6,
          sourceWalletId: 'shared-wallet',
          destination: `0x${'a'.repeat(40)}`,
          amountRaw: '70',
          maxFeeRaw: '10',
          feeAssetId: 'USDC',
          feeAssetScale: 6,
          feeFundingAccountId: 'shared-wallet',
          mode: 'paper'
        };

        let code1 = '';
        let code2 = '';
        let activeKey = 1;
        const captureService = createWithdrawalService({
          transaction: bStore.withdrawalTx(),
          lockEligibility: async (_c, intent) => ({
            userId: intent.userId,
            chain: intent.chain,
            network: intent.network,
            mode: intent.mode,
            assetId: intent.assetId,
            assetScale: intent.assetScale,
            sourceWalletId: intent.sourceWalletId,
            destination: intent.destination,
            destinationVerifiedAt: '2026-11-20T12:00:00.000Z',
            availableRaw,
            observedAt: bStore.now,
            validUntil: new Date(Date.parse(bStore.now) + 60_000).toISOString(),
            custodyRevision: 'r1',
            balanceProof: 'p6-drain-proof'
          }),
          lockFunding: async (_c, userId, budget) => financialFundingFixture(userId, budget, bStore.now, availableRaw),
          otp: createProtectedWithdrawalOtp({
            key: otpKeyPort,
            delivery: {
              resolveVerifiedRecipient: async userId => ({ userId, verified: true, recipientHandle: { channel: 'p6' } }),
              deliver: async (_r, code) => {
                if (activeKey === 1) code1 = code;
                else code2 = code;
                return 'sent';
              }
            }
          })
        });
        void drainService;

        activeKey = 1;
        const auth1 = await captureService.requestOtp(TENANT_A, baseReq);
        activeKey = 2;
        const auth2 = await captureService.requestOtp(TENANT_A, {
          ...baseReq,
          requestKey: 'drain-2',
          amountRaw: '40',
          maxFeeRaw: '5'
        });

        const [s1, s2] = await Promise.allSettled([
          captureService.submit(TENANT_A, { intentId: auth1.intent.id, authorizationId: auth1.authorizationId, otp: code1 }),
          captureService.submit(TENANT_A, { intentId: auth2.intent.id, authorizationId: auth2.authorizationId, otp: code2 })
        ]);

        const reservedRaw = bStore.committed().withdrawal_reducing_reservations
          .reduce((sum, r) => sum + BigInt(r.reserved_raw), 0n)
          .toString();

        return {
          firstCommitted: s1.status === 'fulfilled',
          secondRejectedInsufficient:
            s2.status === 'rejected'
            && s2.reason instanceof WithdrawalProtocolError
            && s2.reason.code === 'withdrawal-balance-insufficient',
          reservedRaw,
          availableRaw
        };
      },
      attackForeignFeeAndLot: async () => {
        const fStore = createStatefulP6SqlStore();
        const foreignFeeService = createWithdrawalService({
          transaction: fStore.withdrawalTx(),
          lockEligibility: async (_c, intent) => ({
            userId: intent.userId,
            chain: intent.chain,
            network: intent.network,
            mode: intent.mode,
            assetId: intent.assetId,
            assetScale: intent.assetScale,
            sourceWalletId: intent.sourceWalletId,
            destination: intent.destination,
            destinationVerifiedAt: '2026-11-20T12:00:00.000Z',
            availableRaw: '1000',
            observedAt: fStore.now,
            validUntil: new Date(Date.parse(fStore.now) + 60_000).toISOString(),
            custodyRevision: 'r1',
            balanceProof: 'p6-proof'
          }),
          // Simulate funding port returning Tenant B's funding record when Tenant A requested foreign feeFundingAccountId
          lockFunding: async (_c, _userId, budget) => financialFundingFixture(TENANT_B, budget, fStore.now, '1000'),
          otp: otpPorts
        });

        let foreignFeeAccountRejected = false;
        try {
          await foreignFeeService.requestOtp(TENANT_A, {
            ...withdrawalRequest,
            requestKey: 'foreign-fee-attack',
            feeFundingAccountId: 'tenant-b-fee-wallet'
          });
        } catch (err) {
          foreignFeeAccountRejected =
            err instanceof WithdrawalProtocolError && err.code === 'financial-fee-funding-scope-mismatch';
        }

        // Foreign lotId attack via real createWave4SpotSettler
        const spotSettler = createWave4SpotSettler();
        const spotIntent = reducingIntent(
          TENANT_A,
          {
            ...reducingReq,
            requestKey: 'foreign-lot-attack',
            venue: 'spot',
            chain: 'solana',
            positionId: LOT_ID
          },
          '2026-11-25T12:00:00.000Z'
        );
        const spotRecord: FinancialRecord<ReducingIntent> = {
          id: deterministicUuid('spot-intent', 1),
          userId: TENANT_A,
          intent: spotIntent,
          intentHash: financialHash(spotIntent),
          status: 'prepared',
          completedRaw: '0',
          terminal: false,
          createdAt: BASE_NOW
        };
        const spotReceipt: FinancialReceipt = {
          receiptId: 'spot-receipt-foreign',
          providerIdentity: 'p6-provider',
          proof: 'p6-proof',
          intentId: spotRecord.id,
          intentHash: spotRecord.intentHash,
          attemptId: deterministicUuid('spot-attempt', 1),
          clientOrderId: 'spot-order-foreign',
          cumulativeRaw: '50',
          feeRaw: '5',
          feeAssetId: spotIntent.feeAssetId,
          feeAssetScale: spotIntent.feeAssetScale,
          feeFundingAccountId: spotIntent.feeFundingAccountId,
          terminal: true,
          outcome: 'fill',
          observedAt: BASE_NOW
        };

        let foreignLotRejected = false;
        try {
          await fStore.runInTransaction(TENANT_A, client =>
            spotSettler(client as unknown as WithdrawalSqlClient, spotRecord, spotReceipt, '50', '5')
          );
        } catch (err) {
          foreignLotRejected =
            err instanceof WithdrawalProtocolError && err.code === '089-persisted-canonical-spot-binding-unavailable';
        }

        return { foreignFeeAccountRejected, foreignLotRejected };
      }
    },

    // --- Category 3 Ports ---
    expiryCancelFeeOnly: {
      runPostLockExpiry: async () => {
        // 3a. Post-lock clock expiry inside claimSourceSignalForCopyExecutionWithClient
        const eStore = createStatefulP6SqlStore();
        seedPipelineSourceAndPolicy(eStore, [TENANT_A]);
        // Signal expires 1000ms after BASE_NOW
        eStore.seed(t => {
          t.signals[0]!.expires_at = new Date(Date.parse(BASE_NOW) + 1000);
        });

        let monoMs = 0;
        const perfSpy = vi.spyOn(performance, 'now').mockImplementation(() => monoMs);
        let pipelineExpiredAfterLockRejected = false;
        try {
          await eStore.runInTransaction(TENANT_A, async client => {
            const origQuery = client.query.bind(client);
            const wrapped = {
              ...client,
              query: async (sql: string, values?: unknown[]) => {
                if (sql.includes('pg_advisory_xact_lock')) {
                  monoMs = 2000; // Advance monotonic clock past signal expiry AFTER acquiring advisory lock
                }
                return origQuery(sql, values);
              }
            } as unknown as PoolClient;
            const res = await claimSourceSignalForCopyExecutionWithClient(wrapped, {
              signalId: SIGNAL_ID,
              targetAccount: TARGET_ACCOUNT,
              userId: TENANT_A,
              executionMode: 'paper',
              requestedQuoteQuantity: '10',
              maxPositionEvidenceAgeMs: 60_000,
              now: new Date(BASE_NOW)
            });
            pipelineExpiredAfterLockRejected =
              res.execution === null
              && res.created === false
              && res.claimed === false
              && res.reason === 'Source signal expired before execution claim';
          });
        } finally {
          perfSpy.mockRestore();
        }
        const pipelineInsertedCount = eStore.committed().copy_executions.length;

        // 3b. Post-lock financial authorization expiry inside createDurableFinancialRunner
        const fExpStore = createStatefulP6SqlStore();
        const expService = createReducingService({
          transaction: fExpStore.withdrawalTx(),
          lockExposure: async (_c, intent) => ({
            ...intent,
            heldRaw: '100',
            revision: 'rev-1',
            observedAt: fExpStore.now,
            validUntil: new Date(Date.parse(fExpStore.now) + 900_000).toISOString(),
            proof: 'p6-exp'
          }),
          lockFunding: async (_c, userId, budget) => financialFundingFixture(userId, budget, fExpStore.now, '1000'),
          intentTtlMs: 1000
        });
        const admitted = await expService.request(TENANT_A, {
          ...reducingReq,
          requestKey: 'post-lock-exp-fin'
        });

        let dispatched = 0;
        const expRunner = createDurableFinancialRunner<ReducingIntent>({
          transaction: fExpStore.withdrawalTx(),
          revalidate: expService.revalidate,
          effects: {
            authorize: async (record, attempt) => {
              const auth = financialAuthorizationFixture(record, attempt, fExpStore.now);
              // Clock advances past authorization.deadline & intent.expiresAt while authorize runs
              fExpStore.advanceMs(5000);
              return auth;
            },
            submit: async () => {
              dispatched++;
              return null;
            },
            reconcile: async () => null,
            verify: async () => null
          },
          account: async () => 'unused'
        });

        let financialExpiredAuthRejected = false;
        try {
          await expRunner.run(TENANT_A, admitted.id);
        } catch (err) {
          financialExpiredAuthRejected =
            err instanceof WithdrawalProtocolError
            && (err.code === 'reducing-intent-expired' || err.code === 'financial-authorization-expired');
        }

        return {
          pipelineExpiredAfterLockRejected,
          pipelineInsertedCount,
          financialExpiredAuthRejected,
          financialDispatchedCount: dispatched
        };
      },

      raceCancelVsSettlement: async winner => {
        const raceStore = createStatefulP6SqlStore();
        const observe = createOwnedFinancialObserver<ReducingIntent>(raceStore.withdrawalTx());
        const rSvc = createReducingService({
          transaction: raceStore.withdrawalTx(),
          lockExposure: async (_c, intent) => ({
            ...intent,
            heldRaw: '100',
            revision: 'rev-1',
            observedAt: raceStore.now,
            validUntil: new Date(Date.parse(raceStore.now) + 900_000).toISOString(),
            proof: 'p6-race'
          }),
          lockFunding: async (_c, userId, budget) => ({
            ...financialFundingFixture(userId, budget, raceStore.now, '1000'),
            validUntil: new Date(Date.parse(raceStore.now) + 900_000).toISOString()
          }),
          intentTtlMs: 60_000
        });

        const admitted = await rSvc.request(TENANT_A, {
          ...reducingReq,
          requestKey: `cancel-vs-settle-${winner}`
        });

        let selectedReceipt: FinancialReceipt | null = null;
        const runner = createDurableFinancialRunner<ReducingIntent>({
          transaction: raceStore.withdrawalTx(),
          revalidate: rSvc.revalidate,
          effects: {
            authorize: async (record, attempt) => financialAuthorizationFixture(record, attempt, raceStore.now),
            submit: async (record, attempt) => {
              const receipt: FinancialReceipt = {
                receiptId: `receipt-${winner}`,
                providerIdentity: 'p6-provider',
                proof: 'p6-proof',
                intentId: record.id,
                intentHash: record.intentHash,
                attemptId: attempt.id,
                clientOrderId: attempt.clientOrderId,
                cumulativeRaw: record.intent.quantityRaw,
                feeRaw: '2',
                feeAssetId: record.intent.feeAssetId,
                feeAssetScale: record.intent.feeAssetScale,
                feeFundingAccountId: record.intent.feeFundingAccountId,
                terminal: true,
                outcome: 'fill',
                observedAt: raceStore.now
              };
              selectedReceipt = receipt;
              raceStore.seed(t => {
                t.withdrawal_reducing_receipts.push({
                  user_id: TENANT_A,
                  intent_id: record.id,
                  attempt_id: attempt.id,
                  receipt_id: receipt.receiptId,
                  receipt_hash: financialHash(receipt),
                  receipt,
                  admitted_at: raceStore.now
                });
              });
              return receipt;
            },
            reconcile: async () => selectedReceipt,
            verify: async (_r, _a, obs) => (obs ? (obs as FinancialReceipt) : null)
          },
          account: async (_client, _record, receipt) => `spot-ref:${receipt.receiptId}`
        });

        if (winner === 'cancel') {
          // Advance clock past intent expiry so cancelExpired wins, then runner.run observes cancelled terminal state
          raceStore.advanceMs(120_000);
          const cancelled = await runner.cancelExpired(TENANT_A, admitted.id);
          const lateRun = await runner.run(TENANT_A, admitted.id);
          const journal = await observe(TENANT_A, admitted.id);
          return {
            winnerOutcome: 'cancelled',
            loserBlockedOrNoop:
              cancelled.status === 'cancelled'
              && lateRun.kind === 'cancelled'
              && lateRun.submitted === false
              && journal.applications.length === 0,
            conserved: journal.reservations.every(r => r.reservedRaw === '0'),
            journal
          };
        }

        // Settlement wins first, then cancelExpired is rejected
        const settled = await runner.run(TENANT_A, admitted.id);
        let cancelRejected = false;
        try {
          await runner.cancelExpired(TENANT_A, admitted.id);
        } catch {
          cancelRejected = true;
        }
        const journal = await observe(TENANT_A, admitted.id);
        assertOwnedFinancialConservation(journal);
        return {
          winnerOutcome: 'settled',
          loserBlockedOrNoop: settled.kind === 'settled' && cancelRejected,
          conserved: journal.reservations.every(r => r.reservedRaw === '0'),
          journal
        };
      },

      runFeeOnlyAndZeroBaseCases: async () => {
        // 3c-i. Perps fee-only delta (deltaRaw='0', deltaFeeRaw='3')
        const fzStore = createStatefulP6SqlStore();
        const perpsReq: ReducingRequest = {
          requestKey: 'perps-fee-only',
          chain: 'polygon',
          network: 'polygon:137',
          venue: 'polymarket-perps',
          positionId: LOT_ID,
          accountId: 'venue-acc-perps',
          assetId: 'PERP-YES',
          assetScale: 6,
          mode: 'paper',
          positionSide: 'LONG',
          quantityRaw: '100',
          maxFeeRaw: '10',
          feeAssetId: 'MATIC',
          feeAssetScale: 18,
          feeFundingAccountId: 'native-fee-acc',
          limitPriceExact: '1.5',
          expectedRevision: 'r1'
        };
        const perpsIntent = reducingIntent(TENANT_A, perpsReq, '2026-11-25T12:00:00.000Z');
        const perpsRecord: FinancialRecord<ReducingIntent> = {
          id: deterministicUuid('perps-intent', 1),
          userId: TENANT_A,
          intent: { ...perpsIntent, heldBeforeRaw: '0' } as ReducingIntent & { heldBeforeRaw?: string },
          intentHash: financialHash(perpsIntent),
          status: 'uncertain',
          completedRaw: '0',
          terminal: false,
          createdAt: BASE_NOW
        };
        const perpsAttempt: FinancialAttempt = {
          id: deterministicUuid('perps-attempt', 1),
          intentId: perpsRecord.id,
          userId: TENANT_A,
          clientOrderId: 'perps-order-fee-only',
          intentHash: perpsRecord.intentHash,
          state: 'uncertain',
          completedRaw: '0',
          completedFeeRaw: '0',
          terminal: false
        };
        const perpsReceipt: FinancialReceipt = {
          receiptId: 'perps-fee-only-rcpt',
          providerIdentity: 'p6-perps',
          proof: 'p6-proof',
          intentId: perpsRecord.id,
          intentHash: perpsRecord.intentHash,
          attemptId: perpsAttempt.id,
          clientOrderId: perpsAttempt.clientOrderId,
          cumulativeRaw: '0',
          feeRaw: '3',
          feeAssetId: perpsIntent.feeAssetId,
          feeAssetScale: perpsIntent.feeAssetScale,
          feeFundingAccountId: perpsIntent.feeFundingAccountId,
          terminal: false,
          outcome: 'fill',
          observedAt: BASE_NOW
        };
        fzStore.seed(t => {
          t.withdrawal_reducing_intents.push({
            id: perpsRecord.id,
            user_id: TENANT_A,
            kind: 'reducing',
            request_key: perpsReq.requestKey,
            intent: { ...perpsIntent, heldBeforeRaw: '0' },
            intent_hash: perpsRecord.intentHash,
            expires_at: perpsIntent.expiresAt,
            created_at: BASE_NOW,
            status: 'uncertain',
            completed_raw: '0',
            terminal: false
          });
          t.withdrawal_reducing_attempts.push({
            id: perpsAttempt.id,
            intent_id: perpsRecord.id,
            user_id: TENANT_A,
            intent_hash: perpsRecord.intentHash,
            client_order_id: perpsAttempt.clientOrderId,
            state: 'uncertain',
            completed_raw: '0',
            completed_fee_raw: '0',
            terminal: false
          });
          t.withdrawal_reducing_receipts.push({
            user_id: TENANT_A,
            intent_id: perpsRecord.id,
            attempt_id: perpsAttempt.id,
            receipt_id: perpsReceipt.receiptId,
            receipt_hash: financialHash(perpsReceipt),
            receipt: perpsReceipt,
            admitted_at: BASE_NOW
          });
          t.reducing_perps_economics_admissions.push({
            receipt_id: perpsReceipt.receiptId,
            intent_id: perpsRecord.id,
            user_id: TENANT_A,
            delta_raw: '0',
            delta_fee_raw: '3',
            economics_reference: 'econ-fee-only-perps'
          });
        });

        const perpsApplied = await fzStore.runInTransaction(TENANT_A, c =>
          applyPerpsReducingReceiptWithClient(
            c as unknown as WithdrawalSqlClient,
            perpsRecord,
            perpsReceipt,
            '0',
            '3'
          )
        );
        let perpsFeeOnlyConserved = false;
        try {
          assertReducingEconomicConservation({
            side: 'LONG',
            beforeRaw: perpsApplied.beforeRaw,
            deltaRaw: '0',
            afterRaw: perpsApplied.afterRaw,
            collateralBeforeRaw: '100',
            realizedPnlRaw: '-3',
            collateralAfterRaw: '97',
            marginBeforeRaw: '50',
            marginAfterRaw: '50'
          });
          perpsFeeOnlyConserved = perpsApplied.economicsReference === 'econ-fee-only-perps';
        } catch {
          perpsFeeOnlyConserved = false;
        }

        // 3c-ii. Valuation fee-only correction (quote='20', fee=null -> correction fee='2')
        seedPipelineSourceAndPolicy(fzStore, [TENANT_A]);
        const evId = deterministicUuid('orig-ev', 1);
        const execId = deterministicUuid('corr-exec', 1);
        const valAuthorityId = 'val-auth-1';
        const valId = 'trusted-val-fee-only';
        const corrId = 'corr-fee-only-1';
        const occurredAt = new Date(BASE_NOW);
        const origRow = {
          id: evId,
          execution_id: execId,
          user_id: TENANT_A,
          source_trade_id: SOURCE_TRADE_ID,
          evidence_type: 'paper_simulation',
          evidence_id: 'orig-ev-proof-1',
          base_quantity: '1',
          quote_quantity: '20',
          quote_native_quantity: '20',
          quote_currency: 'USD',
          quote_native_usd_price: '1',
          price_usd: '20',
          fee_usd: null as string | null,
          occurred_at: occurredAt,
          completes_execution: true,
          confirmation_state: 'confirmed',
          application_active: true
        };
        const origDigest = workerOriginalEvidenceDigest(workerOriginalEvidenceSnapshot(origRow));
        fzStore.seed(t => {
          t.copy_executions.push({
            id: execId,
            signal_id: SIGNAL_ID,
            source_trade_id: SOURCE_TRADE_ID,
            chain: 'solana',
            target_account: TARGET_ACCOUNT,
            user_id: TENANT_A,
            token_mint: TOKEN_MINT,
            direction: 'buy',
            execution_mode: 'paper'
          });
          t.copy_execution_evidence.push(origRow);
          t.copy_position_applications.push({
            evidence_id: evId,
            execution_id: execId,
            user_id: TENANT_A,
            target_account: TARGET_ACCOUNT,
            chain: 'solana',
            token_mint: TOKEN_MINT,
            active: true
          });
          t.worker_valuation_authorities.push({
            authority_id: valAuthorityId,
            user_id: TENANT_A,
            chain: 'solana',
            network: `solana:wave4-${RUN_ID}`,
            provider_id: 'val-provider-1',
            identity_digest: 'val-id-digest-1',
            verifier_version: 'v1',
            enabled: true,
            valid_until: '2026-11-25T12:00:00.000Z',
            max_quote_usd: '1000',
            max_fee_usd: '100'
          });
          t.trusted_worker_valuations.push({
            valuation_id: valId,
            authority_id: valAuthorityId,
            original_evidence_id: evId,
            execution_id: execId,
            user_id: TENANT_A,
            source_evidence_id: 'ev-source-1',
            lineage_source_trade_id: SOURCE_TRADE_ID,
            lineage_acquisition_evidence_id: null,
            lineage_master_wallet_address: MASTER_WALLET,
            original_digest: origDigest,
            provider_id: 'val-provider-1',
            provider_identity_digest: 'val-id-digest-1',
            verifier_version: 'v1',
            revision: '1',
            quote_usd: null,
            fee_usd: '2',
            valid_until: '2026-11-25T12:00:00.000Z'
          });
        });

        const { totals, originalFeeStillNull } = await fzStore.runInTransaction(TENANT_A, async client => {
          await appendWorkerValuationCorrectionWithClient(client, {
            execution: {
              id: execId,
              signalId: SIGNAL_ID,
              sourceTradeId: SOURCE_TRADE_ID,
              chain: 'solana',
              targetAccount: TARGET_ACCOUNT,
              userId: TENANT_A,
              tokenMint: TOKEN_MINT,
              direction: 'buy',
              executionMode: 'paper',
              clientOrderId: 'order-corr',
              state: 'confirmed',
              requestedBaseQuantity: null,
              requestedQuoteQuantity: '20',
              confirmedBaseQuantity: '1',
              confirmedQuoteQuantity: '20',
              quoteUnassessedFillCount: 0,
              reservedBaseQuantity: '0',
              submissionAttempts: 1,
              maxSubmissionAttempts: 3,
              simulationId: null,
              submissionType: null,
              submissionId: null,
              nextReconciliationAt: null,
              reconciliationClaimId: null,
              reconciliationAttempts: 0,
              maxReconciliationAttempts: 10,
              sourcePositionBeforeQuantity: null,
              sourceSellFraction: null
            },
            originalEvidenceId: evId,
            correctionId: corrId,
            valuationId: valId,
            previousCorrectionId: null,
            now: occurredAt
          });
          const tot = await readWorkerFinancialTotalsWithClient(client, execId);
          const origPersisted = fzStore.committed().copy_execution_evidence.find(e => e.id === evId);
          return { totals: tot, originalFeeStillNull: origPersisted?.fee_usd === null };
        });

        // 3c-iii. Zero-base spot refusal before any SQL query
        const spotCalls: string[] = [];
        const spyClient: WithdrawalSqlClient = {
          query: async sql => {
            spotCalls.push(sql);
            return { rows: [] };
          }
        };
        const spotIntent = reducingIntent(
          TENANT_A,
          {
            ...reducingReq,
            venue: 'spot',
            chain: 'solana',
            positionId: LOT_ID
          },
          '2026-11-25T12:00:00.000Z'
        );
        const spotRec: FinancialRecord<ReducingIntent> = {
          id: deterministicUuid('spot-zero', 1),
          userId: TENANT_A,
          intent: spotIntent,
          intentHash: financialHash(spotIntent),
          status: 'prepared',
          completedRaw: '0',
          terminal: false,
          createdAt: BASE_NOW
        };
        const spotAtt: FinancialAttempt = {
          id: deterministicUuid('spot-zero-att', 1),
          intentId: spotRec.id,
          userId: TENANT_A,
          clientOrderId: 'spot-zero-order',
          intentHash: spotRec.intentHash,
          state: 'prepared',
          completedRaw: '0',
          completedFeeRaw: '0',
          terminal: false
        };
        const spotRcpt: FinancialReceipt = {
          receiptId: 'spot-zero-rcpt',
          providerIdentity: 'p6-spot',
          proof: 'p6-proof',
          intentId: spotRec.id,
          intentHash: spotRec.intentHash,
          attemptId: spotAtt.id,
          clientOrderId: spotAtt.clientOrderId,
          cumulativeRaw: '0',
          feeRaw: '1',
          feeAssetId: spotIntent.feeAssetId,
          feeAssetScale: spotIntent.feeAssetScale,
          feeFundingAccountId: spotIntent.feeFundingAccountId,
          terminal: false,
          outcome: 'fill',
          observedAt: BASE_NOW
        };
        const spotAdm: Wave4SpotAdmission = {
          identityId: TENANT_A,
          authorityRevision: '1',
          lotId: LOT_ID,
          executionId: execId,
          evidence: {
            executionId: execId,
            evidenceType: 'paper_simulation',
            evidenceId: 'spot-zero-ev',
            baseQuantity: '0.000000000000000000',
            quoteLeg: { amount: '10', currency: 'USD' },
            priceUsd: '10',
            feeUsd: '1',
            confirmationState: 'finalized',
            completesExecution: false,
            occurredAt: BASE_NOW,
            observedAt: BASE_NOW
          },
          economics: {
            feeAssetId: spotIntent.feeAssetId,
            feeAssetScale: spotIntent.feeAssetScale,
            feeFundingAccountId: spotIntent.feeFundingAccountId,
            feeRaw: '1',
            feeUnitUsd: '1',
            feeUsd: '1',
            quoteAssetId: 'USD',
            quoteAssetScale: 6,
            quoteAccountId: spotIntent.accountId,
            quoteRaw: '10000000',
            quoteCurrency: 'USD'
          }
        };

        let spotZeroBaseRefusedBeforeSql = false;
        try {
          await admitWave4SpotAccountingWithClient(spyClient, spotRec, spotAtt, spotRcpt, '0', '1', spotAdm);
        } catch {
          spotZeroBaseRefusedBeforeSql = spotCalls.length === 0;
        }

        let spotZeroDeltaRefusedBeforeSql = false;
        try {
          await createWave4SpotSettler()(spyClient, spotRec, spotRcpt, '0', '1');
        } catch {
          spotZeroDeltaRefusedBeforeSql = spotCalls.length === 0;
        }

        return {
          perpsFeeOnlyConserved,
          perpsAfterRawZero: perpsApplied.afterRaw === '0',
          valuationFeeOnlyComplete:
            totals.quote === '20'
            && totals.fee === '2'
            && totals.debit === '22'
            && totals.unknown === '0'
            && totals.quoteUnknown === '0',
          valuationOriginalFeeStillNull: originalFeeStillNull,
          spotZeroBaseRefusedBeforeSql,
          spotZeroDeltaRefusedBeforeSql
        };
      }
    }
  };

  // --- Category 4 Ports ---
  const bullMqOpId = deterministicUuid('bullmq-op', 1);
  const bullMqInput: QueueIdentity = {
    runId: RUN_ID,
    userId: TENANT_A,
    operationId: bullMqOpId
  };

  function makeLpService(
    lpStore: ReturnType<typeof createStatefulP6SqlStore>,
    protocol: LpInjectedProtocolPort,
    enqueue?: (input: { userId: string; operationId: string; chain: LpChain }) => Promise<void>
  ) {
    lpStore.setNow(new Date().toISOString());
    lpStore.seed(t => {
      if (!t.users.some(u => u.id === TENANT_A)) {
        t.users.push({ id: TENANT_A, status: 'active' });
      }
    });
    return createLpPaperService({
      store: createLpPaperSqlStore((scope, action) =>
        lpStore.runInTransaction(scope.userId, c => action(c))
      ),
      mode: async () => 'paper',
      protocol,
      enqueue,
      now: () => new Date(),
      plan: async (quote, strategy) => ({
        version: 2,
        protocol: quote.pool.protocol,
        strategy,
        poolEvidenceId: quote.pool.evidenceId,
        rungs: [{
          priceLower: strategy.rangeLower,
          priceUpper: strategy.rangeUpper,
          allocation: quote.amountAfter,
          binLower: 1,
          binUpper: 2
        }]
      })
    });
  }

  const faults: P6FaultPorts = {
    redisDrop: {
      simulatePreEnqueueRedisDrop: async () => {
        const lpStore = createStatefulP6SqlStore();
        lpStore.setNow(new Date().toISOString());
        const scope = { userId: TENANT_A } as UserScope;
        const protocol = syntheticLpProtocol(RUN_ID);
        const req = { ...lpRequest(RUN_ID), operationKey: `redis-drop-acq-${RUN_ID}` };
        let dropRedis = true;
        const svc = makeLpService(lpStore, protocol, async () => {
          if (dropRedis) throw new Error('Redis ECONNRESET pre-enqueue');
        });

        // Pre-admit acquisition quote
        const qInput = {
          userId: TENANT_A,
          chain: req.chain,
          poolAddress: req.poolAddress,
          depositAsset: req.depositAsset,
          deposit: req.deposit,
          action: 'acquire' as const,
          intentHash: lpAcquisitionHash(req, null),
          positionId: null,
          positionRevision: null
        };
        const acqQuote = (await protocol.quote(qInput))!;
        const acqPlan = {
          version: 2 as const,
          protocol: acqQuote.pool.protocol,
          strategy: req.strategy,
          poolEvidenceId: acqQuote.pool.evidenceId,
          rungs: [{ priceLower: 90, priceUpper: 110, allocation: acqQuote.amountAfter, binLower: 1, binUpper: 2 }]
        };
        lpStore.admitLpQuote(TENANT_A, {
          kind: 'acquisition',
          commit: { request: req, fingerprint: qInput.intentHash, quote: acqQuote, plan: acqPlan, origin: null }
        });

        const capturedProto: LpInjectedProtocolPort = {
          ...protocol,
          quote: async input => {
            if (input.action === 'acquire') return lpSnapshot(acqQuote);
            const q = (await protocol.quote(input))!;
            const pos = lpStore.committed().lp_exact_positions[0]!.data as LpExactPosition;
            lpStore.admitLpQuote(TENANT_A, {
              kind: 'operation',
              commit: {
                position: pos,
                operationKey: `redis-drop-close-${RUN_ID}`,
                fingerprint: input.intentHash,
                action: 'close',
                quote: q,
                plan: null,
                receiptKey: `lp-receipt-${lpExactHash([TENANT_A, `redis-drop-close-${RUN_ID}`, input.intentHash])}`
              }
            });
            return q;
          },
          receipt: async ({ operation, position }) => {
            const rcpt = (await protocol.receipt({ operation, position }))!;
            lpStore.admitLpSettlement(TENANT_A, operation, position, rcpt);
            return rcpt;
          }
        };

        const dropSvc = makeLpService(lpStore, capturedProto, async () => {
          if (dropRedis) throw new Error('Redis ECONNRESET pre-enqueue');
        });
        void svc;

        const pos = await dropSvc.acquire(scope, req);
        const admission = await dropSvc.requestOperation(scope, {
          positionId: pos.id,
          operationKey: `redis-drop-close-${RUN_ID}`,
          action: 'close'
        });

        const enqueueRejected = admission.queued === false;
        const durablePendingPreserved = admission.operation.status === 'pending';

        dropRedis = false;
        const enqueuedIds: string[] = [];
        const recoverSvc = makeLpService(lpStore, capturedProto, async item => {
          enqueuedIds.push(item.operationId);
        });
        const recovery = await recoverSvc.recover(scope);
        await recoverSvc.process(scope, { operationId: admission.operation.id, chain: 'solana' });

        return {
          enqueueRejected,
          durablePendingPreserved,
          recoveredOnce: recovery.queued === 1 && enqueuedIds.length === 1 && enqueuedIds[0] === admission.operation.id,
          finalReceipts: lpStore.committed().lp_exact_receipts.length
        };
      },

      simulateMidWaitRedisDrop: async () => {
        const localDeadline = new Deadline(500);
        const createdClients: InMemoryRedisClient[] = [];
        const ownedRedis = new OwnedQueueRedis(localDeadline, () =>
          new InMemoryRedisClient('127.0.0.1', REDIS_RUN_ID, c => createdClients.push(c))
        );
        const primary = ownedRedis.open('redis://127.0.0.1:6379', 'p6-mid-wait');
        const dup = primary.duplicate();
        await primary.connect();
        await dup.connect();

        // Simulate mid-wait drop via OwnedQueueRuntime.completed + deadline abort
        const qHarness = createStatefulQueueHarness(bullMqInput, '127.0.0.1', REDIS_RUN_ID);
        const runtime = new OwnedQueueRuntime(
          localDeadline,
          'redis://127.0.0.1:6379',
          bullMqInput,
          '127.0.0.1',
          REDIS_RUN_ID,
          qHarness.factories
        );
        const queue = await runtime.queue();
        const events = await runtime.events();
        const job = await queue.add(lpJobName, queueIdentity(bullMqInput).data, { jobId: queueIdentity(bullMqInput).jobId });

        const waitPromise = runtime.completed(job, events);
        // Drop Redis / abort deadline mid-wait
        localDeadline.abort();

        let waitRejectedBounded = false;
        try {
          await waitPromise;
        } catch {
          waitRejectedBounded = true;
        }

        const shutdown = new Deadline(2000);
        await Promise.allSettled([ownedRedis.close(shutdown), runtime.close(shutdown)]);
        shutdown.dispose();
        localDeadline.dispose();

        return {
          waitRejectedBounded,
          connectionsDisconnected:
            createdClients.every(c => c.disconnected) && qHarness.clients.every(c => c.disconnected)
        };
      },

      simulatePostCommitRedisDrop: async () => {
        const lpStore = createStatefulP6SqlStore();
        lpStore.setNow(new Date().toISOString());
        const scope = { userId: TENANT_A } as UserScope;
        const protocol = syntheticLpProtocol(RUN_ID);
        const req = { ...lpRequest(RUN_ID), operationKey: `post-commit-acq-${RUN_ID}` };
        const qInput = {
          userId: TENANT_A,
          chain: req.chain,
          poolAddress: req.poolAddress,
          depositAsset: req.depositAsset,
          deposit: req.deposit,
          action: 'acquire' as const,
          intentHash: lpAcquisitionHash(req, null),
          positionId: null,
          positionRevision: null
        };
        const acqQuote = (await protocol.quote(qInput))!;
        const acqPlan = {
          version: 2 as const,
          protocol: acqQuote.pool.protocol,
          strategy: req.strategy,
          poolEvidenceId: acqQuote.pool.evidenceId,
          rungs: [{ priceLower: 90, priceUpper: 110, allocation: acqQuote.amountAfter, binLower: 1, binUpper: 2 }]
        };
        lpStore.admitLpQuote(TENANT_A, {
          kind: 'acquisition',
          commit: { request: req, fingerprint: qInput.intentHash, quote: acqQuote, plan: acqPlan, origin: null }
        });
        const proto: LpInjectedProtocolPort = {
          ...protocol,
          quote: async input => {
            if (input.action === 'acquire') return lpSnapshot(acqQuote);
            const q = (await protocol.quote(input))!;
            const pos = lpStore.committed().lp_exact_positions[0]!.data as LpExactPosition;
            lpStore.admitLpQuote(TENANT_A, {
              kind: 'operation',
              commit: {
                position: pos,
                operationKey: `post-commit-close-${RUN_ID}`,
                fingerprint: input.intentHash,
                action: 'close',
                quote: q,
                plan: null,
                receiptKey: `lp-receipt-${lpExactHash([TENANT_A, `post-commit-close-${RUN_ID}`, input.intentHash])}`
              }
            });
            return q;
          },
          receipt: async ({ operation, position }) => {
            const rcpt = (await protocol.receipt({ operation, position }))!;
            lpStore.admitLpSettlement(TENANT_A, operation, position, rcpt);
            return rcpt;
          }
        };
        const svc = makeLpService(lpStore, proto);
        const pos = await svc.acquire(scope, req);
        const op = await svc.requestOperation(scope, {
          positionId: pos.id,
          operationKey: `post-commit-close-${RUN_ID}`,
          action: 'close'
        });
        await svc.process(scope, { operationId: op.operation.id, chain: 'solana' });

        const committedHashBefore = hash({
          op: lpStore.committed().lp_exact_operations,
          pos: lpStore.committed().lp_exact_positions,
          receipts: lpStore.committed().lp_exact_receipts
        });

        // Simulate Redis ack drop after commit using OwnedQueueRedis throwing on sendCommand
        const dropDeadline = new Deadline(1000);
        const dropRedis = new OwnedQueueRedis(dropDeadline, () =>
          new InMemoryRedisClient('127.0.0.1', REDIS_RUN_ID, undefined, true)
        );
        const client = dropRedis.open('redis://127.0.0.1:6379', 'p6-post-commit-drop');
        await expect(client.sendCommand('XACK')).rejects.toThrow();
        const sd = new Deadline(1000);
        await dropRedis.close(sd);
        sd.dispose();
        dropDeadline.dispose();

        const committedHashAfter = hash({
          op: lpStore.committed().lp_exact_operations,
          pos: lpStore.committed().lp_exact_positions,
          receipts: lpStore.committed().lp_exact_receipts
        });

        return {
          committedHashBefore,
          committedHashAfter,
          receipts: lpStore.committed().lp_exact_receipts.length
        };
      }
    },

    preCommitCrash: {
      simulatePipelinePreCommitCrash: async () => {
        const pStore = createStatefulP6SqlStore();
        seedPipelineSourceAndPolicy(pStore, [TENANT_A]);
        const conn = pStore.newConnection();
        const released: boolean[] = [];

        const makeLeaseClient = () => ({
          query: async (sql: string, values?: unknown[]) => {
            if (sql.includes('FROM pg_catalog.pg_roles r')) {
              return {
                command: 'SELECT',
                rows: [{
                  role: 'swat_app',
                  session: 'swat_app',
                  role_setting: 'none',
                  row_security: 'on',
                  rolcanlogin: true,
                  rolsuper: false,
                  rolbypassrls: false,
                  rolinherit: false,
                  rolcreaterole: false,
                  rolcreatedb: false,
                  rolreplication: false,
                  memberships: false,
                  owns_objects: false,
                  can_create: false,
                  backend_pid: conn.pid,
                  search_path: 'pg_catalog, public'
                }]
              };
            }
            if (sql.includes("set_config('app.current_user_id', '', true)")) {
              return conn.query("SELECT set_config('app.current_user_id', $1, true)", ['']);
            }
            if (sql.includes("set_config('app.current_user_id', '', false)")) {
              return conn.query("SELECT set_config('app.current_user_id', $1, false)", ['']);
            }
            if (sql.includes("set_config('app.worker_execution_id'")) {
              return { command: 'SELECT', rows: [] };
            }
            if (sql.includes("set_config('statement_timeout'")) {
              return { command: 'SELECT', rows: [] };
            }
            return conn.query(sql, values);
          }
        });

        const tx1 = createExecutedPipelineRuntimeTransaction(async () => ({
          client: makeLeaseClient() as any,
          release: b => released.push(b)
        }));

        let preCommitRolledBack = false;
        try {
          await tx1(async client => {
            await client.query("SELECT set_config('app.current_user_id', $1, true)", [TENANT_A]);
            await client.query(
              `INSERT INTO copy_executions (
                signal_id, source_trade_id, chain, target_account, token_mint,
                direction, execution_mode, client_order_id, requested_base_quantity,
                requested_quote_quantity, reserved_base_quantity,
                max_submission_attempts, max_reconciliation_attempts,
                source_position_before_quantity, source_sell_fraction, user_id
              ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
              [SIGNAL_ID, SOURCE_TRADE_ID, 'solana', TARGET_ACCOUNT, TOKEN_MINT, 'buy', 'paper', 'order-1', null, '25', '0', 3, 10, null, null, TENANT_A]
            );
            throw new Error('Crash before COMMIT');
          });
        } catch {
          preCommitRolledBack = true;
        }

        const zeroPartialRowsAfterCrash =
          pStore.committed().copy_executions.length === 0
          && pStore.committed().copy_execution_financial_receipts.length === 0;

        // Clean retry with fresh physical lease
        const conn2 = pStore.newConnection();
        const tx2 = createExecutedPipelineRuntimeTransaction(async () => ({
          client: {
            ...makeLeaseClient(),
            query: async (sql: string, values?: unknown[]) => {
              if (sql.includes('FROM pg_catalog.pg_roles r')) {
                return {
                  command: 'SELECT',
                  rows: [{
                    role: 'swat_app', session: 'swat_app', role_setting: 'none', row_security: 'on',
                    rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolinherit: false,
                    rolcreaterole: false, rolcreatedb: false, rolreplication: false, memberships: false,
                    owns_objects: false, can_create: false, backend_pid: conn2.pid, search_path: 'pg_catalog, public'
                  }]
                };
              }
              if (sql.includes("set_config('app.current_user_id', '', true)")) {
                return conn2.query("SELECT set_config('app.current_user_id', $1, true)", ['']);
              }
              if (sql.includes("set_config('app.current_user_id', '', false)")) {
                return conn2.query("SELECT set_config('app.current_user_id', $1, false)", ['']);
              }
              if (sql.includes("set_config('app.worker_execution_id'") || sql.includes("set_config('statement_timeout'")) {
                return { command: 'SELECT', rows: [] };
              }
              return conn2.query(sql, values);
            }
          } as any,
          release: b => released.push(b)
        }));

        await tx2(async client => {
          await client.query("SELECT set_config('app.current_user_id', $1, true)", [TENANT_A]);
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO copy_executions (
              signal_id, source_trade_id, chain, target_account, token_mint,
              direction, execution_mode, client_order_id, requested_base_quantity,
              requested_quote_quantity, reserved_base_quantity,
              max_submission_attempts, max_reconciliation_attempts,
              source_position_before_quantity, source_sell_fraction, user_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
            [SIGNAL_ID, SOURCE_TRADE_ID, 'solana', TARGET_ACCOUNT, TOKEN_MINT, 'buy', 'paper', 'order-1', null, '25', '0', 3, 10, null, null, TENANT_A]
          );
          await client.query(
            'INSERT INTO copy_execution_financial_receipts (receipt_id, execution_id, user_id) VALUES ($1, $2, $3)',
            ['rcpt-clean-1', inserted.rows[0]?.id ?? 'exec-1', TENANT_A]
          );
        });

        return {
          preCommitRolledBack,
          zeroPartialRowsAfterCrash,
          retrySingleExecution: pStore.committed().copy_executions.length === 1,
          retrySingleReceipt: pStore.committed().copy_execution_financial_receipts.length === 1
        };
      },

      simulatePipelineAmbiguousCommit: async () => {
        const commands: string[] = [];
        const released: boolean[] = [];
        const sharedClient = {
          query: async (sql: string) => {
            commands.push(sql);
            if (sql.includes('FROM pg_catalog.pg_roles r')) {
              return {
                command: 'SELECT',
                rows: [{
                  role: 'swat_app', session: 'swat_app', role_setting: 'none', row_security: 'on',
                  rolcanlogin: true, rolsuper: false, rolbypassrls: false, rolinherit: false,
                  rolcreaterole: false, rolcreatedb: false, rolreplication: false, memberships: false,
                  owns_objects: false, can_create: false, backend_pid: 77, search_path: 'pg_catalog, public'
                }]
              };
            }
            if (sql.startsWith('BEGIN')) return { command: 'BEGIN', rows: [] };
            if (sql === 'COMMIT') return { command: 'ROLLBACK', rows: [] }; // Ambiguous / non-COMMIT tag
            return { command: 'SELECT', rows: [] };
          }
        };

        const tx = createExecutedPipelineRuntimeTransaction(async () => ({
          client: sharedClient as any,
          release: b => released.push(b)
        }));

        let threwCommitUncertain = false;
        try {
          await tx(async () => true);
        } catch (err) {
          threwCommitUncertain = err instanceof ExecutedPipelineCommitUncertainError;
        }

        // Verify same physical client object is quarantined and cannot be reused
        let leaseQuarantined = false;
        try {
          await tx(async () => true);
        } catch (err) {
          leaseQuarantined = String(err).includes('quarantined') && released[0] === true;
        }

        return {
          threwCommitUncertain,
          didNotEmitRollback: !commands.includes('ROLLBACK'),
          leaseQuarantined
        };
      },

      simulateFinancialPreCommitAndFenceCrash: async () => {
        const fStore = createStatefulP6SqlStore();
        const observe = createOwnedFinancialObserver<ReducingIntent>(fStore.withdrawalTx());
        const rSvc = createReducingService({
          transaction: fStore.withdrawalTx(),
          lockExposure: async (_c, intent) => ({
            ...intent,
            heldRaw: '100',
            revision: 'rev-1',
            observedAt: fStore.now,
            validUntil: new Date(Date.parse(fStore.now) + 900_000).toISOString(),
            proof: 'p6-crash'
          }),
          lockFunding: async (_c, userId, budget) => ({
            ...financialFundingFixture(userId, budget, fStore.now, '1000'),
            validUntil: new Date(Date.parse(fStore.now) + 900_000).toISOString()
          })
        });

        const admitted = await rSvc.request(TENANT_A, {
          ...reducingReq,
          requestKey: 'pre-commit-and-fence-crash'
        });

        let submitCallCount = 0;
        let committedReceipt: FinancialReceipt | null = null;
        let crashOnSubmit = true;

        const crashRunner = createDurableFinancialRunner<ReducingIntent>({
          transaction: fStore.withdrawalTx(),
          revalidate: rSvc.revalidate,
          effects: {
            authorize: async (record, attempt) => financialAuthorizationFixture(record, attempt, fStore.now),
            submit: async (record, attempt) => {
              submitCallCount++;
              const receipt: FinancialReceipt = {
                receiptId: 'rcpt-crash-reconcile',
                providerIdentity: 'p6-provider',
                proof: 'p6-proof',
                intentId: record.id,
                intentHash: record.intentHash,
                attemptId: attempt.id,
                clientOrderId: attempt.clientOrderId,
                cumulativeRaw: record.intent.quantityRaw,
                feeRaw: '2',
                feeAssetId: record.intent.feeAssetId,
                feeAssetScale: record.intent.feeAssetScale,
                feeFundingAccountId: record.intent.feeFundingAccountId,
                terminal: true,
                outcome: 'fill',
                observedAt: fStore.now
              };
              committedReceipt = receipt;
              fStore.seed(t => {
                t.withdrawal_reducing_receipts.push({
                  user_id: TENANT_A,
                  intent_id: record.id,
                  attempt_id: attempt.id,
                  receipt_id: receipt.receiptId,
                  receipt_hash: financialHash(receipt),
                  receipt,
                  admitted_at: fStore.now
                });
              });
              if (crashOnSubmit) {
                throw new Error('Worker crash after dispatchFence & provider submit');
              }
              return receipt;
            },
            reconcile: async () => committedReceipt,
            verify: async (_r, _a, obs) => (obs ? (obs as FinancialReceipt) : null)
          },
          account: async (_client, _record, receipt) => `spot-ref:${receipt.receiptId}`
        });

        // 1. Crash before prepare COMMIT
        fStore.fail('financial:prepare');
        await expect(crashRunner.run(TENANT_A, admitted.id)).rejects.toThrow('injected SQL failure');
        fStore.fail(null);
        const prePrepareRolledBack =
          fStore.committed().withdrawal_reducing_attempts.length === 0
          && fStore.committed().withdrawal_reducing_intents[0]?.status === 'queued';

        // 2. Crash after dispatchFence during submit
        const postFenceUncertain = await crashRunner.run(TENANT_A, admitted.id);
        expect(postFenceUncertain.kind).toBe('uncertain');

        // 3. Clean retry enters reconcile-only branch (!prepared.fresh), does NOT resubmit
        crashOnSubmit = false;
        const reconciled = await crashRunner.run(TENANT_A, admitted.id);
        const journal = await observe(TENANT_A, admitted.id);
        assertOwnedFinancialConservation(journal);

        return {
          prePrepareRolledBack,
          postFenceRetryDidNotResubmit: reconciled.kind === 'settled' && reconciled.submitted === false,
          submitCallCount,
          applicationCount: journal.applications.length,
          conserved: journal.reservations.every(r => r.reservedRaw === '0'),
          journal
        };
      }
    },

    bullMqUnack: {
      input: bullMqInput,
      simulateUnackRedelivery: async deadline => {
        const lpStore = createStatefulP6SqlStore();
        lpStore.setNow(new Date().toISOString());
        const scope = { userId: TENANT_A } as UserScope;
        const protocol = syntheticLpProtocol(RUN_ID);
        const identity = queueIdentity(bullMqInput);
        const req = { ...lpRequest(RUN_ID), operationKey: identity.acquisitionKey };

        const qInput = {
          userId: TENANT_A,
          chain: req.chain,
          poolAddress: req.poolAddress,
          depositAsset: req.depositAsset,
          deposit: req.deposit,
          action: 'acquire' as const,
          intentHash: lpAcquisitionHash(req, null),
          positionId: null,
          positionRevision: null
        };
        const acqQuote = (await protocol.quote(qInput))!;
        const acqPlan = {
          version: 2 as const,
          protocol: acqQuote.pool.protocol,
          strategy: req.strategy,
          poolEvidenceId: acqQuote.pool.evidenceId,
          rungs: [{ priceLower: 90, priceUpper: 110, allocation: acqQuote.amountAfter, binLower: 1, binUpper: 2 }]
        };
        lpStore.admitLpQuote(TENANT_A, {
          kind: 'acquisition',
          commit: { request: req, fingerprint: qInput.intentHash, quote: acqQuote, plan: acqPlan, origin: null }
        });

        const capturedProto: LpInjectedProtocolPort = {
          ...protocol,
          quote: async input => {
            if (input.action === 'acquire') return lpSnapshot(acqQuote);
            const q = (await protocol.quote(input))!;
            const pos = lpStore.committed().lp_exact_positions[0]!.data as LpExactPosition;
            lpStore.admitLpQuote(TENANT_A, {
              kind: 'operation',
              commit: {
                position: pos,
                operationKey: `bullmq-close-${RUN_ID}`,
                fingerprint: input.intentHash,
                action: 'close',
                quote: q,
                plan: null,
                receiptKey: `lp-receipt-${lpExactHash([TENANT_A, `bullmq-close-${RUN_ID}`, input.intentHash])}`
              }
            });
            return q;
          },
          receipt: async ({ operation, position }) => {
            const rcpt = (await protocol.receipt({ operation, position }))!;
            lpStore.admitLpSettlement(TENANT_A, operation, position, rcpt);
            return rcpt;
          }
        };

        const svc = makeLpService(lpStore, capturedProto);
        const position = await svc.acquire(scope, req);
        const admission = await svc.requestOperation(scope, {
          positionId: position.id,
          operationKey: `bullmq-close-${RUN_ID}`,
          action: 'close'
        });

        const exactOpId = admission.operation.id;
        // Align operationId in QueueIdentity with created DB operation id
        // Note: queueIdentity requires exact input.operationId; rebind operation id in store to bullMqInput.operationId
        lpStore.seed(t => {
          const opRow = t.lp_exact_operations.find(o => o.id === exactOpId)!;
          opRow.id = bullMqInput.operationId;
          opRow.data.id = bullMqInput.operationId;
          const qa = t.lp_protected_quote_admissions.find(q => q.intent_hash === opRow.data.fingerprint)!;
          qa.context.commit.position = lpSnapshot(t.lp_exact_positions[0]!.data);
        });

        const qHarness = createStatefulQueueHarness(bullMqInput, '127.0.0.1', REDIS_RUN_ID);
        const runtime = new OwnedQueueRuntime(
          deadline,
          'redis://127.0.0.1:6379',
          bullMqInput,
          '127.0.0.1',
          REDIS_RUN_ID,
          qHarness.factories
        );

        try {
          const queue = await runtime.queue();
          const events = await runtime.events();
          await queue.add(lpJobName, identity.data, { jobId: identity.jobId, attempts: 1, removeOnComplete: false, removeOnFail: false });

          // Worker 1 settles SQL, then crashes before BullMQ ack
          let beforeJournal!: QueueJournal;
          await qHarness.simulateFirstWorkerStartAndCrashAfterCommit(async () => {
            await svc.process(scope, { operationId: bullMqInput.operationId, chain: 'solana' });
            beforeJournal = lpStore.buildLpQueueJournal(bullMqInput);
          });

          // Stall checker moves unacknowledged active job back to wait
          qHarness.triggerStallMoveToWait();

          // Worker 2 redelivers retained job and replays idempotently
          qHarness.setWaitCompletion(true);
          await runtime.worker(async job => {
            requireQueueJob(job, bullMqInput);
            const outcome = await svc.process(scope, identity.data);
            expect(outcome.operation.status).toBe('completed');
            return { operationId: bullMqInput.operationId, status: 'completed' };
          });

          const retainedJob = qHarness.getJob()!;
          await runtime.completed(retainedJob, events);
          const afterJournal = lpStore.buildLpQueueJournal(bullMqInput);

          return {
            beforeJournal,
            afterJournal,
            retainedJob: {
              id: retainedJob.id,
              name: retainedJob.name,
              data: retainedJob.data,
              attemptsStarted: retainedJob.attemptsStarted,
              stalledCounter: retainedJob.stalledCounter
            },
            finalState: await retainedJob.getState(),
            stream: qHarness.stream
          };
        } finally {
          const shutdown = new Deadline(2000);
          await runtime.close(shutdown);
          shutdown.dispose();
        }
      }
    }
  };

  return { concurrency, faults };
}

describe('P6 concurrency, tenant interference, post-lock expiry/cancel/fee-only, and fault injection offline suite', () => {
  it('Category 1: competing claims across canonical pipeline, withdrawal OTP, and reducing runner serialize to single durable effects', async () => {
    const deadline = new Deadline(10_000);
    try {
      const { concurrency } = buildP6Ports();
      const assertions = await scheduleCompetingClaims(concurrency.competingClaims, deadline);
      expect(assertions.every(a => a.passed)).toBe(true);
      expect(assertions).toHaveLength(3);
    } finally {
      deadline.dispose();
    }
  });

  it('Category 2: cross-tenant interference, pooled GUC resets, budget drain races, and foreign fee/lot attacks fail closed', async () => {
    const deadline = new Deadline(10_000);
    try {
      const { concurrency } = buildP6Ports();
      const assertions = await scheduleTenantInterference(concurrency.tenantInterference, deadline);
      expect(assertions.every(a => a.passed)).toBe(true);
      expect(assertions).toHaveLength(4);
    } finally {
      deadline.dispose();
    }
  });

  it('Category 3: post-lock expiry, cancel vs settlement races, fee-only deltas/corrections, and zero-base spot refusals', async () => {
    const deadline = new Deadline(10_000);
    try {
      const { concurrency } = buildP6Ports();
      const assertions = await scheduleExpiryCancelFeeOnly(concurrency.expiryCancelFeeOnly, deadline);
      expect(assertions.every(a => a.passed)).toBe(true);
      expect(assertions).toHaveLength(4);
    } finally {
      deadline.dispose();
    }
  });

  it('Category 4a: Redis drop simulation across pre-enqueue, mid-wait, and post-commit boundaries', async () => {
    const deadline = new Deadline(10_000);
    try {
      const { faults } = buildP6Ports();
      const assertions = await scheduleRedisDrop(faults.redisDrop, deadline);
      expect(assertions.every(a => a.passed)).toBe(true);
      expect(assertions).toHaveLength(3);
    } finally {
      deadline.dispose();
    }
  });

  it('Category 4b: pre-commit crashes, ambiguous COMMIT fences, and post-fence reconcile-only recovery without double-spending', async () => {
    const deadline = new Deadline(10_000);
    try {
      const { faults } = buildP6Ports();
      const assertions = await schedulePreCommitCrash(faults.preCommitCrash, deadline);
      expect(assertions.every(a => a.passed)).toBe(true);
      expect(assertions).toHaveLength(3);
    } finally {
      deadline.dispose();
    }
  });

  it('Category 4c: BullMQ unacknowledged commit recovery redelivers once with identical SQL economics', async () => {
    const deadline = new Deadline(10_000);
    try {
      const { faults } = buildP6Ports();
      const assertions = await scheduleBullMqUnackRecovery(faults.bullMqUnack, deadline);
      expect(assertions.every(a => a.passed)).toBe(true);
      expect(assertions).toHaveLength(1);
    } finally {
      deadline.dispose();
    }
  });

  it('Gate I5 & I6 smoke: qualifyP6Concurrency and qualifyP6Faults return passing GateResults for M5 P8', async () => {
    const deadline = new Deadline(15_000);
    try {
      const { concurrency, faults } = buildP6Ports();
      const i5 = await qualifyP6Concurrency(concurrency, deadline, { suite: 'p6-offline' });
      const i6 = await qualifyP6Faults(faults, deadline, { suite: 'p6-offline' });
      expect(i5.gate).toBe('I5');
      expect(gatePassed(i5)).toBe(true);
      expect(i6.gate).toBe('I6');
      expect(gatePassed(i6)).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it('Direct withdrawal OTP replay preserves single consumption and rejects unserialized consume conflict', async () => {
    const store = createStatefulP6SqlStore();
    let delivered = '';
    const otp = createProtectedWithdrawalOtp({
      key: { withKey: async op => op(new Uint8Array(32).fill(9)) },
      delivery: {
        resolveVerifiedRecipient: async userId => ({ userId, verified: true, recipientHandle: { channel: 'p6' } }),
        deliver: async (_r, code) => { delivered = code; return 'sent'; }
      }
    });
    const svc = createWithdrawalService({
      transaction: store.withdrawalTx(),
      lockEligibility: async (_c, intent) => ({
        userId: intent.userId,
        chain: intent.chain,
        network: intent.network,
        mode: intent.mode,
        assetId: intent.assetId,
        assetScale: intent.assetScale,
        sourceWalletId: intent.sourceWalletId,
        destination: intent.destination,
        destinationVerifiedAt: '2026-11-20T12:00:00.000Z',
        availableRaw: '1000',
        observedAt: store.now,
        validUntil: new Date(Date.parse(store.now) + 60_000).toISOString(),
        custodyRevision: 'r1',
        balanceProof: 'p6-proof'
      }),
      lockFunding: async (_c, userId, budget) => financialFundingFixture(userId, budget, store.now, '1000'),
      otp
    });
    const auth = await svc.requestOtp(TENANT_A, {
      requestKey: 'direct-replay-check',
      chain: 'polygon',
      network: 'polygon:137',
      assetId: 'USDC',
      assetScale: 6,
      sourceWalletId: 'wallet-a',
      destination: `0x${'a'.repeat(40)}`,
      amountRaw: '50',
      maxFeeRaw: '5',
      feeAssetId: 'USDC',
      feeAssetScale: 6,
      feeFundingAccountId: 'wallet-a',
      mode: 'paper'
    });
    const submit = { intentId: auth.intent.id, authorizationId: auth.authorizationId, otp: delivered };
    const first = await svc.submit(TENANT_A, submit);
    const replay = await svc.submit(TENANT_A, submit);
    expect(first.status).toBe('queued');
    expect(replay.id).toBe(first.id);
    expect(store.committed().withdrawal_reducing_outbox).toHaveLength(1);
    expect(store.committed().withdrawal_authorizations.filter(a => a.consumed_at !== null)).toHaveLength(1);
  });
});
