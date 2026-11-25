import { createHash } from 'node:crypto';
import { Deadline } from './containment.js';
import type { ReviewedMigrationSelection } from '../../../packages/db/src/migration-selection.js';
import { validatePackage28IsolationDeclarations } from '../../integration/helpers/package28-isolation.js';

export const gates = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8'] as const;
export type Gate = typeof gates[number];
export interface Endpoint {
  readonly url: string;
  readonly containerId: string;
  readonly imageId: string;
  readonly memoryBytes: number;
  readonly nanoCpus: number;
}
export interface Environment {
  readonly runId: string;
  readonly postgres: Endpoint;
  readonly redis: Endpoint;
}
export interface QualificationConfig {
  readonly reference: Environment;
  readonly candidate: Environment;
  readonly runtimeUrl: string;
  readonly pooledRuntimeUrl: string;
  readonly authorization: 'SEPARATELY_AUTHORIZED_DISPOSABLE_WAVE4';
  readonly maxDurationMs: number;
  readonly migrationSelection?: ReviewedMigrationSelection;
}
export interface Assertion { readonly name: string; readonly passed: boolean }
export interface GateResult {
  readonly gate: Gate;
  readonly assertions: readonly Assertion[];
  readonly blocked: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
}
export interface QualificationPorts {
  readonly inspect: (config: QualificationConfig, deadline: Deadline) => Promise<void>;
  readonly execute: (gate: Gate, config: QualificationConfig, deadline: Deadline) => Promise<GateResult>;
  readonly close: (deadline: Deadline) => Promise<void>;
}
const hex = /^[a-f0-9]{64}$/;
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** PostgreSQL inet_server_addr()::text appends /32 (or /128 for IPv6); strip host mask when comparing against Docker bridge IPs. */
export function normalizeServerAddress(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\/(?:32|128)$/, '') : '';
}
export function requireCheck(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
export function declarations(e: Environment) {
  return validatePackage28IsolationDeclarations({ INTEGRATION_DISPOSABLE: 'true', INTEGRATION_RUN_ID: e.runId,
    SWAT_DB_PROFILE: 'core', INTEGRATION_DATABASE_URL: e.postgres.url,
    INTEGRATION_REDIS_URL: e.redis.url, INTEGRATION_REDIS_NAMESPACE: `swat:integration:${e.runId}` });
}
export function validateConfig(c: QualificationConfig): QualificationConfig {
  requireCheck(c?.authorization === 'SEPARATELY_AUTHORIZED_DISPOSABLE_WAVE4', 'Separate disposable execution authorization declaration required');
  requireCheck(Number.isSafeInteger(c.maxDurationMs) && c.maxDurationMs >= 10_000 && c.maxDurationMs <= 600_000, 'Bounded qualification duration required');
  for (const e of [c.reference, c.candidate]) {
    declarations(e);
    for (const endpoint of [e.postgres, e.redis]) {
      requireCheck(hex.test(endpoint.containerId) && hex.test(endpoint.imageId), 'Full immutable container/image identities required');
      requireCheck(Number.isSafeInteger(endpoint.memoryBytes) && endpoint.memoryBytes >= 64 * 1024 * 1024
        && endpoint.memoryBytes <= 2 * 1024 ** 3, 'Finite infrastructure memory bound required');
      requireCheck(Number.isSafeInteger(endpoint.nanoCpus) && endpoint.nanoCpus > 0 && endpoint.nanoCpus <= 2e9, 'Finite infrastructure CPU bound required');
    }
    requireCheck(new URL(e.postgres.url).username === 'swat_migrator', 'Direct separately provisioned migrator identity required');
  }
  requireCheck(c.reference.runId !== c.candidate.runId, 'Independent reference run required');
  const endpoints = [c.reference.postgres, c.reference.redis, c.candidate.postgres, c.candidate.redis];
  requireCheck(new Set(endpoints.map(e => e.containerId)).size === 4, 'Independent owned infrastructure required');
  requireCheck(new Set(endpoints.map(e => new URL(e.url).port)).size === 4, 'Distinct owned loopback endpoints required');
  for (const url of [c.runtimeUrl, c.pooledRuntimeUrl]) {
    declarations({ ...c.candidate, postgres: { ...c.candidate.postgres, url } });
    requireCheck(new URL(url).username === 'swat_app', 'Direct authenticated runtime role required');
  }
  requireCheck(new URL(c.runtimeUrl).port === new URL(c.candidate.postgres.url).port, 'Runtime must target inspected candidate');
  requireCheck(new URL(c.pooledRuntimeUrl).port !== new URL(c.runtimeUrl).port
    && !endpoints.some(e => new URL(e.url).port === new URL(c.pooledRuntimeUrl).port), 'Dedicated PgBouncer endpoint required');
  return structuredClone(c);
}
export function assertion(name: string, condition: unknown): Assertion {
  requireCheck(typeof name === 'string' && name.length > 0, 'Named assertion required');
  return { name, passed: condition === true };
}
export function result(gate: Gate, assertions: Assertion[], blocked: string[] = [], evidence: Record<string, unknown> = {}): GateResult {
  return { gate, assertions, blocked, evidence };
}
export function gatePassed(r: GateResult): boolean {
  return r.blocked.length === 0 && r.assertions.length > 0 && r.assertions.every(a => a.passed === true)
    && new Set(r.assertions.map(a => a.name)).size === r.assertions.length;
}
export class CommitUncertainError extends Error {
  readonly code = 'COMMIT_UNCERTAIN' as const;
  readonly uncertainCommit = true as const;
  constructor(
    message = 'Transaction COMMIT uncertain; lease quarantined and downstream transitions aborted',
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'CommitUncertainError';
  }
}

export function isCommitUncertainError(error: unknown): boolean {
  if (error instanceof CommitUncertainError) return true;
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; code?: unknown; uncertainCommit?: unknown };
  return e.uncertainCommit === true
    || e.code === 'COMMIT_UNCERTAIN'
    || e.name === 'CommitUncertainError'
    || e.name === 'ExecutedPipelineCommitUncertainError'
    || e.name === 'FinancialCommitUncertainError';
}

