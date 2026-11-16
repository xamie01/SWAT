/** Pure declaration checks only. No imports, dotenv, I/O or infrastructure clients.
 * Declarations are not proof of disposable infrastructure or schema correctness.
 */
export type Package28IsolationEnvironment = Readonly<Record<string, string | undefined>>;

export interface Package28IsolationDeclarations {
  readonly runId: string;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly redisNamespace: string;
}

/** Validates declarations only; returning this value is NOT infrastructure proof. */
export function validatePackage28IsolationDeclarations(env: Package28IsolationEnvironment): Package28IsolationDeclarations {
  if (env.INTEGRATION_DISPOSABLE !== 'true') {
    throw new Error('Integration isolation requires explicit INTEGRATION_DISPOSABLE=true');
  }
  const runId = env.INTEGRATION_RUN_ID;
  if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)) {
    throw new Error('Integration isolation requires a canonical unique UUIDv4 INTEGRATION_RUN_ID');
  }
  // The migration pipeline is unified. "lp" is a legacy alias, not a second schema.
  if (env.SWAT_DB_PROFILE !== 'core') {
    throw new Error('Integration isolation requires explicit canonical SWAT_DB_PROFILE=core');
  }
  const suffix = runId.replaceAll('-', '');
  assertEndpoint(env.INTEGRATION_DATABASE_URL, 'postgresql:', `/swat_integration_${suffix}`, '5432');
  assertEndpoint(env.INTEGRATION_REDIS_URL, 'redis:', '/0', '6379');
  if (env.INTEGRATION_REDIS_NAMESPACE !== `swat:integration:${runId}`) {
    throw new Error('Integration isolation requires a run-specific Redis namespace');
  }
  if (env.DATABASE_URL !== undefined && env.DATABASE_URL !== env.INTEGRATION_DATABASE_URL) {
    throw new Error('Integration isolation refuses conflicting DATABASE_URL');
  }
  if (env.REDIS_URL !== undefined && env.REDIS_URL !== env.INTEGRATION_REDIS_URL) {
    throw new Error('Integration isolation refuses conflicting REDIS_URL');
  }
  return { runId, databaseUrl: env.INTEGRATION_DATABASE_URL!, redisUrl: env.INTEGRATION_REDIS_URL!,
    redisNamespace: env.INTEGRATION_REDIS_NAMESPACE! };
}

export function assertPackage28IsolationPreflight(env: Package28IsolationEnvironment): void {
  validatePackage28IsolationDeclarations(env);
  // Real generator/catalog/ownership seams exist in schema-guard.ts but have NOT
  // been exercised and independently qualified. No path/flag/current catalog
  // can turn a declaration into authorization for imports or destructive tests.
  throw new Error('Integration isolation unavailable: independently generated canonical schema baseline and disposable infrastructure verification are missing; no database imports or operations are permitted');
}

function assertEndpoint(value: string | undefined, protocol: string, path: string, defaultPort: string): void {
  const refusal = () => new Error('Integration isolation requires explicit canonical loopback disposable endpoints with dedicated non-default ports and run-scoped database');
  if (!value || value.trim() !== value) throw refusal();
  let url: URL;
  try { url = new URL(value); } catch { throw refusal(); }
  // Inspect the original authority too: WHATWG normalization accepts 127.1,
  // integer/octal IPs and encoded names; none are canonical declarations.
  const authority = value.split('://')[1]?.split('/')[0]?.split('@').at(-1);
  // URL.pathname removes literal dot segments; validate the declaration too.
  const literalPath = /^[^:]+:\/\/[^/?#]+(\/[^?#]*)/.exec(value)?.[1];
  if (url.protocol !== protocol || authority !== `127.0.0.1:${url.port}`
      || url.hostname !== '127.0.0.1' || !/^[1-9][0-9]{0,4}$/.test(url.port)
      || Number(url.port) > 65535 || url.port === defaultPort
      || literalPath !== path || url.pathname !== path || url.search || url.hash
      || value.includes('%') || value.includes('\\')) throw refusal();
}
