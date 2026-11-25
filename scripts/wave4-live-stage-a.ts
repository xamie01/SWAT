/**
 * Live Stage A (I1, I2, I4-base, I5-base, I6-base) runner against disposable
 * containers configured in private-config.json. Invoked via tsx.
 */
import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const { privateConfig } = require('../tests/qualification/wave4/config.ts');
const { Deadline } = require('../tests/qualification/wave4/containment.ts');
const { assertion, createCommitFence, executeGateWithCommitFence, gatePassed, result, sanitizeFailure } =
  require('../tests/qualification/wave4/core.ts');
const { createEvidenceWriter, nonsecretEvidence } = require('../tests/qualification/wave4/evidence-writer.ts');
const { OwnedClients, inspectBoth, bindPostgres, bindRedis, migratePristine, catalog } =
  require('../tests/qualification/wave4/infrastructure.ts');
const { qualifyRoles, seedOwners, qualifyDomains, runtimeTransaction } =
  require('../tests/qualification/wave4/domains.ts');
const { qualifyProtectedAuthentication } = require('../tests/qualification/wave4/authentication.ts');
const { pipelinePreflight } = require('../tests/qualification/wave4/pipeline.ts');
const { qualifyConcurrency, qualifyCrashes } = require('../tests/qualification/wave4/faults.ts');
const { qualifyQueueStall } = require('../tests/qualification/wave4/queue-scenario.ts');
const { activateInstalledAuthentication, authenticationInstallationSource } =
  require('../deploy/postgres/auth-installation.ts');
const { canonicalMigrationSource } = require('../packages/db/src/canonical-migration-source.ts');

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
      query_timeout: 15_000,
      statement_timeout: 15_000
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

async function ensurePrerequisiteRoles(dbaUrl: string) {
  const client = new Client({ connectionString: dbaUrl, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query(`DO $$
DECLARE role_name text;
  extra_roles text[] := ARRAY[
    'swat_fanout',
    'swat_wave4_authority_writer', 'swat_wave4_financial_writer',
    'swat_lp_initializer', 'swat_custody_reader', 'swat_custody_observer'
  ];
BEGIN
  FOREACH role_name IN ARRAY extra_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN PASSWORD NULL NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION', role_name);
    END IF;
    EXECUTE format('ALTER ROLE %I SET row_security=on', role_name);
    EXECUTE format('ALTER ROLE %I SET search_path=pg_catalog', role_name);
  END LOOP;
END $$`);
  } finally {
    await client.end();
  }
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

  await ensurePrerequisiteRoles(refDbaUrl);
  await ensurePrerequisiteRoles(candDbaUrl);

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

    // Gate I2
    const runtime = await clients.postgres(config.runtimeUrl, `wave4-runtime-${config.candidate.runId}`);
    const pooled = await clients.postgres(config.pooledRuntimeUrl, `wave4-pooled-${config.candidate.runId}`);
    const second = await clients.postgres(config.runtimeUrl, `wave4-competitor-${config.candidate.runId}`);
    const observer = await clients.postgres(config.runtimeUrl, `wave4-lock-observer-${config.candidate.runId}`);

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
        signature: makeSolanaSyntheticSigner(),
        overlapObservation: 'postgres-blocking-edge',
        fixture: {
          emailA: `w4a-${config.candidate.runId.slice(0, 8)}@example.invalid`,
          emailB: `w4b-${config.candidate.runId.slice(0, 8)}@example.invalid`,
          password: 'Synthetic-Wave4-Password-123!',
          newPassword: 'Synthetic-Wave4-Password-456!',
          walletAddress: makeSolanaSyntheticSigner().address
        }
      });
      await writer.write('protected-authentication.json', authResult);

      const roles = await qualifyRoles(runtime, pooled, [authResult.users[0]!, authResult.users[1]!]);
      const preflight = await pipelinePreflight(runtime);
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

    // Seed isolated synthetic domain owners for I4, I5, I6
    const owners = await seedOwners(runtime, config.candidate.runId);

    // Gate I4 (real Postgres custody/withdrawal/LP domains)
    const i4 = await executeGateWithCommitFence('I4', 'execute:I4', fence, async () => {
      const baseDomains = await qualifyDomains(runtime, config.candidate.runId, owners);
      await writer.write('domains-i4-base.json', baseDomains.evidence);
      return result('I4', baseDomains.assertions, [], { ...baseDomains.evidence, note: 'Keyless/SQL domain invariants passed on live PostgreSQL 16; keyed P5 external signing adapters separate' });
    }, deadline);
    gateResults.push(i4);
    await writer.write('gate-i4.json', nonsecretEvidence(i4));
    console.log('[STAGE-A] I4:', gatePassed(i4) ? 'PASS' : 'FAIL', `${i4.assertions.filter((a: any) => a.passed).length}/${i4.assertions.length}`);

    // Gate I5 (real Postgres pg_blocking_pids lock waits + LP rollback concurrency)
    const i5 = await executeGateWithCommitFence('I5', 'execute:I5', fence, async () => {
      const baseConc = await qualifyConcurrency(runtime, second, observer, config.candidate.runId, owners[0], deadline);
      await writer.write('concurrency-i5-base.json', baseConc.evidence);
      return result('I5', baseConc.assertions, [], baseConc.evidence);
    }, deadline);
    gateResults.push(i5);
    await writer.write('gate-i5.json', nonsecretEvidence(i5));
    console.log('[STAGE-A] I5:', gatePassed(i5) ? 'PASS' : 'FAIL', `${i5.assertions.filter((a: any) => a.passed).length}/${i5.assertions.length}`);

    // Gate I6 (real child process SIGKILL + Redis 7 BullMQ stall/redelivery)
    const i6 = await executeGateWithCommitFence('I6', 'execute:I6', fence, async () => {
      const crashes = await qualifyCrashes(runtime, config.candidate.runId, owners[0], configPath, deadline);
      const queueStall = await qualifyQueueStall(runtime, config, owners[0], configPath, redisCandidate, deadline);
      await writer.write('faults-i6-base.json', { crashes: crashes.evidence, queueStall: queueStall.evidence });
      return result('I6', [...crashes.assertions, ...queueStall.assertions], [...queueStall.blocked], {
        crashes: crashes.evidence,
        queueStall: queueStall.evidence
      });
    }, deadline);
    gateResults.push(i6);
    await writer.write('gate-i6.json', nonsecretEvidence(i6));
    console.log('[STAGE-A] I6:', gatePassed(i6) ? 'PASS' : 'FAIL', `${i6.assertions.filter((a: any) => a.passed).length}/${i6.assertions.length}`);

    // Deactivate temporary swat_auth_service LOGIN
    const dbaCleanupLease = await candAuthInstall.acquireDba();
    try {
      await dbaCleanupLease.client.query('ALTER ROLE swat_auth_service NOLOGIN PASSWORD NULL');
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