const quarantinedClients = new WeakSet<object>();
export function quarantineClient(client: object): void { quarantinedClients.add(client); }
export function isClientQuarantined(client: object): boolean { return quarantinedClients.has(client); }

export interface TransactionFenceOptions {
  readonly deadline?: Deadline;
  readonly signal?: AbortSignal;
  readonly onUncertainCommit?: (client: SqlClient) => void | Promise<void>;
}

export interface CommitFence {
  readonly tripped: boolean;
  readonly lastError: unknown;
  assertClean(stage: string): void;
  guard<T>(stage: string, fn: () => Promise<T>): Promise<T>;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SAFE_CODE = /^(?:[0-9A-Z]{5}|[A-Z][A-Z0-9_]{1,63}|[a-z][a-z0-9-]{1,63})$/;

export function createCommitFence(deadline?: Deadline): CommitFence {
  let tripped = false;
  let lastError: unknown = null;
  return {
    get tripped() { return tripped; },
    get lastError() { return lastError; },
    assertClean(stage: string) {
      if (tripped) {
        throw lastError instanceof CommitUncertainError
          ? lastError
          : new CommitUncertainError(`Commit fence tripped; downstream ${stage} aborted`, { cause: lastError });
      }
      deadline?.check();
    },
    async guard<T>(stage: string, fn: () => Promise<T>): Promise<T> {
      this.assertClean(stage);
      try {
        const value = await fn();
        this.assertClean(stage);
        return value;
      } catch (error) {
        if (isCommitUncertainError(error)) {
          tripped = true;
          lastError = error;
        }
        throw error;
      }
    }
  };
}

export function mapUncertainCommitToGateResult(gate: Gate, phase: string, error: unknown): GateResult {
  const rawName = error instanceof Error ? error.name : 'CommitUncertainError';
  const errorName = SAFE_NAME.test(rawName) ? rawName : 'CommitUncertainError';
  return result(
    gate,
    [assertion(`${gate.toLowerCase()}-commit-fence-intact`, false)],
    [`${gate} blocked on ambiguous COMMIT during ${phase}; lease quarantined without rollback or retry`],
    {
      phase,
      errorCode: 'COMMIT_UNCERTAIN',
      errorName,
      quarantined: true,
      retried: false,
      downstreamAborted: true
    }
  );
}

export async function executeGateWithCommitFence(
  gate: Gate,
  phase: string,
  fence: CommitFence,
  fn: () => Promise<GateResult>,
  deadline?: Deadline
): Promise<GateResult> {
  try {
    return await fence.guard(phase, fn);
  } catch (error) {
    if (isCommitUncertainError(error)) {
      if (deadline?.signal.aborted) throw error;
      return mapUncertainCommitToGateResult(gate, phase, error);
    }
    throw error;
  }
}

export type QualificationPhase = 'validate' | 'inspect' | 'execute' | 'close' | 'settle';
export interface SanitizedFailureArtifact {
  readonly gate: Gate | null;
  readonly phase: QualificationPhase;
  readonly errorCode: string;
  readonly errorName: string;
  readonly commitUncertain: boolean;
  readonly timestamp: string;
}

export function sanitizeFailure(
  error: unknown,
  phase: QualificationPhase,
  gate: Gate | null,
  deadlineAborted = false
): SanitizedFailureArtifact {
  const rawName = error instanceof Error ? error.name : 'UnknownError';
  const errorName = SAFE_NAME.test(rawName) ? rawName : 'Error';
  const rawCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  const commitUncertain = isCommitUncertainError(error);
  const errorCode = commitUncertain
    ? 'COMMIT_UNCERTAIN'
    : typeof rawCode === 'string' && SAFE_CODE.test(rawCode)
      ? rawCode
      : deadlineAborted
        ? 'DEADLINE_EXCEEDED'
        : 'QUALIFICATION_ERROR';
  return {
    gate,
    phase,
    errorCode,
    errorName,
    commitUncertain,
    timestamp: new Date().toISOString()
  };
}

export async function qualify(input: QualificationConfig, ports: QualificationPorts) {
  const config = validateConfig(input);
  const started = Date.now();
  const deadline = new Deadline(config.maxDurationMs);
  const results: GateResult[] = [];
  const pending = new Set<Promise<unknown>>();
  function bounded<T>(lifetime: Deadline, action: () => Promise<T>): Promise<T> {
    lifetime.check();
    const work = Promise.resolve().then(() => { lifetime.check(); return action(); });
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return new Promise((resolve, reject) => {
      const cancelled = () => reject(new Error('Qualification capability exceeded its owned lifetime'));
      lifetime.signal.addEventListener('abort', cancelled, { once: true });
      void work.then(value => { lifetime.signal.removeEventListener('abort', cancelled); resolve(value); },
        error => { lifetime.signal.removeEventListener('abort', cancelled); reject(error); });
      if (lifetime.signal.aborted) cancelled();
    });
  }
  let failure: string | null = null;
  let cleanupComplete = false;
  let activePhase: QualificationPhase = 'inspect';
  let activeGate: Gate | null = null;
  const failureArtifacts: SanitizedFailureArtifact[] = [];
  try {
    activePhase = 'inspect';
    await bounded(deadline, () => ports.inspect(config, deadline));
    deadline.check();
    activePhase = 'execute';
    for (const gate of gates) {
      activeGate = gate;
      deadline.check();
      const r = await bounded(deadline, () => ports.execute(gate, config, deadline));
      deadline.check();
      requireCheck(r.gate === gate, 'Gate result substitution refused');
      results.push(structuredClone(r));
      if (!gatePassed(r)) break;
    }
    activeGate = null;
    activePhase = 'settle';
  } catch (error) {
    failureArtifacts.push(sanitizeFailure(error, activePhase, activeGate, deadline.signal.aborted));
    failure = isCommitUncertainError(error)
      ? 'Qualification failed on ambiguous COMMIT; lease quarantined and private operator reconciliation required'
      : 'Qualification failed; private operator log required for diagnosis';
  } finally {
    deadline.abort();
    const shutdown = new Deadline(5000);
    activePhase = 'close';
    try { await bounded(shutdown, () => ports.close(shutdown)); shutdown.check(); cleanupComplete = true; }
    catch (closeError) {
      failureArtifacts.push(sanitizeFailure(closeError, 'close', activeGate, shutdown.signal.aborted));
      failure = 'Owned client shutdown failed';
    }
    finally { shutdown.abort(); shutdown.dispose(); deadline.dispose(); }
  }
  const pendingWork = pending.size;
  const containmentComplete = cleanupComplete && pendingWork === 0;
  if (!containmentComplete && failure === null) {
    failureArtifacts.push(sanitizeFailure(new Error('Containment incomplete'), 'settle', null, true));
    failure = 'Owned work did not settle during shutdown';
  }
  return { version: 1, runId: config.candidate.runId, results, unexecuted: gates.filter(g => !results.some(r => r.gate === g)),
    failure, failureArtifact: failureArtifacts[0] ?? null, failureArtifacts,
    elapsedMs: Date.now() - started, cleanupComplete, pendingWork, containmentComplete,
    observedGatesComplete: containmentComplete && failure === null && results.length === gates.length && results.every(gatePassed),
    runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false };
}

export interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; command?: string; rowCount?: number | null }>;
}
export async function transaction<T>(
  client: SqlClient,
  userId: string | null,
  action: (client: SqlClient) => Promise<T>,
  fence?: TransactionFenceOptions
): Promise<T> {
  requireCheck(userId === null || /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(userId), 'Canonical synthetic tenant required');
  requireCheck(!isClientQuarantined(client), 'Quarantined SQL client refused; reconcile durable state on a new lease');
  const assertActive = (stage: string) => {
    fence?.deadline?.check();
    requireCheck(!fence?.signal?.aborted, `Transaction aborted before ${stage}`);
  };
  assertActive('BEGIN');
  const begin = await client.query('BEGIN');
  requireCheck(begin.command === 'BEGIN', 'Transaction BEGIN refused');
  let committing = false;
  const txClient: SqlClient = {
    query: (sql, values) => {
      assertActive('query');
      return client.query(sql, values);
    }
  };
  try {
    await txClient.query("SET LOCAL statement_timeout = '10s'");
    await txClient.query("SET LOCAL lock_timeout = '2s'");
    await txClient.query("SET LOCAL app.bypass_rls = 'off'");
    await txClient.query("SELECT set_config('app.current_user_id',$1,true)", [userId ?? '']);
    const value = await action(txClient);
    assertActive('COMMIT');
    committing = true;
    const abortSignals = [fence?.deadline?.signal, fence?.signal].filter((s): s is AbortSignal => Boolean(s));
    let commitResult: { rows: any[]; command?: string; rowCount?: number | null };
    if (abortSignals.length === 0) {
      commitResult = await client.query('COMMIT');
    } else {
      const listeners: Array<{ signal: AbortSignal; fn: () => void }> = [];
      try {
        commitResult = await new Promise((resolve, reject) => {
          let settled = false;
          const onAbort = () => {
            if (settled) return;
            settled = true;
            reject(new CommitUncertainError());
          };
          for (const sig of abortSignals) {
            if (sig.aborted) { onAbort(); return; }
            sig.addEventListener('abort', onAbort, { once: true });
            listeners.push({ signal: sig, fn: onAbort });
          }
          Promise.resolve(client.query('COMMIT')).then(
            res => { if (!settled) { settled = true; resolve(res); } },
            err => { if (!settled) { settled = true; reject(err); } }
          );
        });
      } finally {
        for (const { signal: sig, fn } of listeners) sig.removeEventListener('abort', fn);
      }
    }
    if (commitResult.command !== 'COMMIT' || abortSignals.some(s => s.aborted)) {
      throw new CommitUncertainError();
    }
    committing = false;
    return value;
  } catch (error) {
    if (committing || isCommitUncertainError(error)) {
      quarantineClient(client);
      try {
        await fence?.onUncertainCommit?.(client);
      } catch {
        /* retain quarantine and original uncertainty */
      }
      throw error instanceof CommitUncertainError ? error : new CommitUncertainError(undefined, { cause: error });
    }
    if (!fence?.deadline?.signal.aborted && !fence?.signal?.aborted) {
      try {
        const rb = await client.query('ROLLBACK');
        if (rb && typeof rb.command === 'string' && rb.command !== 'ROLLBACK') {
          quarantineClient(client);
        }
      } catch {
        quarantineClient(client);
      }
    } else {
      quarantineClient(client);
    }
    throw error;
  }
}
export async function expectedSqlFailure(client: SqlClient, action: () => Promise<unknown>, allowed: readonly string[]): Promise<boolean> {
  await client.query('SAVEPOINT qualification_negative');
  let code: string | undefined;
  try { await action(); } catch (error) { code = (error as { code?: string }).code; }
  await client.query('ROLLBACK TO SAVEPOINT qualification_negative');
  await client.query('RELEASE SAVEPOINT qualification_negative');
  return typeof code === 'string' && allowed.includes(code);
}
