import { randomInt, createHash } from 'node:crypto';
import { lstat, readFile, open } from 'node:fs/promises';
import { resolve } from 'node:path';

export const stages = (secondRamp = '2m') => [
  { duration: '3m', target: 2000 },
  { duration: '5m', target: 2000 },
  { duration: secondRamp, target: 9000 },
  { duration: '15m', target: 9000 },
  { duration: '2m', target: 0 }
];

export function sampleIndices(size, count, draw = randomInt) {
  if (!Number.isInteger(size) || !Number.isInteger(count) || count < 1 || count > size) throw new Error('Invalid sample size');
  const indices = Array.from({ length: size }, (_, i) => i);
  for (let i = 0; i < count; i++) {
    const j = draw(i, size);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(0, count);
}

export function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`);
  let text = '';
  while (value > 0n) { text = alphabet[Number(value % 58n)] + text; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = `1${text}`; }
  return text;
}

export function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
export function requireValue(condition, message) { if (!condition) throw new Error(message); }

export async function privateJson(path) {
  const info = await lstat(path);
  requireValue(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid(), 'Private file must be owned by caller and mode 0600');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeNewJson(path, value) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(value)}\n`); } finally { await file.close(); }
}

export function validateConfig(c) {
  requireValue(c.authorization === 'AUTHORIZED_DISPOSABLE_WAVE4_LOAD' && /^[a-z0-9-]{8,48}$/.test(c.runId), 'Explicit disposable-server authorization and unique runId required');
  requireValue(c.seedCount === 100000 && c.sampleCount === 10000, 'This qualification requires 100000 users and 10000 sampled identities');
  requireValue(/^([2-9]|[1-9][0-9])m$/.test(c.secondRamp), 'Second ramp must be a gradual 2–99 minutes');
  const base = new URL(c.baseUrl);
  requireValue(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'API target must be a credential-free origin');
  requireValue(c.allowlist?.apiOrigins?.includes(base.origin), 'API origin not explicitly allowlisted');
  for (const name of ['seedDb', 'monitorDb', 'runtimeDb', 'poolAdmin', 'redis']) {
    const endpoint = c[name];
    const allowed = name === 'redis' ? ['host','port','db','username','password','tls'] : ['host','port','database','user','password','ssl'];
    requireValue(endpoint && Object.keys(endpoint).every(key => allowed.includes(key)) && typeof endpoint.host === 'string' && !endpoint.host.includes('/') && Number.isInteger(endpoint.port) && endpoint.port > 0 && endpoint.port < 65536, `Missing or indirect ${name} endpoint`);
    const tls = endpoint.ssl ?? endpoint.tls;
    requireValue(tls === undefined || tls === false || (typeof tls === 'object' && tls !== null && Object.keys(tls).every(key => ['ca','rejectUnauthorized'].includes(key)) && tls.rejectUnauthorized === true), 'TLS may not disable certificate verification');
    requireValue(c.allowlist?.[name]?.includes(`${endpoint.host}:${endpoint.port}/${endpoint.database ?? endpoint.db ?? ''}`), `${name} endpoint not explicitly allowlisted`);
  }
  requireValue(c.seedDb.database === c.monitorDb.database && c.seedDb.database === c.runtimeDb.database && c.seedDb.database === c.expectedDatabase, 'Database identities disagree');
  requireValue(c.runtimeDb.user === 'swat_app' && c.runtimeDb.port === c.poolAdmin.port && c.runtimeDb.host === c.poolAdmin.host, 'Runtime probe must use swat_app through this PgBouncer');
  requireValue(c.seedDb.user !== c.runtimeDb.user && c.monitorDb.user !== c.runtimeDb.user, 'Seeder and observer must be independent of runtime');
  requireValue(c.redis.db === 0, 'Current application uses Redis DB 0; qualify an isolated Redis instance');
  requireValue(Array.isArray(c.queues) && c.queues.length >= 2 && new Set(c.queues).size === c.queues.length && c.queues.every(q => /^[a-zA-Z0-9_-]{1,100}$/.test(q)), 'Explicit unique queue names required');
  requireValue(c.queues.includes('swat-backfill-wallet') && c.queues.includes('swat-token-discovery'), 'Both workload queues must be monitored');
  requireValue(c.queuePrefix === 'bull', 'Current API queue prefix is bull');
  requireValue(Array.isArray(c.processes) && ['application','worker','postgres','redis','pgbouncer'].every(name => c.processes.some(p => p.name === name)) && new Set(c.processes.map(p => p.name)).size === c.processes.length && c.processes.every(p => Number.isInteger(p.pid) && p.pid > 1 && typeof p.commandIncludes === 'string' && p.commandIncludes.length > 2 && /^[a-zA-Z0-9_-]+$/.test(p.name)), 'Application, fixture worker, PostgreSQL, Redis and PgBouncer PID observations required');
  requireValue(Number.isInteger(c.readPercent) && c.readPercent >= 10 && c.readPercent <= 90, 'Read percentage must be 10–90; remaining requests are writes');
  requireValue(Number.isInteger(c.clockTicksPerSecond) && c.clockTicksPerSecond > 0, 'Record the server getconf CLK_TCK value');
  if (c.remoteWrite) {
    const remote = new URL(c.remoteWrite.url);
    requireValue(['http:', 'https:'].includes(remote.protocol) && !remote.username && !remote.password && !remote.search && !remote.hash && c.allowlist.metricsOrigins?.includes(remote.origin) && c.attestations.authorizedMetricsPublication === true, 'Remote metrics require a credential-free allowlisted URL and separate publication authorization');
  }
  requireValue(Number.isInteger(c.intervalSeconds) && c.intervalSeconds >= 5 && c.intervalSeconds <= 60, 'Collector interval must be 5–60 seconds');
  requireValue(c.minQueueAdmissions >= 1 && Number.isInteger(c.minQueueAdmissions) && c.minQueueAdmissions <= 9000, 'Per-lane minimum queue admissions must be 1–9000');
  requireValue(c.attestations?.isolatedDisposable === true && c.attestations?.egressContainedFixtureWorkers === true && c.attestations?.applicationUsesQualifiedPoolRole === true && c.attestations?.reviewedLimiterCapacity === true && c.attestations?.noLiveCredentialsOrFinancialEffects === true, 'Missing operator deployment attestations');
  requireValue(Array.isArray(c.evidence) && ['deployment', 'egress', 'limiter', 'worker'].every(kind => c.evidence.some(e => e.kind === kind && typeof e.path === 'string' && /^[a-f0-9]{64}$/.test(e.sha256))), 'Hash-bound deployment, egress, limiter and worker evidence required');
  requireValue(!process.env.K6_OUT && !process.env.K6_CLOUD_TOKEN, 'Remote metric publication is not authorized by this harness');
  return c;
}

export async function loadConfig(path) {
  const c = validateConfig(await privateJson(resolve(path)));
  for (const evidence of c.evidence) requireValue(digest(await readFile(evidence.path)) === evidence.sha256, `Deployment evidence mismatch: ${evidence.kind}`);
  return c;
}

export function plan() {
  return { scope: 'Source-only plan; no network, seeding or acceptance', seededUsers: 100000, sampledIdentities: 10000, peakVus: 9000, reserveIdentities: 1000, stages: stages(), readPercent: 80, writePercent: 20, queueRequestsPerIdentityPerLane: 1, thinkTimeSeconds: [1, 3], runtimeAccepted: false };
}
