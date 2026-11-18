import { randomUUID } from 'node:crypto';
import { assertDatabaseRole } from '../../../packages/db/src/database-role.js';
import { createCustodyEnrollmentStore, createCustodyExecutionStore } from '../../../packages/db/src/custody-store.js';
import { withdrawalSqlStore } from '../../../packages/db/src/withdrawal-store.js';
import { withdrawalIntent } from '../../../packages/db/src/withdrawal-contract.js';
import { createLpPaperSqlStore } from '../../../packages/db/src/lp-paper-store.js';
import { createLpPaperService, type LpInjectedProtocolPort } from '../../../packages/db/src/lp-paper-service.js';
import { lpExactHash, type LpExactAcquisitionRequest } from '../../../packages/db/src/lp-exact.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';
import { assertion, expectedSqlFailure, requireCheck, result, transaction, type SqlClient } from './core.js';

export const syntheticDeposit = { raw: '900719925474099312345', scale: 18 } as const;
export function syntheticLpProtocol(runId: string): LpInjectedProtocolPort {
  let quotes = 0;
  const providerId = `wave4-${runId}`;
  const network = `solana:wave4-${runId}`;
  return { providerId, networks: { solana: network },
    quote: async input => {
      const observedAt = new Date().toISOString();
      const unitPriceUsd = { raw: '1234567', scale: 6 };
      const valueMicroUsd = (BigInt(input.deposit.raw) * BigInt(unitPriceUsd.raw) / 10n ** BigInt(input.deposit.scale)).toString();
      return { version: 1, providerId, quoteId: `quote-${++quotes}`, userId: input.userId, intentHash: input.intentHash,
        action: input.action, mode: 'paper', pool: { chain: 'solana', networkId: network, protocol: 'meteora-dlmm',
          poolAddress: input.poolAddress, depositAsset: input.depositAsset, depositScale: input.deposit.scale,
          evidenceId: `pool-${quotes}`, observedAt, currentPrice: 100, binStep: 10, tickSpacing: null },
        deposit: input.deposit, unitPriceUsd, valueMicroUsd,
        amountAfter: input.action === 'close' ? { raw: '0', scale: input.deposit.scale } : input.deposit,
        proceedsMicroUsd: input.action === 'close' ? valueMicroUsd : '0', observedAt,
        expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
        economics: input.action === 'rebalance' ? { basis: 'incremental-rebalance', windowStart: observedAt,
          windowEnd: new Date(Date.parse(observedAt) + 3600_000).toISOString(), extraFeesMicroUsd: '10000000',
          inventoryChangeMicroUsd: '-1000000', impermanentLossMicroUsd: '1000000', gasMicroUsd: '100000', repositionMicroUsd: '100000' } : null };
    },
    receipt: async ({ operation: op, position }) => ({ version: 1, providerId, receiptId: `receipt-${op.id}`, receiptKey: op.receiptKey,
      userId: op.userId, positionId: op.positionId, positionRevision: op.positionRevision, mode: 'paper', action: op.action,
      networkId: op.quote.pool.networkId, chain: position.chain, protocol: position.protocol, poolAddress: position.poolAddress,
      depositAsset: position.depositAsset, quoteId: op.quote.quoteId, quoteHash: lpExactHash(op.quote), amountBefore: op.amountBefore,
      amountAfter: op.quote.amountAfter, proceedsMicroUsd: op.quote.proceedsMicroUsd, collectedFeesMicroUsd: '100000',
      executionCostsMicroUsd: '50000', settledAt: op.quote.observedAt, finality: 'paper-settled' }) };
}
export async function runtimeTransaction<T>(client: SqlClient, userId: string | null, action: (c: SqlClient) => Promise<T>) {
  return transaction(client, userId, async c => { await assertDatabaseRole(c as any, 'runtime'); return action(c); });
}
export async function seedOwners(client: SqlClient, runId: string) {
  const ids = [randomUUID(), randomUUID()];
  await runtimeTransaction(client, null, async c => {
    const privileges = (await c.query(`SELECT
      has_table_privilege(current_user,'lp_guardrail_configs','INSERT') AS guardrail,
      has_table_privilege(current_user,'lp_positions','INSERT') AS position,
      has_table_privilege(current_user,'lp_position_state_history','INSERT') AS history`)).rows[0];
    requireCheck(privileges?.guardrail === true && privileges.position === true && privileges.history === true,
      'Canonical base LP DML privileges unavailable; qualification cannot add harness-only grants');
    const empty = await c.query('SELECT count(*)::text AS count FROM users');
    requireCheck(empty.rows[0]?.count === '0', 'Tenantless runtime must not see users');
  });
  for (const id of ids) {
    await runtimeTransaction(client, id, async c => {
      await c.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'!disabled-wave4-no-login')", [id, `wave4-${runId}-${id}@example.invalid`]);
      await c.query('INSERT INTO user_execution_settings(user_id,auto_execute) VALUES($1,false)', [id]);
      await c.query('INSERT INTO lp_guardrail_configs(user_id,max_pool_allocation_pct) VALUES($1,100)', [id]);
    });
  }
  return ids as [string, string];
}
export async function qualifyRoles(client: SqlClient, pooled: SqlClient, owners: [string, string]) {
  const checks = [];
  const relations = (await client.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c WHERE c.oid IN('users'::regclass,'user_execution_settings'::regclass,'user_execution_grants'::regclass,
    'withdrawal_reducing_intents'::regclass,'lp_exact_positions'::regclass,'lp_exact_operations'::regclass,'lp_exact_receipts'::regclass)`)).rows;
  checks.push(assertion('seven domain tables force tenant RLS under non-runtime ownership', relations.length === 7
    && relations.every(r => r.relrowsecurity && r.relforcerowsecurity && r.owner !== 'swat_app')));
  for (const c of [client, pooled]) {
    for (const owner of [owners[0], owners[1], owners[0]]) {
      await runtimeTransaction(c, owner, async tx => {
        const rows = (await tx.query('SELECT id::text FROM users ORDER BY id')).rows;
        checks.push(assertion(`${c === pooled ? 'pooled' : 'direct'}-${owner}-${checks.length}-one-owner-only`, rows.length === 1 && rows[0].id === owner));
        checks.push(assertion(`${checks.length}-foreign-update-hidden`, (await tx.query('UPDATE user_execution_settings SET auto_execute=true WHERE user_id=$1', [owner === owners[0] ? owners[1] : owners[0]])).rowCount === 0));
        checks.push(assertion(`${checks.length}-foreign-insert-denied`, await expectedSqlFailure(tx,
          () => tx.query('INSERT INTO user_chain_execution_settings(user_id,chain,mode) VALUES($1,\'solana\',\'off\')', [owner === owners[0] ? owners[1] : owners[0]]), ['42501'])));
      });
      // Check the next transaction before setting any tenant GUC, including reused PgBouncer backends.
      await c.query('BEGIN');
      try {
        await assertDatabaseRole(c as any, 'runtime');
        const reset = (await c.query("SELECT NULLIF(current_setting('app.current_user_id',true),'') IS NULL AS reset, (SELECT count(*)=0 FROM users) AS hidden")).rows[0];
        checks.push(assertion(`${checks.length}-commit-resets-local-tenant`, reset?.reset && reset.hidden));
        requireCheck((await c.query('COMMIT')).command === 'COMMIT', 'Tenant reset check did not commit');
      } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; }
    }
  }
  return result('I2', checks, ['Application pre-session authentication and inspected PgBouncer transaction-pool configuration still require dedicated qualification']);
}
export function lpService(client: SqlClient, runId: string, enqueue?: (input: { userId: string; operationId: string; chain: any }) => Promise<void>) {
  return createLpPaperService({ store: createLpPaperSqlStore((scope, action) => runtimeTransaction(client, scope.userId, c => action(c as any))),
    mode: async () => 'paper', protocol: syntheticLpProtocol(runId), enqueue,
    plan: async (quote, strategy) => ({ version: 2, protocol: quote.pool.protocol, strategy, poolEvidenceId: quote.pool.evidenceId,
      rungs: [{ priceLower: strategy.rangeLower, priceUpper: strategy.rangeUpper, allocation: quote.amountAfter, binLower: 1, binUpper: 2 }] }) });
}
export function lpRequest(runId: string): LpExactAcquisitionRequest {
  return { operationKey: `acquire-${runId}`, chain: 'solana', poolAddress: 'solana:wave4-pool', depositAsset: 'solana:wave4-mint',
    deposit: syntheticDeposit, strategy: { distribution: 'spot', rangeLower: 90, rangeUpper: 110, rungCount: 1 }, autoRebalance: true };
}
export async function qualifyDomains(client: SqlClient, runId: string, owners: [string, string]) {
  const checks = [], scope = { userId: owners[0] } as UserScope, foreign = { userId: owners[1] } as UserScope;
  const custodyTx = <T>(s: UserScope, action: (c: any) => Promise<T>) => runtimeTransaction(client, s.userId, action);
  const enrollment = createCustodyEnrollmentStore(custodyTx), execution = createCustodyExecutionStore(custodyTx);
  const grantId = randomUUID();
  const grant = await enrollment.record(scope, { id: grantId, chain: 'solana', grantKind: 'solana_vault',
    accountAddress: '11111111111111111111111111111111', sealedSecret: null, keyVersion: null, secretBinding: null,
    scopePolicy: null, expiresAt: null });
  checks.push(assertion('keyless custody has no sealed execution secret', grant.hasSealedSecret === false));
  checks.push(assertion('custody read cannot cross tenant', await execution.load(foreign, grantId) === null));
  await runtimeTransaction(client, owners[0], c => c.query("UPDATE user_execution_grants SET status='revoked' WHERE id=$1", [grantId]));
  const revoked = await execution.load(scope, grantId);
  checks.push(assertion('revocation advances durable revision and tombstone', revoked?.lifecycleRevision === '2' && revoked.revocationTombstone !== null));
  await runtimeTransaction(client, owners[0], async c => {
    checks.push(assertion('keyless revocation cannot be resurrected', await expectedSqlFailure(c,
      () => c.query("UPDATE user_execution_grants SET status='active' WHERE id=$1", [grantId]), ['P0001'])));
    checks.push(assertion('runtime cannot admit custody secrets', await expectedSqlFailure(c,
      () => c.query('INSERT INTO custody_secret_admissions DEFAULT VALUES'), ['42501'])));
    const now = await withdrawalSqlStore.now(c);
    const intent = withdrawalIntent(owners[0], { requestKey: `withdraw-${runId}`, chain: 'solana', network: `wave4-${runId}`,
      assetId: 'solana:wave4-mint', assetScale: 18, sourceWalletId: randomUUID(), destination: '11111111111111111111111111111111',
      amountRaw: syntheticDeposit.raw, maxFeeRaw: '5', feeAssetId: 'solana:fee', feeAssetScale: 9,
      feeFundingAccountId: 'synthetic-fee-account', mode: 'paper' }, new Date(Date.parse(now) + 600_000).toISOString());
    const record = await withdrawalSqlStore.create(c, intent);
    checks.push(assertion('SQL withdrawal keeps exact raw amount', record.intent.amountRaw === syntheticDeposit.raw));
    checks.push(assertion('duplicate financial identity rejected', await expectedSqlFailure(c, () => withdrawalSqlStore.create(c, intent), ['23505'])));
    checks.push(assertion('financial intent body immutable', await expectedSqlFailure(c,
      () => c.query("UPDATE withdrawal_reducing_intents SET intent=jsonb_set(intent,'{amountRaw}','\"1\"') WHERE id=$1", [record.id]), ['42501', 'P0001'])));
    checks.push(assertion('runtime cannot admit settlement receipts', await expectedSqlFailure(c,
      () => c.query('INSERT INTO withdrawal_reducing_receipts DEFAULT VALUES'), ['42501'])));
    checks.push(assertion('no receiptless financial completion', await expectedSqlFailure(c,
      () => c.query("UPDATE withdrawal_reducing_intents SET completed_raw=1,status='settled',terminal=true WHERE id=$1", [record.id]), ['42501', 'P0001'])));
  });
  const service = lpService(client, runId), request = lpRequest(runId);
  const acquired = await service.acquire(scope, request);
  checks.push(assertion('actual LP store preserves fractional raw amount', lpExactHash(acquired.deposit) === lpExactHash(syntheticDeposit)));
  const admission = await service.requestOperation(scope, { positionId: acquired.id, operationKey: `close-${runId}`, action: 'close' });
  checks.push(assertion('LP close admission remains pending with inventory', admission.operation.status === 'pending'
    && (await service.position(scope, acquired.id))?.currentAmount.raw === syntheticDeposit.raw));
  await runtimeTransaction(client, owners[0], async c => {
    checks.push(assertion('LP completion cannot bypass durable receipt', await expectedSqlFailure(c,
      () => c.query("UPDATE lp_exact_operations SET status='completed',completed_at=now(),data=jsonb_set(data,'{status}','\"completed\"') WHERE id=$1", [admission.operation.id]), ['P0001'])));
    checks.push(assertion('legacy LP close cannot bypass exact receipt', await expectedSqlFailure(c,
      () => c.query("UPDATE lp_positions SET state='closed' WHERE id=$1", [acquired.id]), ['P0001'])));
    checks.push(assertion('completed LP INSERT is refused', await expectedSqlFailure(c,
      () => c.query(`INSERT INTO lp_exact_operations(id,user_id,position_id,operation_key,receipt_key,status,data,completed_at)
        VALUES($1,$2,$3,'forged','forged','completed',$4::jsonb,now())`, [randomUUID(), owners[0], acquired.id, JSON.stringify(admission.operation)]), ['P0001'])));
  });
  const done = await service.process(scope, { operationId: admission.operation.id, chain: 'solana' });
  const closed = await service.position(scope, acquired.id);
  checks.push(assertion('LP close applies bound receipt and exact economics', done.operation.status === 'completed'
    && closed?.currentAmount.raw === '0' && closed.realizedMicroUsd === '50000' && closed.revision === '1'));
  checks.push(assertion('LP immutable acquisition retry survives close', lpExactHash(await service.acquire(scope, request)) === lpExactHash(acquired)));
  await service.process(scope, { operationId: admission.operation.id, chain: 'solana' });
  await runtimeTransaction(client, owners[0], async c => {
    checks.push(assertion('duplicate LP delivery creates one durable receipt', (await c.query('SELECT count(*)::text AS count FROM lp_exact_receipts WHERE operation_id=$1', [admission.operation.id])).rows[0]?.count === '1'));
    checks.push(assertion('LP receipts append-only under runtime', await expectedSqlFailure(c,
      () => c.query('DELETE FROM lp_exact_receipts WHERE operation_id=$1', [admission.operation.id]), ['42501', 'P0001'])));
  });
  const rebalanceRequest = { ...lpRequest(runId), operationKey:`rebalance-acquire-${runId}` };
  const rebalancePosition = await service.acquire(scope, rebalanceRequest);
  checks.push(assertion('foreign LP acquisition remains hidden', await service.position(foreign, rebalancePosition.id) === null));
  const rebalance = await service.requestOperation(scope, { positionId:rebalancePosition.id,
    operationKey:`rebalance-${runId}`,action:'rebalance',automatic:true });
  checks.push(assertion('rebalance admission keeps original inventory and revision', rebalance.operation.status === 'pending'
    && (await service.position(scope, rebalancePosition.id))?.revision === '0'));
  const settledRebalance = await service.process(scope, {operationId:rebalance.operation.id,chain:'solana'});
  const rebalanced = await service.position(scope,rebalancePosition.id);
  checks.push(assertion('receipt-backed rebalance advances one revision with exact costs', settledRebalance.operation.status === 'completed'
    && rebalanced?.state === 'active' && rebalanced.currentAmount.raw === syntheticDeposit.raw
    && rebalanced.revision === '1' && rebalanced.cumulativeFeesMicroUsd === '100000'
    && rebalanced.cumulativeCostsMicroUsd === '50000' && rebalanced.realizedMicroUsd === null));
  await service.process(scope,{operationId:rebalance.operation.id,chain:'solana'});
  checks.push(assertion('rebalance replay cannot apply a second financial revision',
    lpExactHash(await service.position(scope,rebalancePosition.id)) === lpExactHash(rebalanced)));
  const noQueue = lpService(client,runId,async () => { throw new Error('Synthetic queue hint failure'); });
  const afterRebalanceClose = await noQueue.requestOperation(scope,{positionId:rebalancePosition.id,
    operationKey:`rebalance-close-${runId}`,action:'close'});
  checks.push(assertion('failed queue hint leaves committed operation recoverable', afterRebalanceClose.queued === false
    && afterRebalanceClose.operation.status === 'pending'
    && (await service.operation(scope,afterRebalanceClose.operation.id))?.status === 'pending'));
  const hints: string[] = [];
  const recovery = await lpService(client,runId,async input => { hints.push(input.operationId); }).recover(scope);
  checks.push(assertion('durable LP recovery selects the committed pending operation', recovery.queued === 1 && recovery.deferred === 0
    && hints.length === 1 && hints[0] === afterRebalanceClose.operation.id));
  await service.process(scope,{operationId:afterRebalanceClose.operation.id,chain:'solana'});
  const finallyClosed = await service.position(scope,rebalancePosition.id);
  checks.push(assertion('rebalance then close reconciles both immutable receipts', finallyClosed?.state === 'closed'
    && finallyClosed.revision === '2' && finallyClosed.currentAmount.raw === '0'
    && finallyClosed.cumulativeFeesMicroUsd === '200000' && finallyClosed.cumulativeCostsMicroUsd === '100000'
    && finallyClosed.realizedMicroUsd === '100000'));
  return result('I4', checks, ['Keyed custody/delegation, OTP authorization, reducing receipt/accounting and LP copy scenarios remain unimplemented'],
    { custodyGrantId: grantId, lpPositionId: acquired.id, lpOperationId: admission.operation.id, provider: 'synthetic-keyless-paper-only' });
}
