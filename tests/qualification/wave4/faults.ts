import { Deadline } from './containment.js';
import { exerciseRollbackSchedule } from './rollback-schedule.js';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertion, requireCheck, result, type SqlClient } from './core.js';
import { lpRequest, lpService, runtimeTransaction } from './domains.js';
import type { UserScope } from '../../../packages/db/src/tenancy.js';

export type KillPoint = 'before-settlement-commit' | 'after-settlement-commit-before-ack';
export interface WorkerInput { configPath: string; runId: string; userId: string; operationId: string; point: KillPoint | 'none' }
export interface WorkerObservation { pid: number; signal: string | null; ack: boolean; point: string | null }
import { queueIdentity, type QueueIdentity } from './queue-contract.js';
export interface QueueWorkerInput extends WorkerInput { redisRunId: string; point: 'after-settlement-commit-before-ack' }
export async function ownedQueueWorker(input: QueueWorkerInput, deadline: Deadline): Promise<WorkerObservation> {
  queueIdentity(input as QueueIdentity);
  requireCheck(/^[a-f0-9]{40}$/.test(input.redisRunId) && input.point === 'after-settlement-commit-before-ack', 'Owned queue fault input invalid');
  return spawnOwnedWorker(input, deadline, true);
}
/** Fault authority exists only for the child returned by this spawn, never an operator-supplied PID. */
export async function ownedWorker(input: WorkerInput, deadline: Deadline): Promise<WorkerObservation> {
  return spawnOwnedWorker(input, deadline, false);
}
async function spawnOwnedWorker(input: WorkerInput | QueueWorkerInput, deadline: Deadline, queueFault: boolean): Promise<WorkerObservation> {
  const timeout = deadline.remaining();
  requireCheck(input.configPath.startsWith('/') && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.runId)
    && /^[a-f0-9-]{36}$/.test(input.userId)
    && /^[a-f0-9-]{36}$/.test(input.operationId) && ['none', 'before-settlement-commit', 'after-settlement-commit-before-ack'].includes(input.point), 'Owned worker input invalid');
  const child: ChildProcess = fork(fileURLToPath(new URL(queueFault ? './queue-worker-child.ts' : './worker-child.ts', import.meta.url)), [], {
    execArgv: ['--import', fileURLToPath(new URL('../../../node_modules/tsx/dist/loader.mjs', import.meta.url))],
    env: { PATH: process.env.PATH, LANG: 'C', NODE_ENV: 'test', NODE_OPTIONS: '--max-old-space-size=256' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  return new Promise((resolve, reject) => {
    let point: string | null = null, ack = false, finished = false, pendingError: Error | undefined;
    const terminate = (error: Error) => {
      pendingError ??= error;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    let release = () => {};
    const timer = setTimeout(() => terminate(new Error('Owned worker deadline exceeded')), timeout);
    function finish(error?: Error, signal: string | null = null) {
      if (finished) return; finished = true; clearTimeout(timer); release();
      if (error) reject(error); else resolve({ pid: child.pid!, point, signal, ack });
    }
    child.once('error', error => { if (!child.pid) finish(error); else terminate(error); });
    child.on('message', (message: any) => {
      if (message?.kind === 'point') {
        if (input.point === 'none' || message.point !== input.point || point !== null
          || (queueFault && (message.runId !== input.runId || message.operationId !== input.operationId))) {
          terminate(new Error('Owned worker kill-point substitution')); return;
        }
        point = message.point;
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      } else if (message?.kind === 'ack' && input.point === 'none' && message.operationId === input.operationId
        && message.runId === input.runId && !ack) ack = true;
      else terminate(new Error('Owned worker IPC protocol mismatch'));
    });
    child.once('close', (code, signal) => {
      if (pendingError) { finish(pendingError, signal); return; }
      if (input.point === 'none') finish(code === 0 && ack ? undefined : new Error('Worker missing durable acknowledgement'), signal);
      else finish(signal === 'SIGKILL' && point === input.point && !ack ? undefined : new Error('Fault did not kill owned worker at exact boundary'), signal);
    });
    try {
      release = deadline.enroll(() => terminate(new Error('Owned worker cancelled')));
      child.send(input, error => { if (error) terminate(error); });
    } catch { terminate(new Error('Owned worker admission cancelled')); }
  });
}
export async function qualifyCrashes(client: SqlClient, runId: string, userId: string, configPath: string, deadline: Deadline) {
  const service = lpService(client, runId), scope = { userId } as UserScope, checks = [], workers = [];
  for (const point of ['before-settlement-commit', 'after-settlement-commit-before-ack'] as const) {
    const request = { ...lpRequest(runId), operationKey: `fault-${point}-${runId}` };
    const p = await service.acquire(scope, request);
    const op = (await service.requestOperation(scope, { positionId: p.id, operationKey: `close-${point}-${runId}`, action: 'close' })).operation;
    workers.push(await ownedWorker({ configPath, runId, userId, operationId: op.id, point }, deadline));
    const before = await runtimeTransaction(client, userId, c => c.query(`SELECT o.status,e.data->'currentAmount'->>'raw' AS raw,
      (SELECT count(*)::text FROM lp_exact_receipts r WHERE r.operation_id=o.id) AS receipts
      FROM lp_exact_operations o JOIN lp_exact_positions e ON e.position_id=o.position_id WHERE o.id=$1`, [op.id]));
    const row = before.rows[0];
    checks.push(assertion(`${point}-durable-state`, point === 'before-settlement-commit'
      ? row?.status === 'pending' && row.raw === request.deposit.raw && row.receipts === '0'
      : row?.status === 'completed' && row.raw === '0' && row.receipts === '1'));
    const restart = await ownedWorker({ configPath, runId, userId, operationId: op.id, point: 'none' }, deadline);
    workers.push(restart);
    const after = await runtimeTransaction(client, userId, c => c.query(`SELECT count(*)::text AS receipts FROM lp_exact_receipts WHERE operation_id=$1`, [op.id]));
    checks.push(assertion(`${point}-restart-ack-and-single-economics`, restart.ack && after.rows[0]?.receipts === '1'
      && (await service.position(scope, p.id))?.realizedMicroUsd === '50000'));
  }
  return result('I6', checks, ['Same-job BullMQ stall/redelivery is a separate source scenario requiring actual execution; Redis loss and source/outbox/canonical worker kill points remain unimplemented'], { workers });
}
export async function qualifyConcurrency(first: SqlClient, second: SqlClient, observer: SqlClient, runId: string, userId: string, deadline: Deadline) {
  const rollbackChecks = await exerciseRollbackSchedule(first, second, observer, userId, deadline);
  const scope = { userId } as UserScope, request = { ...lpRequest(runId), operationKey: `race-${runId}` };
  const a = lpService(first, runId), b = lpService(second, runId);
  const start = Date.now();
  const acquisitions = await Promise.allSettled([a.acquire(scope, request), b.acquire(scope, request)]);
  for (const r of acquisitions) if (r.status === 'rejected') throw r.reason;
  const positions = acquisitions.map(r => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof a.acquire>>>).value);
  const admission = await a.requestOperation(scope, { positionId: positions[0]!.id, operationKey: `race-close-${runId}`, action: 'close' });
  const settled = await Promise.allSettled([a.process(scope, { operationId: admission.operation.id, chain: 'solana' }),
    b.process(scope, { operationId: admission.operation.id, chain: 'solana' })]);
  for (const r of settled) if (r.status === 'rejected') throw r.reason;
  const settlements = settled.map(r => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof a.process>>>).value);
  const journal = await runtimeTransaction(first, userId, c => c.query(`SELECT
    (SELECT count(*)::text FROM lp_exact_positions WHERE user_id=$1 AND acquisition_key=$2) AS positions,
    (SELECT count(*)::text FROM lp_exact_receipts WHERE operation_id=$3) AS receipts`, [userId, request.operationKey, admission.operation.id]));
  const r = journal.rows[0];
  return result('I5', [...rollbackChecks, assertion('competing LP acquisition serializes same immutable identity', positions[0]!.id === positions[1]!.id && r.positions === '1'),
    assertion('competing LP settlements apply one receipt', settlements.every(s => s.operation.status === 'completed') && r.receipts === '1')],
    ['Post-lock expiry/cancel, canonical claims and cross-account fee races remain unimplemented'],
    { elapsedMs: Date.now() - start, journal: r, isolation: 'READ COMMITTED', concurrentClients: 2 });
}
