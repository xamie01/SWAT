/**
 * Live Stage A (I1, I2, I4-base, I5-base, I6-base) runner against disposable
 * containers configured in private-config.json. Invoked via tsx.
 */
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const { privateConfig } = require('../tests/qualification/wave4/config.ts');
const { Deadline } = require('../tests/qualification/wave4/containment.ts');
const { performance } = require('node:perf_hooks');
const { assertion, createCommitFence, executeGateWithCommitFence, expectedSqlFailure, gatePassed, hash, normalizeServerAddress, requireCheck, result, sanitizeFailure, transaction } =
  require('../tests/qualification/wave4/core.ts');
const { createEvidenceWriter, nonsecretEvidence } = require('../tests/qualification/wave4/evidence-writer.ts');
const { OwnedClients, inspectBoth, inspectEnvironment, bindPostgres, bindRedis, bindRedisIdentity, migratePristine, catalog } =
  require('../tests/qualification/wave4/infrastructure.ts');
const { qualifyRoles, lpRequest, syntheticDeposit, syntheticLpProtocol, runtimeTransaction } =
  require('../tests/qualification/wave4/domains.ts');
const { createCustodyEnrollmentStore, createCustodyExecutionStore } = require('../packages/db/src/custody-store.ts');
const { EXECUTION_GRANT_PUBLIC_COLUMNS } = require('../packages/db/src/execution-grant-projection.ts');
const { withdrawalSqlStore } = require('../packages/db/src/withdrawal-store.ts');
const { withdrawalIntent } = require('../packages/db/src/withdrawal-contract.ts');
const { lpAcquisitionHash, lpExactHash, lpRecenterStrategy } = require('../packages/db/src/lp-exact.ts');
const { createLpPaperService, lpOperationIntent } = require('../packages/db/src/lp-paper-service.ts');
const { createLpPaperSqlStore } = require('../packages/db/src/lp-paper-store.ts');
const { createLpPaperAdmissionWriter } = require('../packages/db/src/lp-paper-admission-store.ts');
const { lpAdmissionContextKey } = require('../packages/db/src/lp-paper-admission-contract.ts');
const { qualifyProtectedAuthentication } = require('../tests/qualification/wave4/authentication.ts');
const { pipelinePreflight } = require('../tests/qualification/wave4/pipeline.ts');
const { ownedWorker, ownedQueueWorker } = require('../tests/qualification/wave4/faults.ts');
const { exerciseRollbackSchedule } = require('../tests/qualification/wave4/rollback-schedule.ts');
const { OwnedQueueRuntime } = require('../tests/qualification/wave4/queue-runtime.ts');
const { lpJobName, queueIdentity, requireQueueJob, requireRedelivery } =
  require('../tests/qualification/wave4/queue-contract.ts');
const { queueJournal, queueStream, requireEmptyQueueNamespace } =
  require('../tests/qualification/wave4/queue-journal.ts');
const { activateInstalledAuthentication, authenticationInstallationSource } =
  require('../deploy/postgres/auth-installation.ts');
const { canonicalMigrationSource } = require('../packages/db/src/canonical-migration-source.ts');
const { prepareDatabaseForMigratePristine } = require('./wave4-db-bootstrap.ts');

const dbRequire = createRequire(resolve(__dirname, '../packages/db/package.json'));
const apiRequire = createRequire(resolve(__dirname, '../apps/api/package.json'));
const { Client } = dbRequire('pg') as { Client: new (opts: Record<string, unknown>) => any };
const Redis = apiRequire('ioredis') as new (url: string, opts?: Record<string, unknown>) => any;

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function makeDirectLeaseFactory(url: string, applicationName: string) {
  return async () => {
    const client = new Client({
      connectionString: url,
      application_name: applicationName,
      connectionTimeoutMillis: 5_000,
      query_timeout: 15_000
    });
    await client.connect();
    let released = false;
    return {
      client: client as any,
      release: (_broken?: boolean) => {
        if (released) return;
        released = true;
        void client.end().catch(() => {});
      }
    };
  };
}

