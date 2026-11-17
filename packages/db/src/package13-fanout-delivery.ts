import type { PoolClient, QueryResultRow } from 'pg';
import type { Chain } from '@swat/shared';
import { resolveChainAddress } from '@swat/shared';
import { getMasterSellAvailabilityWithClient } from './lot-allocation.js';
import { assertCanonicalFanoutDescriptor } from './fanout-worker-descriptor.js';

/** Requires the UNAPPLIED package13-fanout-schema.sql proposal. No fallback.
 * Every operation belongs to the caller's transaction. Never BEGIN/COMMIT,
 * release a client, enqueue work or claim source confirmation authority here.
 */
export type FanoutDeliveryMode = 'paper' | 'live' | 'shadow';
export interface FanoutDeliveryIdentity {
  readonly signalId: string;
  readonly userId: string | null;
  readonly executionMode: FanoutDeliveryMode;
  readonly targetAccount: string;
}
export interface FanoutRecipient extends FanoutDeliveryIdentity {
  readonly jobId: string;
  readonly descriptor: Readonly<Record<string, unknown>>;
}
export interface FanoutExclusion { readonly userId: string | null; readonly code: string }

export interface FanoutEnumerationClaim {
  readonly signalId: string;
  readonly sourceTradeId: string;
  readonly owner: string;
  readonly fence: string;
}
export interface FanoutDeliveryClaim extends FanoutDeliveryIdentity {
  readonly owner: string;
  readonly fence: string;
}
export interface FanoutDeliveryRow extends QueryResultRow {
  signal_id: string;
  user_id: string | null;
  execution_mode: FanoutDeliveryMode;
  target_account: string;
  job_id: string;
  descriptor: Record<string, unknown>;
  state: 'pending' | 'queued' | 'claimed' | 'blocked' | 'reconciliation_required' | 'completed';
  fence: string;
  lease_until: Date | null;
  execution_id: string | null;
  last_reason: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(name: string, value: string): string {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID`);
  return value.toLowerCase();
}
function text(name: string, value: string, max = 2000): string {
  if (!value || value.trim() !== value || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}
function time(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Invalid fanout time');
  return value;
}
function duration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 240_000) throw new Error('Invalid fanout lease duration');
  return value;
}
function limit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1001) throw new Error('Invalid fanout limit');
  return value;
}
function identityValues(identity: FanoutDeliveryIdentity): unknown[] {
  if (!['paper', 'live', 'shadow'].includes(identity.executionMode)) throw new Error('Invalid fanout execution mode');
  const target = resolveChainAddress(identity.targetAccount);
  if (target.prefixed !== identity.targetAccount) throw new Error('Fanout target must be canonical and chain-prefixed');
  return [uuid('signalId', identity.signalId), identity.userId === null ? null : uuid('userId', identity.userId), identity.executionMode, target.prefixed];
}
const IDENTITY = `signal_id = $1 AND user_id IS NOT DISTINCT FROM $2::uuid
  AND execution_mode = $3 AND target_account = $4`;

/** Persist this seed and commit BEFORE any enumeration that can fail. */
export async function ensureFanoutEnumeration(client: PoolClient, input: {
  signalId: string; sourceTradeId: string;
}): Promise<void> {
  const values = [uuid('signalId', input.signalId), uuid('sourceTradeId', input.sourceTradeId)];
  const result = await client.query(
    `INSERT INTO source_fanout_batches (signal_id, source_trade_id) VALUES ($1, $2)
     ON CONFLICT (signal_id) DO UPDATE SET updated_at = source_fanout_batches.updated_at
     WHERE source_fanout_batches.source_trade_id = EXCLUDED.source_trade_id RETURNING signal_id`, values
  );
  if (result.rows.length !== 1) throw new Error('Fanout source identity conflict');
}

export async function claimFanoutEnumeration(client: PoolClient, input: {
  signalId: string; sourceTradeId: string; owner: string; now: Date; leaseMs: number;
}): Promise<FanoutEnumerationClaim | null> {
  const now = time(input.now);
  const owner = text('enumeration owner', input.owner, 128);
  const result = await client.query<{ fence: string }>(
    `UPDATE source_fanout_batches SET state = 'enumerating', fence = fence + 1,
       lease_owner = $3, lease_until = $5, updated_at = $4
     WHERE signal_id = $1 AND source_trade_id = $2
       AND (state = 'pending' OR (state = 'enumerating' AND lease_until <= $4))
     RETURNING fence::text AS fence`,
    [uuid('signalId', input.signalId), uuid('sourceTradeId', input.sourceTradeId), owner, now, new Date(now.getTime() + duration(input.leaseMs))]
  );
  return result.rows[0] ? { signalId: input.signalId, sourceTradeId: input.sourceTradeId, owner, fence: result.rows[0].fence } : null;
}

export async function failFanoutEnumeration(client: PoolClient, claim: FanoutEnumerationClaim, reason: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE source_fanout_batches SET state = 'pending', lease_owner = NULL, lease_until = NULL,
       last_error = $5, updated_at = NOW()
     WHERE signal_id = $1 AND source_trade_id = $2 AND lease_owner = $3 AND fence = $4::bigint
       AND state = 'enumerating' RETURNING signal_id`,
    [claim.signalId, claim.sourceTradeId, claim.owner, claim.fence, text('enumeration error', reason)]
  );
  return result.rows.length === 1;
}

