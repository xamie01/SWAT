import { createHash } from 'node:crypto';
import { Deadline } from './containment.js';
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
  try {
    await bounded(deadline, () => ports.inspect(config, deadline));
    deadline.check();
    for (const gate of gates) {
      deadline.check();
      const r = await bounded(deadline, () => ports.execute(gate, config, deadline));
      deadline.check();
      requireCheck(r.gate === gate, 'Gate result substitution refused');
      results.push(structuredClone(r));
      if (!gatePassed(r)) break;
    }
  } catch {
    failure = 'Qualification failed; private operator log required for diagnosis';
  } finally {
    deadline.abort();
    const shutdown = new Deadline(5000);
    try { await bounded(shutdown, () => ports.close(shutdown)); shutdown.check(); cleanupComplete = true; }
    catch { failure = 'Owned client shutdown failed'; }
    finally { shutdown.abort(); shutdown.dispose(); deadline.dispose(); }
  }
  const pendingWork = pending.size;
  const containmentComplete = cleanupComplete && pendingWork === 0;
  if (!containmentComplete && failure === null) failure = 'Owned work did not settle during shutdown';
  return { version: 1, runId: config.candidate.runId, results, unexecuted: gates.filter(g => !results.some(r => r.gate === g)),
    failure, elapsedMs: Date.now() - started, cleanupComplete, pendingWork, containmentComplete,
    observedGatesComplete: containmentComplete && failure === null && results.length === gates.length && results.every(gatePassed),
    runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false };
}

export interface SqlClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[]; command?: string; rowCount?: number | null }>;
}
export async function transaction<T>(client: SqlClient, userId: string | null, action: (client: SqlClient) => Promise<T>): Promise<T> {
  requireCheck(userId === null || /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(userId), 'Canonical synthetic tenant required');
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL app.bypass_rls = 'off'");
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [userId ?? '']);
    const value = await action(client);
    requireCheck((await client.query('COMMIT')).command === 'COMMIT', 'Transaction did not commit');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
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