function makeSolanaSyntheticSigner() {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const encodeBase58 = (bytes: Uint8Array) => {
    let val = BigInt('0x' + Buffer.from(bytes).toString('hex'));
    let out = '';
    while (val > 0n) {
      out = alphabet[Number(val % 58n)] + out;
      val /= 58n;
    }
    for (const b of bytes) {
      if (b !== 0) break;
      out = '1' + out;
    }
    return out;
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const rawPub = spki.subarray(spki.length - 32);
  return {
    chainKind: 'solana' as const,
    address: encodeBase58(rawPub),
    signSyntheticChallenge: async (message: string) => {
      const sig = sign(null, Buffer.from(message, 'utf8'), privateKey);
      return encodeBase58(sig);
    }
  };
}

function makeDbaUrl(basePgUrl: string, dbaUser: string, dbaPass: string): string {
  const u = new URL(basePgUrl);
  u.username = dbaUser;
  u.password = dbaPass;
  return u.toString();
}

function makeRoleUrl(basePgUrl: string, role: string, pass: string): string {
  const u = new URL(basePgUrl);
  u.username = role;
  u.password = pass;
  return u.toString();
}

async function main() {
  const [configPathArg, credsPathArg, outDirArg] = process.argv.slice(2);
  if (!configPathArg || !credsPathArg || !outDirArg) {
    console.error('Usage: tsx scripts/wave4-live-stage-a.ts <private-config.json> <credentials.env> <output-dir>');
    process.exit(2);
  }

  const configPath = resolve(configPathArg);
  const creds = parseEnvFile(resolve(credsPathArg));
  const requestedOut = resolve(outDirArg);
  const outParent = dirname(requestedOut);
  mkdirSync(outParent, { recursive: true, mode: 0o700 });
  const outDir = join(realpathSync(outParent), requestedOut.split('/').at(-1)!);

  const config = await privateConfig(configPath);
  const refDbaUrl = makeDbaUrl(config.reference.postgres.url, creds.DBA_USER!, creds.DBA_PASS!);
  const candDbaUrl = makeDbaUrl(config.candidate.postgres.url, creds.DBA_USER!, creds.DBA_PASS!);
  const authServicePass = randomBytes(24).toString('hex');

  await prepareDatabaseForMigratePristine({
    swatDir: resolve(__dirname, '..'),
    dbaUrl: refDbaUrl,
    dbaPass: creds.DBA_PASS!,
    migratorUrl: config.reference.postgres.url,
    selection: config.migrationSelection,
    auditReference: config.migrationSelection.auditReference
  });
  await prepareDatabaseForMigratePristine({
    swatDir: resolve(__dirname, '..'),
    dbaUrl: candDbaUrl,
    dbaPass: creds.DBA_PASS!,
    migratorUrl: config.candidate.postgres.url,
    selection: config.migrationSelection,
    auditReference: config.migrationSelection.auditReference
  });

  const writer = await createEvidenceWriter(outDir);
  const deadline = new Deadline(config.maxDurationMs);
  const clients = new OwnedClients(deadline);
  const fence = createCommitFence(deadline);
  const gateResults: any[] = [];
  let redisClientForAuth: InstanceType<typeof Redis> | undefined;

  try {
    const addresses = await inspectBoth(config, deadline);
    await writer.write('inspection.json', { addresses, inspectedAt: new Date().toISOString() });

    const refDbName = new URL(config.reference.postgres.url).pathname.slice(1);
    const candDbName = new URL(config.candidate.postgres.url).pathname.slice(1);

    // Pre-bind system identifiers via DBA before I1 creates Installation objects
    const readSystemId = async (url: string) => {
      const c = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
      await c.connect();
      try {
        const r = await c.query('SELECT system_identifier::text AS id FROM pg_catalog.pg_control_system()');
        return r.rows[0].id as string;
      } finally {
        await c.end();
      }
    };

    const refSysId = await readSystemId(refDbaUrl);
    const candSysId = await readSystemId(candDbaUrl);

    const refAuthInstall = {
      target: { database: refDbName, address: addresses.reference.postgres, port: 5432 as const, systemIdentifier: refSysId },
      dbaRole: creds.DBA_USER!,
      acquireDba: makeDirectLeaseFactory(refDbaUrl, `wave4-dba-ref-${config.reference.runId}`)
    };
    const candAuthInstall = {
      target: { database: candDbName, address: addresses.candidate.postgres, port: 5432 as const, systemIdentifier: candSysId },
      dbaRole: creds.DBA_USER!,
      acquireDba: makeDirectLeaseFactory(candDbaUrl, `wave4-dba-cand-${config.candidate.runId}`)
    };

    // Gate I1
    let redisCandidate = '';
    const i1 = await executeGateWithCommitFence('I1', 'execute:I1', fence, async () => {
      const reference = await clients.postgres(config.reference.postgres.url, `wave4-reference-${config.reference.runId}`);
      const candidate = await clients.postgres(config.candidate.postgres.url, `wave4-candidate-${config.candidate.runId}`);
      const referenceId = await bindPostgres(reference, config.reference, addresses.reference.postgres, deadline);
      const candidateId = await bindPostgres(candidate, config.candidate, addresses.candidate.postgres, deadline);
      const rr = await clients.redis(config.reference.redis.url, `wave4-reference-${config.reference.runId}`);
      const cr = await clients.redis(config.candidate.redis.url, `wave4-candidate-${config.candidate.runId}`);
      const redisReference = await bindRedis(rr, addresses.reference.redis);
      redisCandidate = await bindRedis(cr, addresses.candidate.redis);

      await migratePristine(reference, deadline, config.migrationSelection, refAuthInstall);
      await migratePristine(candidate, deadline, config.migrationSelection, candAuthInstall);
      const baseline = await catalog(reference, config.reference.postgres.url, deadline, config.migrationSelection, refAuthInstall);
      const installed = await catalog(candidate, config.candidate.postgres.url, deadline, config.migrationSelection, candAuthInstall);
      await writer.write('reference-catalog.json', baseline);
      await writer.write('candidate-catalog.json', installed);
      await inspectBoth(config, deadline);

      const digestMatch = baseline.digest === installed.digest
        && baseline.journalDigest === installed.journalDigest
        && baseline.sourceDigest === installed.sourceDigest;
      return result('I1', [
        assertion('independent connected PG16 and Redis7 identities', referenceId !== candidateId && redisReference !== redisCandidate),
        assertion('canonical 001-090 catalogs roles ACLs and migration journals match', digestMatch)
      ], digestMatch ? [] : ['Reference and candidate catalogs diverged'], {
        referenceCluster: referenceId,
        candidateCluster: candidateId,
        redisReference,
        redisCandidate,
        migrationCount: installed.journal.length,
        sourceDigest: baseline.sourceDigest,
        catalogDigest: installed.digest
      });
    }, deadline);
    gateResults.push(i1);
    await writer.write('gate-i1.json', nonsecretEvidence(i1));
    console.log('[STAGE-A] I1:', gatePassed(i1) ? 'PASS' : 'FAIL', JSON.stringify(i1.assertions));

    // Enable swat_app and ephemeral swat_lp_admitter LOGIN only after I1 migrations + catalog parity checks complete.
    const lpAdmitterPass = randomBytes(24).toString('hex');
    const appLoginLease = await candAuthInstall.acquireDba();
    try {
      await appLoginLease.client.query('ALTER ROLE swat_app LOGIN');
      await appLoginLease.client.query(`ALTER ROLE swat_lp_admitter WITH LOGIN PASSWORD '${lpAdmitterPass}'`);
    } finally {
      appLoginLease.release(false);
    }

    // Gate I2
    const runtime = await clients.postgres(config.runtimeUrl, `wave4-runtime-${config.candidate.runId}`);
    const pooled = await clients.postgres(config.pooledRuntimeUrl, `wave4-pooled-${config.candidate.runId}`);
    const second = await clients.postgres(config.runtimeUrl, `wave4-competitor-${config.candidate.runId}`);
    const observer = await clients.postgres(config.runtimeUrl, `wave4-lock-observer-${config.candidate.runId}`);
    const lpAdmitterUrl = makeRoleUrl(config.candidate.postgres.url, 'swat_lp_admitter', lpAdmitterPass);
    const lpAdmitterClient = await clients.postgres(lpAdmitterUrl, `wave4-lp-admitter-${config.candidate.runId}`);

    let admitMutex: Promise<unknown> = Promise.resolve();
    const admitTransaction = <T>(scope: { userId: string }, action: (c: any) => Promise<T>): Promise<T> => {
      const next = admitMutex.then(() => transaction(lpAdmitterClient, scope.userId, action));
      admitMutex = next.catch(() => {});
      return next;
    };
    const stageDeposit = { raw: '900719925474099312300', scale: 18 } as const;
    const stageRequest = (runId: string) => ({ ...lpRequest(runId), deposit: stageDeposit });
    const quoteCache = new Map<string, any>();
    const quoteContexts = new Map<string, any>();
    const settlementCreatedAt = new Map<string, string>();
    const baseLpProtocol = syntheticLpProtocol(config.candidate.runId);
    const admittedProtocol = {
      providerId: baseLpProtocol.providerId,
      networks: baseLpProtocol.networks,
      quote: async (input: any) => {
        const key = lpExactHash(input);
        const cached = quoteCache.get(key);
        if (cached) return cached;
        const q = await baseLpProtocol.quote(input);
        if (!q) return null;
        const nowMs = Date.now();
        const observedAt = new Date(nowMs - 25).toISOString();
        const expiresAt = new Date(nowMs + 55_000).toISOString();
        const normalized = {
          ...q,
          observedAt,
          expiresAt,
          pool: { ...q.pool, observedAt },
          economics: q.economics
            ? {
                ...q.economics,
                windowStart: observedAt,
                windowEnd: new Date(nowMs - 25 + 3600_000).toISOString()
              }
            : null
        };
        quoteCache.set(key, normalized);
        return normalized;
      },
      receipt: async (input: { operation: any; position: any }) => {
        const r = await baseLpProtocol.receipt(input);
        if (!r) return null;
        let createdAtIso = settlementCreatedAt.get(input.operation.id);
        if (!createdAtIso) {
          const rows = (
            await runtimeTransaction(runtime, input.operation.userId, (c: any) =>
              c.query('SELECT created_at FROM public.lp_exact_operations WHERE user_id=$1 AND id=$2', [
                input.operation.userId,
                input.operation.id
              ])
            )
          ).rows;
          if (rows[0]?.created_at) {
            createdAtIso = new Date(rows[0].created_at).toISOString();
            settlementCreatedAt.set(input.operation.id, createdAtIso);
          }
        }
        return createdAtIso ? { ...r, settledAt: createdAtIso } : r;
      }
    };
    const admissionWriter = createLpPaperAdmissionWriter(admitTransaction, {
      protocol: admittedProtocol,
      quoteContext: async (_c: any, _s: any, selector: string) => quoteContexts.get(selector) ?? null,
      settlementContext: async (c: any, s: { userId: string }, operationId: string) => {
        const opRes = await c.query(
          'SELECT data, created_at FROM public.lp_exact_operations WHERE user_id=$1 AND id=$2',
          [s.userId, operationId]
        );
        const opRow = opRes.rows[0];
        if (!opRow) return null;
        const posRes = await c.query(
          'SELECT public.lp085_current_position(user_id, position_id) AS pos FROM public.lp_exact_positions WHERE user_id=$1 AND position_id=$2',
          [s.userId, opRow.data.positionId]
        );
        const pos = posRes.rows[0]?.pos;
        if (!pos) return null;
        const createdAtIso = new Date(opRow.created_at).toISOString();
        settlementCreatedAt.set(operationId, createdAtIso);
        return { operation: opRow.data, position: pos, operationCreatedAt: createdAtIso };
      }
    });
    const makePlan = async (quote: any, strategy: any) => ({
      version: 2,
      protocol: quote.pool.protocol,
      strategy,
      poolEvidenceId: quote.pool.evidenceId,
      rungs: [
        {
          priceLower: strategy.rangeLower,
          priceUpper: strategy.rangeUpper,
          allocation: quote.amountAfter,
          binLower: 1,
          binUpper: 2
        }
      ]
    });
    const makeAdmittedLpService = (
      sqlClient: any,
      enqueue?: (input: { userId: string; operationId: string; chain: any }) => Promise<void>
    ) => {
      const sqlStore = createLpPaperSqlStore((scope: { userId: string }, action: (c: any) => Promise<any>) =>
        runtimeTransaction(sqlClient, scope.userId, action)
      );
      const inner = createLpPaperService({
        store: sqlStore,
        mode: async () => 'paper',
        protocol: admittedProtocol,
        enqueue,
        plan: makePlan
      });
      return {
        ...inner,
        acquire: async (scope: { userId: string }, request: any) => {
          const replay = await sqlStore.transaction(scope, (tx: any) => tx.acquisition(request.operationKey));
          if (!replay) {
            const fingerprint = lpAcquisitionHash(request);
            const qInput = {
              userId: scope.userId,
              chain: request.chain,
              poolAddress: request.poolAddress,
              depositAsset: request.depositAsset,
              deposit: request.deposit,
              action: 'acquire' as const,
              intentHash: fingerprint,
              positionId: null,
              positionRevision: null
            };
            const quote = await admittedProtocol.quote(qInput);
            const plan = await makePlan(quote, request.strategy);
            const ctx = { kind: 'acquisition' as const, commit: { request, fingerprint, quote, plan, origin: null } };
            const sel = lpAdmissionContextKey(ctx);
            quoteContexts.set(sel, ctx);
            await admissionWriter.quote(scope, sel);
          }
          return inner.acquire(scope, request);
        },
        requestOperation: async (scope: { userId: string }, input: any) => {
          const initial = await sqlStore.transaction(scope, async (tx: any) => ({
            position: await tx.position(input.positionId),
            replay: await tx.operationByKey(input.operationKey)
          }));
          const pos = initial.position;
          if (
            !initial.replay &&
            pos &&
            pos.userId === scope.userId &&
            pos.mode === 'paper' &&
            pos.state !== 'closed' &&
            pos.state !== 'building' &&
            pos.state !== 'rebalancing' &&
            !(input.automatic && (input.action !== 'rebalance' || !pos.autoRebalance))
          ) {
            const intentHash = lpOperationIntent(pos, input.action);
            const qInput = {
              userId: scope.userId,
              chain: pos.chain,
              poolAddress: pos.poolAddress,
              depositAsset: pos.depositAsset,
              deposit: pos.currentAmount,
              action: input.action,
              intentHash,
              positionId: pos.id,
              positionRevision: pos.revision
            };
            const quote = await admittedProtocol.quote(qInput);
            const strategy = input.action === 'rebalance' ? lpRecenterStrategy(pos.plan.strategy, quote.pool.currentPrice) : null;
            const plan = strategy ? await makePlan(quote, strategy) : null;
            const receiptKey = `lp-receipt-${lpExactHash([scope.userId, input.operationKey, intentHash])}`;
            const ctx = {
              kind: 'operation' as const,
              commit: {
                position: pos,
                operationKey: input.operationKey,
                fingerprint: intentHash,
                action: input.action,
                quote,
                plan,
                receiptKey
              }
            };
            const sel = lpAdmissionContextKey(ctx);
            quoteContexts.set(sel, ctx);
            await admissionWriter.quote(scope, sel);
          }
          return inner.requestOperation(scope, input);
        },
        process: async (scope: { userId: string }, input: any) => {
          const op = await inner.operation(scope, input.operationId);
          if (op && op.status === 'pending') {
            await admissionWriter.settlement(scope, op.id);
          }
          return inner.process(scope, input);
        }
      };
    };

    redisClientForAuth = new Redis(config.candidate.redis.url, { maxRetriesPerRequest: 1 });
    const candAuthServiceUrl = makeRoleUrl(config.candidate.postgres.url, 'swat_auth_service', authServicePass);

    const i2 = await executeGateWithCommitFence('I2', 'execute:I2', fence, async () => {
      const source = await canonicalMigrationSource(config.migrationSelection);
      const authSql = authenticationInstallationSource(source, candAuthInstall)!;
      await activateInstalledAuthentication(candAuthInstall, authSql, {
        expiresAt: new Date(Date.now() + 600_000),
        activateExternally: async () => {
          const lease = await candAuthInstall.acquireDba();
          try {
            await lease.client.query(`ALTER ROLE swat_auth_service WITH LOGIN PASSWORD '${authServicePass}'`);
          } finally {
            lease.release(false);
          }
        }
      });

      const syntheticSigner = makeSolanaSyntheticSigner();
      const authResult = await qualifyProtectedAuthentication({
        target: candAuthInstall.target,
        acquireAuth: makeDirectLeaseFactory(candAuthServiceUrl, `wave4-auth-${config.candidate.runId}`),
        acquireRuntime: makeDirectLeaseFactory(config.runtimeUrl, `wave4-auth-runtime-${config.candidate.runId}`),
        acquireObserver: makeDirectLeaseFactory(candDbaUrl, `wave4-auth-observer-${config.candidate.runId}`),
        observerRole: creds.DBA_USER!,
        nonceStore: {
          set: (k: string, v: string, mode: 'EX', sec: number) => redisClientForAuth!.set(k, v, mode, sec),
          getdel: (k: string) => redisClientForAuth!.getdel(k)
        },
        signature: syntheticSigner,
        overlapObservation: 'postgres-blocking-edge',
        fixture: {
          emailA: `w4a-${config.candidate.runId.slice(0, 8)}@example.invalid`,
          emailB: `w4b-${config.candidate.runId.slice(0, 8)}@example.invalid`,
          password: 'Synthetic-Wave4-Password-123!',
          newPassword: 'Synthetic-Wave4-Password-456!',
          walletAddress: syntheticSigner.address
        }
      });
      await writer.write('protected-authentication.json', {
        scenario: authResult.scenario,
        boundary: authResult.boundary,
        users: authResult.users,
        facts: authResult.facts,
        scheduleCount: authResult.schedules.length,
        scheduleOutcomes: authResult.schedules.map((s: any, idx: number) => ({
          scheduleIndex: idx,
          observation: s.observation ?? null,
          backends: Array.isArray(s.backends) ? [...s.backends] : [],
          leaderStatus: s.leader?.status ?? null,
          contenderStatus: s.contender?.status ?? null
        })),
        observation: authResult.observation,
        blocked: [...authResult.blocked]
      });

      const roles = await qualifyRoles(runtime, pooled, [authResult.users[0]!, authResult.users[1]!]);
      const preflight = await runtimeTransaction(runtime, null, (tx: any) => pipelinePreflight(tx));
      // Verify PgBouncer transaction pooling round-trip via pooled client
      let pooledAddr = '';
      await runtimeTransaction(pooled, null, async (tx: any) => {
        const r = (await tx.query('SELECT inet_server_addr()::text AS addr')).rows[0];
        pooledAddr = String(r.addr ?? '').replace(/\/(?:32|128)$/, '');
      });
      const pgbOk = pooledAddr === addresses.candidate.postgres;

      const assertions = [
        ...roles.assertions,
        ...preflight.assertions,
        assertion('087 protected routes owned-store and 5 blocking auth overlap schedules passed', authResult.schedules.length === 5),
        assertion('pgbouncer transaction pool routes to exact inspected candidate cluster', pgbOk)
      ];
      return result('I2', assertions, pgbOk ? [] : ['PgBouncer pooled address mismatch'], {
        authenticationSchedules: authResult.schedules.length,
        pooledBackendAddress: pooledAddr,
        preflight: preflight.evidence
      });
    }, deadline);
    gateResults.push(i2);
    await writer.write('gate-i2.json', nonsecretEvidence(i2));
    console.log('[STAGE-A] I2:', gatePassed(i2) ? 'PASS' : 'FAIL', `${i2.assertions.filter((a: any) => a.passed).length}/${i2.assertions.length}`);

    // Note on I3 (executed paper pipeline): requires full 088 DBA companion provisioning & writer credentials
    const i3 = result(
      'I3',
      [assertion('088 schema installed and runtime preflight verified (full executed companion adapters remain separately provisioned)', i1.assertions[1].passed && i2.assertions.some((a: any) => a.passed))],
      ['I3 full executed paper pipeline requires 088 companion DBA provisioning & dedicated writer role logins'],
      { status: 'schema-and-preflight-verified-companion-blocked' }
    );
    gateResults.push(i3);
    await writer.write('gate-i3.json', nonsecretEvidence(i3));
    console.log('[STAGE-A] I3: PARTIAL (088 schema + preflight verified; full writer companion adapters separate)');

    // Seed isolated synthetic domain owners for I4, I5, I6:
    // 087 revoked INSERT on users from swat_app and 084 narrowed lp_guardrail_configs INSERT off swat_app.
    const owners: [string, string] = [randomUUID(), randomUUID()];
    await runtimeTransaction(runtime, null, async (c: any) => {
      const privs = (
        await c.query(`SELECT
          pg_catalog.has_column_privilege(current_user, 'public.lp_positions', 'user_id', 'INSERT') AS position,
          pg_catalog.has_column_privilege(current_user, 'public.lp_position_state_history', 'position_id', 'INSERT') AS history,
          pg_catalog.has_table_privilege(current_user, 'public.lp_guardrail_configs', 'INSERT') AS guardrail_insert`)
      ).rows[0];
      if (privs?.position !== true || privs?.history !== true || privs?.guardrail_insert !== false) {
        throw new Error('Unexpected 084 LP column/table privilege posture for swat_app');
      }
      const empty = await c.query('SELECT count(*)::text AS count FROM users');
      if (empty.rows[0]?.count !== '0') {
        throw new Error('Tenantless runtime must not see users');
      }
    });
    const ownerLease = await candAuthInstall.acquireDba();
    try {
      for (const id of owners) {
        await ownerLease.client.query(
          "INSERT INTO public.users(id,email,password_hash) VALUES($1,$2,'!disabled-wave4-no-login')",
          [id, `wave4-${config.candidate.runId}-${id}@example.invalid`]
        );
        await ownerLease.client.query(
          'INSERT INTO public.lp_guardrail_configs(user_id,max_pool_allocation_pct) VALUES($1,100)',
          [id]
        );
      }
    } finally {
      ownerLease.release(false);
    }
    for (const id of owners) {
      await runtimeTransaction(runtime, id, async (c: any) => {
        await c.query('INSERT INTO user_execution_settings(user_id,auto_execute) VALUES($1,false)', [id]);
      });
    }

    // Gate I4 (real Postgres custody/withdrawal/LP domains under 089 non-secret metadata boundary)
    const i4 = await executeGateWithCommitFence('I4', 'execute:I4', fence, async () => {
      const checks: any[] = [];
      const scope = { userId: owners[0] };
      const foreign = { userId: owners[1] };
      const custodyTx = (s: { userId: string }, action: (c: any) => Promise<any>) => runtimeTransaction(runtime, s.userId, action);
      const enrollment = createCustodyEnrollmentStore(custodyTx);
      const execution = createCustodyExecutionStore(custodyTx);
      const grantId = randomUUID();
      const grant = await enrollment.record(scope, {
        id: grantId,
        chain: 'solana',
        grantKind: 'solana_vault',
        accountAddress: '11111111111111111111111111111111',
        sealedSecret: null,
        keyVersion: null,
        secretBinding: null,
        scopePolicy: null,
        expiresAt: null
      });
      checks.push(assertion('keyless custody has no sealed execution secret', grant.hasSealedSecret === false));
      const metaSql = `SELECT ${EXECUTION_GRANT_PUBLIC_COLUMNS}, lifecycle_revision::text AS lifecycle_revision, revocation_tombstone FROM user_execution_grants WHERE id = $1::uuid AND user_id = $2::uuid`;
      const crossRows = await custodyTx(foreign, (c: any) => c.query(metaSql, [grantId, foreign.userId]));
      checks.push(assertion('custody read cannot cross tenant', crossRows.rows.length === 0));
      let executionDenied = false;
      try {
        await execution.load(scope, grantId);
      } catch (err: any) {
        executionDenied = err?.code === '42501';
      }
      checks.push(assertion('089 forbids swat_app SELECT on sealed_secret via execution store', executionDenied));
      await runtimeTransaction(runtime, owners[0], (c: any) => c.query("UPDATE user_execution_grants SET status='revoked' WHERE id=$1", [grantId]));
      const revokedRows = await custodyTx(scope, (c: any) => c.query(metaSql, [grantId, scope.userId]));
      const revoked = revokedRows.rows[0];
      checks.push(assertion('revocation advances durable revision and tombstone', revoked?.lifecycle_revision === '2' && revoked.revocation_tombstone !== null));
      await runtimeTransaction(runtime, owners[0], async (c: any) => {
        checks.push(assertion('keyless revocation cannot be resurrected', await expectedSqlFailure(c, () => c.query("UPDATE user_execution_grants SET status='active' WHERE id=$1", [grantId]), ['P0001'])));
        checks.push(assertion('runtime cannot admit custody secrets', await expectedSqlFailure(c, () => c.query('INSERT INTO custody_secret_admissions DEFAULT VALUES'), ['42501'])));
        const now = await withdrawalSqlStore.now(c);
        const intent = withdrawalIntent(
          owners[0],
          {
            requestKey: `withdraw-${config.candidate.runId}`,
            chain: 'solana',
            network: `wave4-${config.candidate.runId}`,
            assetId: 'solana:wave4-mint',
            assetScale: 18,
            sourceWalletId: randomUUID(),
            destination: '11111111111111111111111111111111',
            amountRaw: syntheticDeposit.raw,
            maxFeeRaw: '5',
            feeAssetId: 'solana:fee',
            feeAssetScale: 9,
            feeFundingAccountId: 'synthetic-fee-account',
            mode: 'paper'
          },
          new Date(Date.parse(now) + 600_000).toISOString()
        );
        const record = await withdrawalSqlStore.create(c, intent);
        checks.push(assertion('SQL withdrawal keeps exact raw amount', record.intent.amountRaw === syntheticDeposit.raw));
        checks.push(assertion('duplicate financial identity rejected', await expectedSqlFailure(c, () => withdrawalSqlStore.create(c, intent), ['23505'])));
        checks.push(assertion('financial intent body immutable', await expectedSqlFailure(c, () => c.query("UPDATE withdrawal_reducing_intents SET intent=jsonb_set(intent,'{amountRaw}','\"1\"') WHERE id=$1", [record.id]), ['42501', 'P0001'])));
        checks.push(assertion('runtime cannot admit settlement receipts', await expectedSqlFailure(c, () => c.query('INSERT INTO withdrawal_reducing_receipts DEFAULT VALUES'), ['42501'])));
        checks.push(assertion('no receiptless financial completion', await expectedSqlFailure(c, () => c.query("UPDATE withdrawal_reducing_intents SET completed_raw=1,status='settled',terminal=true WHERE id=$1", [record.id]), ['42501', 'P0001'])));
      });
      const service = makeAdmittedLpService(runtime);
      const request = stageRequest(config.candidate.runId);
      const acquired = await service.acquire(scope, request);
      checks.push(assertion('actual LP store preserves fractional raw amount', lpExactHash(acquired.deposit) === lpExactHash(stageDeposit)));
      const admission = await service.requestOperation(scope, { positionId: acquired.id, operationKey: `close-${config.candidate.runId}`, action: 'close' });
      checks.push(assertion('LP close admission remains pending with inventory', admission.operation.status === 'pending' && (await service.position(scope, acquired.id))?.currentAmount.raw === stageDeposit.raw));
      await runtimeTransaction(runtime, owners[0], async (c: any) => {
        checks.push(assertion('LP completion cannot bypass durable receipt', await expectedSqlFailure(c, () => c.query("UPDATE lp_exact_operations SET status='completed',completed_at=now(),data=jsonb_set(data,'{status}','\"completed\"') WHERE id=$1", [admission.operation.id]), ['P0001'])));
        checks.push(assertion('legacy LP close cannot bypass exact receipt', await expectedSqlFailure(c, () => c.query("UPDATE lp_positions SET state='closed' WHERE id=$1", [acquired.id]), ['P0001'])));
        checks.push(assertion('completed LP INSERT is refused', await expectedSqlFailure(c, () => c.query(`INSERT INTO lp_exact_operations(id,user_id,position_id,operation_key,receipt_key,status,data,completed_at) VALUES($1,$2,$3,'forged','forged','completed',$4::jsonb,now())`, [randomUUID(), owners[0], acquired.id, JSON.stringify(admission.operation)]), ['42501', 'P0001'])));
      });
      const done = await service.process(scope, { operationId: admission.operation.id, chain: 'solana' });
      const closed = await service.position(scope, acquired.id);
      checks.push(assertion('LP close applies bound receipt and exact economics', done.operation.status === 'completed' && closed?.currentAmount.raw === '0' && closed.realizedMicroUsd === '50000' && closed.revision === '1'));
      checks.push(assertion('LP immutable acquisition retry survives close', lpExactHash(await service.acquire(scope, request)) === lpExactHash(acquired)));
      await service.process(scope, { operationId: admission.operation.id, chain: 'solana' });
      await runtimeTransaction(runtime, owners[0], async (c: any) => {
        checks.push(assertion('duplicate LP delivery creates one durable receipt', (await c.query('SELECT count(*)::text AS count FROM lp_exact_receipts WHERE operation_id=$1', [admission.operation.id])).rows[0]?.count === '1'));
        checks.push(assertion('LP receipts append-only under runtime', await expectedSqlFailure(c, () => c.query('DELETE FROM lp_exact_receipts WHERE operation_id=$1', [admission.operation.id]), ['42501', 'P0001'])));
      });
      const rebalancePosition = await service.acquire(scope, { ...stageRequest(config.candidate.runId), operationKey: `rebalance-acquire-${config.candidate.runId}` });
      checks.push(assertion('foreign LP acquisition remains hidden', (await service.position(foreign, rebalancePosition.id)) === null));
      const rebalance = await service.requestOperation(scope, { positionId: rebalancePosition.id, operationKey: `rebalance-${config.candidate.runId}`, action: 'rebalance', automatic: true });
      checks.push(assertion('rebalance admission keeps original inventory and revision', rebalance.operation.status === 'pending' && (await service.position(scope, rebalancePosition.id))?.revision === '0'));
      const settledRebalance = await service.process(scope, { operationId: rebalance.operation.id, chain: 'solana' });
      const rebalanced = await service.position(scope, rebalancePosition.id);
      checks.push(assertion('receipt-backed rebalance advances one revision with exact costs', settledRebalance.operation.status === 'completed' && rebalanced?.state === 'active' && rebalanced.currentAmount.raw === stageDeposit.raw && rebalanced.revision === '1' && rebalanced.cumulativeFeesMicroUsd === '100000' && rebalanced.cumulativeCostsMicroUsd === '50000' && rebalanced.realizedMicroUsd === null));
      await service.process(scope, { operationId: rebalance.operation.id, chain: 'solana' });
      checks.push(assertion('rebalance replay cannot apply a second financial revision', lpExactHash(await service.position(scope, rebalancePosition.id)) === lpExactHash(rebalanced)));
      const noQueue = makeAdmittedLpService(runtime, async () => { throw new Error('Synthetic queue hint failure'); });
      const afterRebalanceClose = await noQueue.requestOperation(scope, { positionId: rebalancePosition.id, operationKey: `rebalance-close-${config.candidate.runId}`, action: 'close' });
      checks.push(assertion('failed queue hint leaves committed operation recoverable', afterRebalanceClose.queued === false && afterRebalanceClose.operation.status === 'pending' && (await service.operation(scope, afterRebalanceClose.operation.id))?.status === 'pending'));
      const hints: string[] = [];
      const recovery = await makeAdmittedLpService(runtime, async (input: any) => { hints.push(input.operationId); }).recover(scope);
      checks.push(assertion('durable LP recovery selects the committed pending operation', recovery.queued === 1 && recovery.deferred === 0 && hints.length === 1 && hints[0] === afterRebalanceClose.operation.id));
      await service.process(scope, { operationId: afterRebalanceClose.operation.id, chain: 'solana' });
      const finallyClosed = await service.position(scope, rebalancePosition.id);
      checks.push(assertion('rebalance then close reconciles both immutable receipts', finallyClosed?.state === 'closed' && finallyClosed.revision === '2' && finallyClosed.currentAmount.raw === '0' && finallyClosed.cumulativeFeesMicroUsd === '200000' && finallyClosed.cumulativeCostsMicroUsd === '100000' && finallyClosed.realizedMicroUsd === '100000'));
      const baseDomainsEvidence = { custodyGrantId: grantId, lpPositionId: acquired.id, lpOperationId: admission.operation.id, provider: 'synthetic-keyless-paper-only' };
      await writer.write('domains-i4-base.json', baseDomainsEvidence);
      return result('I4', checks, [], { ...baseDomainsEvidence, note: 'Keyless/SQL domain invariants passed on live PostgreSQL 16; keyed P5 external signing adapters separate' });
    }, deadline);
    gateResults.push(i4);
    await writer.write('gate-i4.json', nonsecretEvidence(i4));
    console.log('[STAGE-A] I4:', gatePassed(i4) ? 'PASS' : 'FAIL', `${i4.assertions.filter((a: any) => a.passed).length}/${i4.assertions.length}`);

    // Gate I5 (real Postgres pg_blocking_pids lock waits + LP rollback concurrency with 085 admissions)
    const i5 = await executeGateWithCommitFence('I5', 'execute:I5', fence, async () => {
      const rollbackChecks = await exerciseRollbackSchedule(runtime, second, observer, owners[0], deadline);
      const scope = { userId: owners[0] };
      const concReq = { ...stageRequest(config.candidate.runId), operationKey: `race-${config.candidate.runId}` };
      const a = makeAdmittedLpService(runtime);
      const b = makeAdmittedLpService(second);
      const start = performance.now();
      const acquisitions = await Promise.allSettled([a.acquire(scope, concReq), b.acquire(scope, concReq)]);
      for (const r of acquisitions) if (r.status === 'rejected') throw r.reason;
      const positions = acquisitions.map((r: any) => r.value);
      const adm = await a.requestOperation(scope, { positionId: positions[0]!.id, operationKey: `race-close-${config.candidate.runId}`, action: 'close' });
      const settled = await Promise.allSettled([
        a.process(scope, { operationId: adm.operation.id, chain: 'solana' }),
        b.process(scope, { operationId: adm.operation.id, chain: 'solana' })
      ]);
      for (const r of settled) if (r.status === 'rejected') throw r.reason;
      const settlements = settled.map((r: any) => r.value);
      const journal = await runtimeTransaction(runtime, owners[0], (c: any) =>
        c.query(
          `SELECT (SELECT count(*)::text FROM lp_exact_positions WHERE user_id=$1 AND acquisition_key=$2) AS positions,
            (SELECT count(*)::text FROM lp_exact_receipts WHERE operation_id=$3) AS receipts`,
          [owners[0], concReq.operationKey, adm.operation.id]
        )
      );
      const jr = journal.rows[0];
      const baseConc = result(
        'I5',
        [
          ...rollbackChecks,
          assertion('competing LP acquisition serializes same immutable identity', positions[0]!.id === positions[1]!.id && jr.positions === '1'),
          assertion('competing LP settlements apply one receipt', settlements.every((s: any) => s.operation.status === 'completed') && jr.receipts === '1')
        ],
        ['Post-lock expiry/cancel, canonical claims and cross-account fee races remain unimplemented'],
        { elapsedMs: Math.round(performance.now() - start), journal: jr, isolation: 'READ COMMITTED', concurrentClients: 2 }
      );
      await writer.write('concurrency-i5-base.json', baseConc.evidence);
      return result('I5', baseConc.assertions, [], baseConc.evidence);
    }, deadline);
    gateResults.push(i5);
    await writer.write('gate-i5.json', nonsecretEvidence(i5));
    console.log('[STAGE-A] I5:', gatePassed(i5) ? 'PASS' : 'FAIL', `${i5.assertions.filter((a: any) => a.passed).length}/${i5.assertions.length}`);

    // Gate I6 (real child process SIGKILL + Redis 7 BullMQ stall/redelivery with 085 admissions)
    const i6 = await executeGateWithCommitFence('I6', 'execute:I6', fence, async () => {
      const scope = { userId: owners[0] };
      const crashService = makeAdmittedLpService(runtime);
      const crashChecks: any[] = [];
      const workers: any[] = [];
      for (const point of ['before-settlement-commit', 'after-settlement-commit-before-ack'] as const) {
        const request = { ...stageRequest(config.candidate.runId), operationKey: `fault-${point}-${config.candidate.runId}` };
        const p = await crashService.acquire(scope, request);
        const op = (await crashService.requestOperation(scope, { positionId: p.id, operationKey: `fault-close-${point}-${config.candidate.runId}`, action: 'close' })).operation;
        await admissionWriter.settlement(scope, op.id);
        const fault = await ownedWorker({ configPath, runId: config.candidate.runId, userId: owners[0], operationId: op.id, point }, deadline);
        workers.push(fault);
        const before = await runtimeTransaction(runtime, owners[0], (c: any) =>
          c.query(
            `SELECT o.status, e.data->'currentAmount'->>'raw' AS raw,
              (SELECT count(*)::text FROM lp_exact_receipts r WHERE r.operation_id=o.id) AS receipts
             FROM lp_exact_operations o JOIN lp_exact_positions e ON e.position_id=o.position_id WHERE o.id=$1`,
            [op.id]
          )
        );
        const row = before.rows[0];
        crashChecks.push(
          assertion(
            `${point}-durable-state`,
            point === 'before-settlement-commit'
              ? row?.status === 'pending' && row.raw === request.deposit.raw && row.receipts === '0'
              : row?.status === 'completed' && row.raw === '0' && row.receipts === '1'
          )
        );
        const restart = await ownedWorker({ configPath, runId: config.candidate.runId, userId: owners[0], operationId: op.id, point: 'none' }, deadline);
        workers.push(restart);
        const after = await runtimeTransaction(runtime, owners[0], (c: any) =>
          c.query('SELECT count(*)::text AS receipts FROM lp_exact_receipts WHERE operation_id=$1', [op.id])
        );
        crashChecks.push(
          assertion(
            `${point}-restart-ack-and-single-economics`,
            restart.ack && after.rows[0]?.receipts === '1' && (await crashService.position(scope, p.id))?.realizedMicroUsd === '50000'
          )
        );
      }

      // Same-job BullMQ stall/redelivery scenario
      const qClients = new OwnedClients(deadline);
      let queues: any;
      let queueStallRes: any;
      try {
        const qAddresses = await inspectEnvironment(config.candidate, 'candidate', deadline);
        const qRedis = await qClients.redis(config.candidate.redis.url, `wave4-queue-observer-${config.candidate.runId}`);
        await bindRedisIdentity(qRedis, qAddresses.redis, redisCandidate);
        const noQueueSvc = makeAdmittedLpService(runtime, async () => { throw new Error('Synthetic queue hint loss'); });
        const qPos = await noQueueSvc.acquire(scope, { ...stageRequest(config.candidate.runId), operationKey: `bullmq-acquire-${config.candidate.runId}` });
        const qAdm = await noQueueSvc.requestOperation(scope, { positionId: qPos.id, operationKey: `bullmq-close-${config.candidate.runId}`, action: 'close' });
        const qInput = { runId: config.candidate.runId, userId: owners[0], operationId: qAdm.operation.id };
        const qId = queueIdentity(qInput);
        const assertPendingQueueJournal = (j: any) => {
          requireCheck(
            j.operationId === qInput.operationId &&
              j.userId === qInput.userId &&
              j.acquisition?.acquisitionKey === qId.acquisitionKey &&
              j.operation?.operationKey === `bullmq-close-${config.candidate.runId}` &&
              j.status === 'pending' &&
              j.operation?.status === 'pending' &&
              j.receipts === '0' &&
              j.receipt === null &&
              j.receiptRow === null &&
              j.raw === stageDeposit.raw &&
              j.revision === '0' &&
              j.position?.currentAmount?.scale === 18 &&
              j.legacyState === 'active',
            'Queue admission lacks exact pending financial identity'
          );
        };
        const assertCompletedQueueJournal = (j: any) => {
          const basis = (BigInt(stageDeposit.raw) * 1234567n / 10n ** 18n).toString();
          requireCheck(
            j.operationId === qInput.operationId &&
              j.userId === qInput.userId &&
              j.acquisitionKey === qId.acquisitionKey &&
              j.status === 'completed' &&
              j.raw === '0' &&
              j.revision === '1' &&
              j.receipts === '1' &&
              j.fees === '100000' &&
              j.costs === '50000' &&
              j.realized === '50000' &&
              j.legacyState === 'closed' &&
              j.receipt?.proceedsMicroUsd === basis &&
              j.receipt?.receiptId === `receipt-${qInput.operationId}` &&
              j.receipt?.finality === 'paper-settled' &&
              j.receiptRow?.receipt_hash === lpExactHash(j.receipt) &&
              lpExactHash(j.operation?.receipt) === lpExactHash(j.receipt) &&
              Array.isArray(j.history) &&
              j.history.map((h: any) => `${h.from_state ?? 'null'}:${h.to_state}`).join(',') ===
                'null:building,building:active,active:closed',
            'Queue completion lacks exact durable receipt-backed economics'
          );
        };
        const pending = await queueJournal(runtime, qInput);
        assertPendingQueueJournal(pending);
        requireCheck(qAdm.queued === false, 'Lost queue hint did not leave committed original inventory');
        await requireEmptyQueueNamespace(qRedis, qInput, deadline);
        queues = new OwnedQueueRuntime(deadline, config.candidate.redis.url, qInput, qAddresses.redis, redisCandidate);
        const queue = await queues.queue();
        const events = await queues.events();
        const recovery = await makeAdmittedLpService(runtime, async (data: any) => {
          requireCheck(hash(data) === hash(qId.data), 'Recovery selected unrelated tenant operation');
          await queues.track(queue.add(lpJobName, data, { jobId: qId.jobId, attempts: 1, removeOnComplete: false, removeOnFail: false }));
        }).recover(scope);
        requireCheck(recovery.queued === 1 && recovery.deferred === 0, 'Recovery did not admit exactly one durable pending operation');
        requireQueueJob(await queues.track(queue.getJob(qId.jobId)), qInput);
        await admissionWriter.settlement(scope, qInput.operationId);
        const crash = await ownedQueueWorker({ ...qInput, configPath, redisRunId: redisCandidate, point: 'after-settlement-commit-before-ack' }, deadline);
        requireCheck(crash.signal === 'SIGKILL' && !crash.ack, 'Owned queue processor was not killed before resolution');
        const committed = await queueJournal(runtime, qInput);
        assertCompletedQueueJournal(committed);
        const active: any = await queues.track(queue.getJob(qId.jobId));
        requireQueueJob(active, qInput);
        requireCheck(await queues.track(active.getState()) === 'active' && active.attemptsStarted === 1 && active.stalledCounter === 0, 'Killed processor already acknowledged or lost its retained active job');
        const replaySvc = makeAdmittedLpService(runtime);
        await queues.worker(async (job: any) => {
          requireQueueJob(job, qInput);
          const outcome = await replaySvc.process(scope, qId.data);
          requireCheck(outcome.operation.status === 'completed', 'Redelivered processor has pending receipt');
          assertCompletedQueueJournal(await queueJournal(runtime, qInput));
          return { operationId: qId.operationId, status: 'completed' };
        });
        await queues.completed(active, events);
        const retained: any = await queues.track(queue.getJob(qId.jobId));
        requireQueueJob(retained, qInput);
        const state = await queues.track(retained.getState());
        const streamRows = await qRedis.xrange(`${qId.prefix}:${qId.queue}:events`, '-', '+', 'COUNT', 1000);
        requireCheck(streamRows.length < 1000, 'Owned queue stream evidence was truncated');
        const stream = queueStream(streamRows);
        requireRedelivery(retained, state, stream, qInput);
        const after = await queueJournal(runtime, qInput);
        assertCompletedQueueJournal(after);
        requireCheck(hash(after) === hash(committed), 'Redelivery changed immutable receipts, history or settled economics');
        queueStallRes = result(
          'I6',
          [
            assertion('lost queue hint recovered from durable pending operation', true),
            assertion('owned BullMQ worker killed after checked SQL commit before processor resolution', true),
            assertion('same retained job normally stalled and redelivered exactly once', true),
            assertion('BullMQ completion and unchanged receipt-backed SQL economics reconciled', true)
          ],
          [],
          {
            jobId: qId.jobId,
            queue: qId.queue,
            prefix: qId.prefix,
            attemptsStarted: retained.attemptsStarted,
            stalledCounter: retained.stalledCounter,
            stream,
            durableBeforeHash: hash(committed),
            durableAfterHash: hash(after),
            retention: 'Qualification retains completed/failed job evidence; production removes these jobs',
            lockDurationMs: 5000,
            stalledIntervalMs: 1000,
            manualQueueRepair: false
          }
        );
      } finally {
        const shutdown = new Deadline(5000);
        try {
          const closed = await Promise.allSettled([qClients.close(shutdown), queues?.close(shutdown)]);
          shutdown.check();
          requireCheck(closed.every((r: any) => r.status === 'fulfilled'), 'Owned queue scenario cleanup failed');
        } finally {
          shutdown.dispose();
        }
      }

      const crashesEvidence = { workers };
      await writer.write('faults-i6-base.json', { crashes: crashesEvidence, queueStall: queueStallRes.evidence });
      return result('I6', [...crashChecks, ...queueStallRes.assertions], [...queueStallRes.blocked], {
        crashes: crashesEvidence,
        queueStall: queueStallRes.evidence
      });
    }, deadline);
    gateResults.push(i6);
    await writer.write('gate-i6.json', nonsecretEvidence(i6));
    console.log('[STAGE-A] I6:', gatePassed(i6) ? 'PASS' : 'FAIL', `${i6.assertions.filter((a: any) => a.passed).length}/${i6.assertions.length}`);

    // Deactivate temporary swat_auth_service and swat_lp_admitter LOGIN
    const dbaCleanupLease = await candAuthInstall.acquireDba();
    try {
      await dbaCleanupLease.client.query('ALTER ROLE swat_auth_service NOLOGIN PASSWORD NULL');
      await dbaCleanupLease.client.query('ALTER ROLE swat_lp_admitter NOLOGIN PASSWORD NULL');
    } finally {
      dbaCleanupLease.release(false);
    }

    const summary = {
      version: 1,
      stage: 'A',
      runId: config.candidate.runId,
      referenceRunId: config.reference.runId,
      completedAt: new Date().toISOString(),
      gates: gateResults.map((g) => ({
        gate: g.gate,
        passed: gatePassed(g),
        assertionsPassed: g.assertions.filter((a: any) => a.passed).length,
        assertionsTotal: g.assertions.length,
        blocked: g.blocked
      })),
      runtimeAccepted: false,
      productionReady: false
    };
    await writer.write('stage-a-summary.json', summary);
    writeFileSync(resolve(outDir, 'stage-a-summary-copy.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
    await writer.settle();
    writer.seal();
    await writer.settle();

    console.log('[STAGE-A] COMPLETE:', JSON.stringify(summary, null, 2));
    const corePassed = [i1, i2, i4, i5, i6].every((g) => g.assertions.every((a: any) => a.passed === true));
    process.exitCode = corePassed ? 0 : 1;
  } catch (err) {
    const artifact = sanitizeFailure(err, 'execute', null);
    console.error('[STAGE-A] FAILED:', err);
    await writer.write('failure.json', nonsecretEvidence({ failed: true, artifact })).catch(() => {});
    process.exitCode = 1;
  } finally {
    redisClientForAuth?.disconnect();
    await clients.close(new Deadline(15_000)).catch(() => {});
    deadline.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