/** Complete enumeration atomically with ALL obligations, including operator.
 * Callers build descriptors/targets from the current trusted principal, not job input.
 * A completed snapshot is immutable; retries read it rather than re-enumerating.
 */
export async function completeFanoutEnumeration(client: PoolClient, claim: FanoutEnumerationClaim, input: {
  chain: Chain; recipients: readonly FanoutRecipient[]; exclusions: readonly FanoutExclusion[]; now: Date;
}): Promise<void> {
  if (input.recipients.length > 1001 || input.exclusions.length > 1001
    || input.recipients.length + input.exclusions.length > 1001) {
    throw new Error('Fanout enumeration exceeds bounded snapshot');
  }
  const seen = new Set<string>();
  const jobs = new Set<string>();
  let operators = 0;
  for (const recipient of input.recipients) {
    const values = identityValues(recipient);
    if (values[0] !== uuid('signalId', claim.signalId)) throw new Error('Fanout recipient signal mismatch');
    if (resolveChainAddress(recipient.targetAccount).chain !== input.chain) throw new Error('Fanout target chain mismatch');
    const key = JSON.stringify(values);
    text('jobId', recipient.jobId, 256);
    if (seen.has(key) || jobs.has(recipient.jobId)) throw new Error('Duplicate fanout recipient/job');
    seen.add(key); jobs.add(recipient.jobId);
    if (recipient.userId === null) operators += 1;
    if (!recipient.descriptor || Array.isArray(recipient.descriptor) || typeof recipient.descriptor !== 'object') throw new Error('Invalid fanout descriptor');
    assertCanonicalFanoutDescriptor(recipient.descriptor, { ...recipient,
      sourceTradeId: claim.sourceTradeId, chain: input.chain });
  }
  const excluded = new Set<string | null>();
  const included = new Set(input.recipients.map(recipient => recipient.userId));
  for (const exclusion of input.exclusions) {
    const userId = exclusion.userId === null ? null : uuid('excluded userId', exclusion.userId);
    text('exclusion code', exclusion.code, 128);
    if (excluded.has(userId) || included.has(userId)) throw new Error('Duplicate/conflicting fanout outcome');
    excluded.add(userId);
    if (userId === null) operators += 1;
  }
  if (operators !== 1) throw new Error('Fanout snapshot requires exactly one operator outcome');
  const now = time(input.now);
  const fenced = await client.query(
    `UPDATE source_fanout_batches SET state = 'complete', recipient_snapshot = $5::jsonb,
       exclusion_snapshot = $6::jsonb, lease_owner = NULL, lease_until = NULL, last_error = NULL, updated_at = $7
     WHERE signal_id = $1 AND source_trade_id = $2 AND lease_owner = $3 AND fence = $4::bigint
       AND state = 'enumerating' AND lease_until > $7 RETURNING signal_id`,
    [claim.signalId, claim.sourceTradeId, claim.owner, claim.fence, JSON.stringify(input.recipients), JSON.stringify(input.exclusions), now]
  );
  if (fenced.rows.length !== 1) throw new Error('Fanout enumeration lease lost');
  for (const recipient of input.recipients) {
    await client.query(
      `INSERT INTO source_fanout_deliveries (signal_id, user_id, execution_mode, target_account, job_id, descriptor, execution_id)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [...identityValues(recipient), recipient.jobId, JSON.stringify(recipient.descriptor),
        (recipient.descriptor.data as Record<string, unknown>).copyExecutionId]
    );
  }
}

/** Repair visibility does not depend on signals.status, source_dispatched_at or age. */
export async function listFanoutEnumerationRepairs(client: PoolClient, max = 100): Promise<QueryResultRow[]> {
  return (await client.query(
    `SELECT signal_id, source_trade_id, state, fence::text, lease_until, last_error
     FROM source_fanout_batches WHERE state <> 'complete' ORDER BY created_at, signal_id LIMIT $1`, [limit(max)]
  )).rows;
}
export async function listFanoutDeliveries(client: PoolClient, signalId: string, max = 1001): Promise<FanoutDeliveryRow[]> {
  return (await client.query<FanoutDeliveryRow>(
    `SELECT *, fence::text AS fence FROM source_fanout_deliveries
     WHERE signal_id = $1 AND state <> 'completed'
     ORDER BY user_id NULLS FIRST, execution_mode, target_account LIMIT $2`, [uuid('signalId', signalId), limit(max)]
  )).rows;
}

export interface FanoutBatchRow extends QueryResultRow {
  signal_id: string;
  source_trade_id: string;
  state: 'pending' | 'enumerating' | 'complete';
  recipient_snapshot: FanoutRecipient[] | null;
  exclusion_snapshot: FanoutExclusion[] | null;
}

export async function getFanoutBatch(client: PoolClient, signalId: string): Promise<FanoutBatchRow | null> {
  return (await client.query<FanoutBatchRow>(
    `SELECT signal_id, source_trade_id, state, recipient_snapshot, exclusion_snapshot
     FROM source_fanout_batches WHERE signal_id = $1`, [uuid('signalId', signalId)]
  )).rows[0] ?? null;
}

/** No shared dispatch/status/age predicates: blocked and queue-only work is repairable. */
export async function listFanoutDeliveryRepairs(client: PoolClient, max = 100): Promise<FanoutDeliveryRow[]> {
  return (await client.query<FanoutDeliveryRow>(
    `SELECT *, fence::text AS fence FROM source_fanout_deliveries
     WHERE state IN ('pending', 'queued', 'blocked', 'claimed')
     ORDER BY updated_at, signal_id, user_id NULLS FIRST LIMIT $1`, [limit(max)]
  )).rows;
}

/** Queue-side preparation is NOT a worker claim and cannot prove completion.
 * Current admission and canonical prior effects are checked under the row lock.
 * Commit this result before queue.add; enqueue failures leave this row repairable.
 */
export async function prepareFanoutDeliveryQueueWithClient(client: PoolClient, identity: FanoutDeliveryIdentity, input: {
  now: Date; admission: (client: PoolClient) => Promise<{ allowed: boolean; reason?: string }>;
}): Promise<FanoutDeliveryRow | null> {
  const claim = await claimFanoutDelivery(client, identity, {
    ...input, owner: 'fanout-queue-prepare', leaseMs: 1
  });
  if (!claim) return null;
  const values = identityValues(identity);
  const result = await client.query<FanoutDeliveryRow>(
    `UPDATE source_fanout_deliveries SET state = 'pending', lease_owner = NULL, lease_until = NULL,
      last_reason = NULL, updated_at = $7
     WHERE ${IDENTITY} AND lease_owner = $5 AND fence = $6::bigint AND state = 'claimed'
     RETURNING *, fence::text AS fence`, [...values, claim.owner, claim.fence, time(input.now)]
  );
  if (!result.rows[0]) throw new Error('Fanout queue preparation fence lost');
  return result.rows[0];
}

export interface FanoutRecipientScope {
  readonly executionMode: FanoutDeliveryMode | null;
  readonly targetAccount: string | null;
  readonly reason: string | null;
}

/** Metadata only, never reads secrets. Scope comes from current DB policy and
 * attributable acquisition lots, not a queue payload. No lots/grants => exclusion.
 * Caller still rechecks platform mode/source readiness; this is not order authority.
 */
export async function readFanoutRecipientScopeWithClient(client: PoolClient, input: {
  userId: string | null; chain: Chain; tokenMint: string; masterWalletAddress: string;
  direction: 'buy' | 'sell'; platformMode: string; paperTargetAccount: string; now: Date;
}): Promise<FanoutRecipientScope> {
  const refused = (reason: string): FanoutRecipientScope => ({ executionMode: null, targetAccount: null, reason });
  const userId = input.userId === null ? null : uuid('userId', input.userId);
  time(input.now);
  for (const value of [input.tokenMint, input.masterWalletAddress, input.paperTargetAccount]) {
    if (resolveChainAddress(value).chain !== input.chain) throw new Error('Fanout scope chain mismatch');
  }
  if (input.platformMode === 'off') return refused('chain-execution-off');
  if (!['paper', 'live', 'live+shadow'].includes(input.platformMode)) return refused('chain-execution-unavailable');
  let requestedMode = input.platformMode;
  if (userId !== null) {
    const policy = await client.query<{ status: string; auto_execute: boolean; killed: boolean; mode: string; state: string }>(
      `SELECT account.status, settings.auto_execute, settings.killed, chain_settings.mode, subscription.state
       FROM users account LEFT JOIN user_execution_settings settings ON settings.user_id = account.id
       LEFT JOIN user_chain_execution_settings chain_settings ON chain_settings.user_id = account.id AND chain_settings.chain = $2
       LEFT JOIN user_wallet_subscriptions subscription ON subscription.user_id = account.id AND subscription.wallet_address = $3
       WHERE account.id = $1 FOR SHARE OF account`, [userId, input.chain, input.masterWalletAddress]
    );
    const row = policy.rows[0];
    if (!row) return refused('account-unavailable');
    if (!['active', 'suspended', 'deleted'].includes(row.status)) return refused('account-status-unreadable');
    if (row.status !== 'active') return refused('account-not-active');
    if (row.killed === true) return refused('user-killed');
    if (row.killed !== false) return refused('user-killed-or-unreadable');
    if (row.auto_execute === false) return refused('auto-execute-off');
    if (row.auto_execute !== true) return refused('execution-settings-unreadable');
    if (!['active', 'winding_down', 'ended'].includes(row.state)) return refused('subscription-unreadable');
    if (row.state !== 'active' && !(row.state === 'winding_down' && input.direction === 'sell')) {
      return refused('subscription-not-mirroring');
    }
    if (row.mode === 'off') return refused('user-chain-execution-off');
    if (!['paper', 'live'].includes(row.mode)) return refused('user-chain-execution-unreadable');
    requestedMode = row.mode === 'paper' || input.platformMode === 'paper' ? 'paper' : 'live';
  }
  if (input.direction === 'sell') {
    const lots = await client.query<{ target_account: string; execution_mode: FanoutDeliveryMode }>(
      `SELECT DISTINCT position.target_account, acquisition.execution_mode
       FROM copy_position_master_lots lot
       JOIN copy_positions position ON position.id = lot.position_id AND position.user_id IS NOT DISTINCT FROM lot.user_id
       JOIN copy_executions acquisition ON acquisition.id = lot.acquisition_execution_id
         AND acquisition.user_id IS NOT DISTINCT FROM lot.user_id AND acquisition.target_account = position.target_account
         AND acquisition.chain = lot.chain AND acquisition.token_mint = lot.token_mint AND acquisition.direction = 'buy'
         AND acquisition.source_trade_id = lot.source_trade_id AND acquisition.signal_id IS NOT DISTINCT FROM lot.signal_id
       WHERE lot.user_id IS NOT DISTINCT FROM $1::uuid AND lot.chain = $2 AND lot.token_mint = $3
         AND lot.master_wallet_address = $4 AND lot.remaining_quantity > 0`,
      [userId, input.chain, input.tokenMint, input.masterWalletAddress]
    );
    if (lots.rows.length !== 1) return refused('owned-exit-scope-missing-or-mixed');
    const lot = lots.rows[0]!;
    if (!['paper', 'live', 'shadow'].includes(lot.execution_mode)
      || (lot.execution_mode === 'live' && requestedMode !== 'live' && requestedMode !== 'live+shadow')
      || (lot.execution_mode === 'shadow' && input.platformMode !== 'live+shadow')
      || resolveChainAddress(lot.target_account).prefixed !== lot.target_account) return refused('acquisition-mode-unavailable');
    const availability = await getMasterSellAvailabilityWithClient(client, {
      userId, chain: input.chain, tokenMint: input.tokenMint, masterWalletAddress: input.masterWalletAddress,
      executionMode: lot.execution_mode, targetAccount: lot.target_account, sourceSellFraction: '1'
    });
    if (!availability.quantity || availability.reason) return refused(availability.reason ?? 'owned-exit-unavailable');
    return { executionMode: lot.execution_mode, targetAccount: lot.target_account, reason: null };
  }
  if (requestedMode === 'paper') {
    return { executionMode: 'paper', targetAccount: resolveChainAddress(input.paperTargetAccount).prefixed, reason: null };
  }
  // There is no durable metadata source for an operator live account here, and
  // dual-mode entry obligations need a separate reviewed product contract.
  if (userId === null || requestedMode !== 'live') return refused('operator-live-target-unavailable');
  const grants = await client.query<{ account_address: string }>(
    `SELECT account_address FROM user_execution_grants WHERE user_id = $1 AND chain = $2
       AND status = 'active' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3)
     ORDER BY id`, [userId, input.chain, input.now]
  );
  const accounts = new Set(grants.rows.map(row => resolveChainAddress(row.account_address, input.chain).prefixed));
  if (accounts.size !== 1) return refused('live-target-missing-or-ambiguous');
  return { executionMode: 'live', targetAccount: [...accounts][0]!, reason: null };
}

/** A late queue ack must not erase a concurrent claim, block, reconciliation or settlement. */
export async function markFanoutDeliveryQueued(client: PoolClient, identity: FanoutDeliveryIdentity): Promise<void> {
  const result = await client.query(
    `UPDATE source_fanout_deliveries SET
       state = CASE WHEN state = 'pending' THEN 'queued' ELSE state END,
       queued_at = COALESCE(queued_at, NOW()), updated_at = NOW()
     WHERE ${IDENTITY} RETURNING signal_id`, identityValues(identity)
  );
  if (result.rows.length !== 1) throw new Error('Missing durable fanout obligation');
}

/** Lock exact tenant/mode/target then recheck admission on THIS transaction client.
 * An expired worker lease is uncertain, NEVER automatically resent.
 * admission must retain verifier/safety/current policy and submission replay fencing.
 */
export async function claimFanoutDelivery(client: PoolClient, identity: FanoutDeliveryIdentity, input: {
  owner: string; now: Date; leaseMs: number;
  admission: (client: PoolClient) => Promise<{ allowed: boolean; reason?: string }>;
}): Promise<FanoutDeliveryClaim | null> {
  const values = identityValues(identity);
  const now = time(input.now);
  const owner = text('delivery owner', input.owner, 128);
  const leaseUntil = new Date(now.getTime() + duration(input.leaseMs));
  // Unlocked discovery only. Every repair follows the worker's position ->
  // execution -> delivery order, including legacy quarantine. No queue terms
  // supply canonical source scope and no historical binding is backfilled.
  const discovered = (await client.query<FanoutDeliveryRow & { scope_chain: Chain; scope_token_mint: string }>(
    `SELECT delivery.*, source.chain AS scope_chain, source.token_mint AS scope_token_mint
     FROM source_fanout_deliveries delivery
     JOIN source_fanout_batches batch ON batch.signal_id = delivery.signal_id
     JOIN source_trades source ON source.id = batch.source_trade_id
     WHERE delivery.signal_id = $1 AND delivery.user_id IS NOT DISTINCT FROM $2::uuid
       AND delivery.execution_mode = $3 AND delivery.target_account = $4`, values)).rows[0];
  if (!discovered) throw new Error('Missing durable fanout obligation');
  if (discovered.state === 'completed' || discovered.state === 'reconciliation_required') return null;
  if (resolveChainAddress(identity.targetAccount).chain !== discovered.scope_chain) {
    throw new Error('Fanout discovered source chain mismatch');
  }
  const executionScope = (await client.query<{ id: string; target_account: string; chain: Chain; token_mint: string; user_id: string | null }>(
    `SELECT id, target_account, chain, token_mint, user_id FROM copy_executions
     WHERE ${IDENTITY} OR id = $5::uuid ORDER BY id`, [...values, discovered.execution_id])).rows;
  const positionKeys = new Set<string>();
  for (const scope of [{ target_account: identity.targetAccount, chain: discovered.scope_chain,
    token_mint: discovered.scope_token_mint, user_id: identity.userId }, ...executionScope]) {
    if (resolveChainAddress(scope.target_account).chain !== scope.chain
      || resolveChainAddress(scope.target_account).prefixed !== scope.target_account
      || resolveChainAddress(scope.token_mint).chain !== scope.chain
      || resolveChainAddress(scope.token_mint).prefixed !== scope.token_mint
      || (scope.user_id !== null && uuid('position userId', scope.user_id) !== scope.user_id)) {
      throw new Error('Fanout discovered canonical position scope mismatch');
    }
    positionKeys.add(JSON.stringify([scope.target_account, scope.chain, scope.token_mint, scope.user_id]));
  }
  for (const key of [...positionKeys].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
  const executions = await client.query<{ id: string; target_account: string; chain: Chain; token_mint: string;
    user_id: string | null; proven_non_submitted: boolean }>(
    `SELECT id, target_account, chain, token_mint, user_id,
      (submission_id IS NULL AND submission_attempts = 0 AND confirmed_base_quantity = 0
       AND state IN ('requested','simulated','failed','cancelled')
       AND NOT EXISTS (SELECT 1 FROM copy_execution_evidence evidence WHERE evidence.execution_id = copy_executions.id)
       AND NOT EXISTS (SELECT 1 FROM copy_execution_worker_attempts attempt WHERE attempt.execution_id = copy_executions.id)
      ) AS proven_non_submitted FROM copy_executions WHERE ${IDENTITY} OR id = $5::uuid ORDER BY id FOR UPDATE`,
    [...values, discovered.execution_id]);
  if (executions.rows.some(scope => !positionKeys.has(JSON.stringify([
    scope.target_account, scope.chain, scope.token_mint, scope.user_id])))) {
    throw new Error('Fanout execution position scope changed after discovery');
  }
  const result = await client.query<FanoutDeliveryRow>(
    `SELECT *, fence::text AS fence FROM source_fanout_deliveries WHERE ${IDENTITY} FOR UPDATE`, values
  );
  const row = result.rows[0];
  if (!row) throw new Error('Missing durable fanout obligation');
  if (row.execution_id !== discovered.execution_id || row.job_id !== discovered.job_id
    || JSON.stringify(row.descriptor) !== JSON.stringify(discovered.descriptor)) {
    throw new Error('Fanout immutable delivery changed after discovery');
  }
  if (row.state === 'completed' || row.state === 'reconciliation_required') return null;
  let validDescriptor = false;
  try {
    const data = row.descriptor?.data as Record<string, unknown> | undefined;
    const executionId = assertCanonicalFanoutDescriptor(row.descriptor, { ...identity,
      sourceTradeId: String(data?.sourceTradeId ?? ''), chain: resolveChainAddress(identity.targetAccount).chain,
      jobId: row.job_id });
    validDescriptor = row.execution_id === executionId;
  } catch { /* Immutable legacy comparison terms are quarantined, never rebuilt. */ }
  if (!validDescriptor) {
    const clean = row.state !== 'claimed' && executions.rows.every(execution => execution.proven_non_submitted === true);
    await client.query(`UPDATE source_fanout_deliveries SET state = $5, lease_owner = NULL, lease_until = NULL,
      last_reason = 'legacy canonical descriptor unavailable; immutable terms quarantined', updated_at = $6
      WHERE ${IDENTITY}`, [...values, clean ? 'blocked' : 'reconciliation_required', now]);
    return null;
  }
  if (row.state === 'claimed') {
    if (!row.lease_until || row.lease_until <= now) {
      await client.query(`UPDATE source_fanout_deliveries SET state = 'reconciliation_required',
        lease_owner = NULL, lease_until = NULL, last_reason = 'delivery lease expired; submission outcome unknown', updated_at = $5
        WHERE ${IDENTITY}`, [...values, now]);
    }
    return null;
  }
  if (row.state !== 'pending' && row.state !== 'queued' && row.state !== 'blocked') {
    throw new Error('Unknown fanout delivery state');
  }
  // Execution proof was read under its lock BEFORE the delivery lock. No
  // execution-row lock may be acquired while retaining only a delivery lock.
  if (executions.rows.some(execution => execution.proven_non_submitted !== true)) {
    await client.query(`UPDATE source_fanout_deliveries SET state = 'reconciliation_required',
      lease_owner = NULL, lease_until = NULL, last_reason = 'existing execution requires economic reconciliation',
      updated_at = $5 WHERE ${IDENTITY}`, [...values, now]);
    return null;
  }
  // Known non-submitted blocks may be reconsidered, but only after current admission.
  const verdict = await input.admission(client);
  if (verdict.allowed !== true) {
    await client.query(`UPDATE source_fanout_deliveries SET state = 'blocked', last_reason = $5,
      lease_owner = NULL, lease_until = NULL, updated_at = $6 WHERE ${IDENTITY}`,
    [...values, text('admission denial', verdict.reason ?? 'current admission unavailable'), now]);
    return null;
  }
  const claimed = await client.query<{ fence: string }>(
    `UPDATE source_fanout_deliveries SET state = 'claimed', fence = fence + 1,
       lease_owner = $5, lease_until = $6, last_reason = NULL, updated_at = $7
     WHERE ${IDENTITY} RETURNING fence::text AS fence`, [...values, owner, leaseUntil, now]
  );
  if (!claimed.rows[0]) throw new Error('Fanout delivery claim failed');
  return { ...identity, owner, fence: claimed.rows[0].fence };
}

/** Must commit with canonical lifecycle settlement BEFORE worker acknowledgement.
 * Clean skip/authority denial/retry exhaustion is blocked only if not submitted.
 * Unknown submitted work is reconciliation_required and cannot become blocked.
 */
export async function settleFanoutDelivery(client: PoolClient, claim: FanoutDeliveryClaim, input: {
  outcome: 'blocked' | 'reconciliation_required' | 'completed'; reason: string; executionId?: string; now: Date;
}): Promise<boolean> {
  const values = identityValues(claim);
  const now = time(input.now);
  const executionId = input.executionId ? uuid('executionId', input.executionId) : null;
  if (input.outcome === 'completed' && !executionId) throw new Error('Completed delivery requires canonical execution');
  if (executionId) {
    const result = await client.query<{ state: string; submission_id: string | null; quantified_confirmed: boolean; proven_non_submitted: boolean }>(
      `SELECT execution.state, execution.submission_id,
         (execution.confirmed_base_quantity > 0
          AND execution.confirmed_base_quantity = (
            SELECT COALESCE(SUM(evidence.base_quantity), 0) FROM copy_execution_evidence evidence
            WHERE evidence.execution_id = execution.id AND evidence.confirmation_state IN ('confirmed', 'finalized'))
          AND EXISTS (SELECT 1 FROM copy_execution_evidence evidence
            WHERE evidence.execution_id = execution.id AND evidence.confirmation_state IN ('confirmed', 'finalized')
              AND evidence.base_quantity > 0 AND evidence.completes_execution)
          AND NOT EXISTS (SELECT 1 FROM copy_execution_evidence evidence
            WHERE evidence.execution_id = execution.id AND evidence.confirmation_state IN ('confirmed', 'finalized')
              AND NOT EXISTS (SELECT 1 FROM copy_position_applications application
                WHERE application.evidence_id = evidence.id AND application.execution_id = execution.id AND application.active))
         ) AS quantified_confirmed,
         (execution.submission_id IS NULL AND execution.submission_attempts = 0
          AND execution.confirmed_base_quantity = 0
          AND NOT EXISTS (SELECT 1 FROM copy_execution_evidence evidence WHERE evidence.execution_id = execution.id)
         ) AS proven_non_submitted
       FROM copy_executions execution
       JOIN signals signal ON signal.id = execution.signal_id AND signal.source_trade_id = execution.source_trade_id
       WHERE execution.signal_id = $1 AND execution.user_id IS NOT DISTINCT FROM $2::uuid
         AND execution.execution_mode = $3 AND execution.target_account = $4 AND execution.id = $5 FOR SHARE OF execution`,
      [...values, executionId]
    );
    const execution = result.rows[0];
    if (!execution) throw new Error('Fanout settlement execution identity mismatch');
    if (input.outcome === 'completed' && (execution.state !== 'confirmed' || execution.quantified_confirmed !== true)) {
      throw new Error('Fanout execution is not confirmed with applied quantified evidence');
    }
    if (input.outcome === 'blocked' && (execution.proven_non_submitted !== true || !['requested', 'simulated', 'failed', 'cancelled'].includes(execution.state))) {
      throw new Error('Submitted/uncertain fanout work requires reconciliation');
    }
  } else if (input.outcome === 'blocked') {
    const executions = await client.query(
      `SELECT id FROM copy_executions WHERE signal_id = $1 AND user_id IS NOT DISTINCT FROM $2::uuid
       AND execution_mode = $3 AND target_account = $4 FOR SHARE`, values
    );
    if (executions.rows.length !== 0) throw new Error('Existing execution must be classified before blocking delivery');
  }
  const result = await client.query(
    `UPDATE source_fanout_deliveries SET state = $7, last_reason = $8, execution_id = COALESCE(execution_id, $9),
       lease_owner = NULL, lease_until = NULL, updated_at = $10
     WHERE ${IDENTITY} AND lease_owner = $5 AND fence = $6::bigint AND state = 'claimed'
       AND ($9::uuid IS NULL OR execution_id = $9)
       AND lease_until > $10 RETURNING signal_id`,
    [...values, text('delivery owner', claim.owner, 128), claim.fence, input.outcome, text('delivery outcome reason', input.reason), executionId, now]
  );
  return result.rows.length === 1;
}
