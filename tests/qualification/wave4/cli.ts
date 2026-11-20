import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { privateConfig } from './config.js';
import { assertion, gates, requireCheck, result, transaction, type Gate } from './core.js';
import { runEvidenceQualification } from './evidence-session.js';
import { OwnedClients, inspectBoth, bindPostgres, bindRedis, migratePristine, catalog } from './infrastructure.js';
import { qualifyDomains, qualifyRoles, runtimeTransaction } from './domains.js';
import { activateInstalledAuthentication,assertAuthenticationInstallation,type AuthenticationInstallation,type AuthenticationActivation } from '../../../deploy/postgres/auth-installation.js';
import { qualifyProtectedAuthentication,type AuthenticationQualificationPorts } from './authentication.js';
import { canonicalMigrationSource } from '../../../packages/db/src/canonical-migration-source.js';
import { authenticationInstallationSource } from '../../../deploy/postgres/auth-installation.js';
import { pipelinePreflight } from './pipeline.js';
import { qualifyConcurrency, qualifyCrashes } from './faults.js';
import { qualifyQueueStall } from './queue-scenario.js';

export async function runQualification(configPath: string, output: string) {
  await privateConfig(configPath);
  throw new Error('Wave4 real execution is unavailable until incomplete source scenarios, privilege prerequisites and deadline containment have independent qualification');
}

export interface PrivateAuthenticationComposition {
 reference:AuthenticationInstallation;
 candidate:AuthenticationInstallation;
 activation:AuthenticationActivation;
 qualification:AuthenticationQualificationPorts;
}
/** Auth staging is executable only through explicitly supplied nonambient capability
 * composition. The broad CLI remains refused pending P8; this seam grants no P4-P8 authority. */
export async function runAuthenticationStaging(configPath:string,output:string,authentication:PrivateAuthenticationComposition) {
 const config=await privateConfig(configPath);
 assertAuthenticationInstallation(authentication?.reference);assertAuthenticationInstallation(authentication?.candidate);
 if(typeof authentication.activation?.activateExternally!=='function'||!authentication.qualification
  ||authentication.qualification.overlapObservation!=='postgres-blocking-edge')throw new Error('Explicit external activation and PostgreSQL authentication qualification capabilities required');
 const source=await canonicalMigrationSource(config.migrationSelection);
 const sql=authenticationInstallationSource(source,authentication.candidate);
 if(!sql)throw new Error('Private authentication lifecycle requires explicitly reviewed 087 selection');
 // Validate before evidence/infrastructure side effects, including independent inspected
 // identity binding of both installation capabilities. Existing DBA inputs are not app URLs.
 if(JSON.stringify(authentication.qualification.target)!==JSON.stringify(authentication.candidate.target))throw new Error('Authentication qualification target must equal independently inspected candidate installation');
 if(authentication.reference.target.systemIdentifier===authentication.candidate.target.systemIdentifier)throw new Error('Independent authentication installation clusters required');
 return runDraftQualification(configPath,output,authentication);
}
/** Private, capability-composed lifecycle; broad domains remain later coordinator work. */
async function runDraftQualification(configPath: string, output: string,authentication:PrivateAuthenticationComposition) {
  const config = await privateConfig(configPath);
  let clients: OwnedClients | undefined;
  let addresses: Awaited<ReturnType<typeof inspectBoth>>;
  let reference: any, candidate: any, runtime: any, pooled: any, second: any, observer: any;
  let owners: [string, string];
  let redisCandidate: string;
  return runEvidenceQualification(config, resolve(output), {
    inspect: async (c, deadline) => { clients = new OwnedClients(deadline); addresses = await inspectBoth(c, deadline); },
    execute: async (gate: Gate, c, deadline, raw) => {
      requireCheck(clients, 'Owned clients unavailable after inspection');
      if (gate === 'I1') {
        reference = await clients.postgres(c.reference.postgres.url, `wave4-reference-${c.reference.runId}`);
        candidate = await clients.postgres(c.candidate.postgres.url, `wave4-candidate-${c.candidate.runId}`);
        const referenceId = await bindPostgres(reference, c.reference, addresses.reference.postgres, deadline);
        const candidateId = await bindPostgres(candidate, c.candidate, addresses.candidate.postgres, deadline);
        requireCheck(referenceId !== candidateId, 'Connected reference and candidate are the same cluster');
        const rr = await clients.redis(c.reference.redis.url, `wave4-reference-${c.reference.runId}`);
        const cr = await clients.redis(c.candidate.redis.url, `wave4-candidate-${c.candidate.runId}`);
        const redisReference = await bindRedis(rr, addresses.reference.redis);
        redisCandidate = await bindRedis(cr, addresses.candidate.redis);
        requireCheck(redisReference !== redisCandidate, 'Connected reference and candidate share Redis identity');
        requireCheck(authentication.reference.target.systemIdentifier===referenceId&&authentication.candidate.target.systemIdentifier===candidateId
          &&authentication.reference.target.address===addresses.reference.postgres&&authentication.candidate.target.address===addresses.candidate.postgres
          &&authentication.reference.target.database===new URL(c.reference.postgres.url).pathname.slice(1)&&authentication.candidate.target.database===new URL(c.candidate.postgres.url).pathname.slice(1),'Authentication DBA targets differ from independently inspected clusters');
        await migratePristine(reference, deadline, c.migrationSelection,authentication.reference);
        await migratePristine(candidate, deadline, c.migrationSelection,authentication.candidate);
        const baseline = await catalog(reference, c.reference.postgres.url, deadline, c.migrationSelection,authentication.reference);
        const installed = await catalog(candidate, c.candidate.postgres.url, deadline, c.migrationSelection,authentication.candidate);
        await raw('reference-catalog.json', baseline);
        await raw('candidate-catalog.json', installed);
        await inspectBoth(c, deadline);
        return result(gate, [assertion('independent connected PG16 and Redis7 identities', true),
          assertion('canonical catalogs roles ACLs and migration journals match', baseline.digest === installed.digest
            && baseline.journalDigest === installed.journalDigest && baseline.sourceDigest === installed.sourceDigest)], [],
          { referenceCluster: referenceId, candidateCluster: candidateId, redisReference, redisCandidate,
            sourceDigest: baseline.sourceDigest, referenceCatalogDigest: baseline.digest, candidateCatalogDigest: installed.digest });
      }
      if (gate === 'I2') {
        runtime = await clients.postgres(c.runtimeUrl, `wave4-runtime-${c.candidate.runId}`);
        pooled = await clients.postgres(c.pooledRuntimeUrl, `wave4-pooled-${c.candidate.runId}`);
        second = await clients.postgres(c.runtimeUrl, `wave4-competitor-${c.candidate.runId}`);
        observer = await clients.postgres(c.runtimeUrl, `wave4-lock-observer-${c.candidate.runId}`);
        // A pooled connection must still reach the candidate, not a server with merely the same database name.
        for (const client of [runtime, pooled, second, observer]) await runtimeTransaction(client, null, async tx => {
          const row = (await tx.query('SELECT inet_server_addr()::text AS address,inet_server_port() AS port,current_database() AS database')).rows[0];
          requireCheck(row.address === addresses.candidate.postgres && row.port === 5432
            && row.database === new URL(c.candidate.postgres.url).pathname.slice(1), 'Runtime/pool connected to uninspected server');
        });
        const source=await canonicalMigrationSource(c.migrationSelection);
        const sql=authenticationInstallationSource(source,authentication.candidate);requireCheck(sql,'Reviewed authentication migration required');
        deadline.check();await activateInstalledAuthentication(authentication.candidate,sql,authentication.activation);deadline.check();
        const authResult=await qualifyProtectedAuthentication(authentication.qualification);deadline.check();
        owners=[authResult.users[0]!,authResult.users[1]!];
        await raw('protected-authentication.json',authResult);
        const roles=await qualifyRoles(runtime,pooled,owners);
        return result(gate,[...roles.assertions,assertion('protected routes owned-store and observed authentication overlap',authResult.schedules.length===5)],[...roles.blocked],{...roles.evidence,authentication:authResult});
      }
      // This explicit seam owns only P3. No broader financial/pipeline execution is
      // authorized by authentication capability composition.
      return result(gate,[],['P3 authentication staging finished; broader P4-P8 composition requires separate coordinator capability integration']);
    },
    close: async deadline => { if (clients) await clients.close(deadline); }
  });
}
async function main() {
  if (process.argv.length === 3 && process.argv[2] === '--plan') {
    console.log(JSON.stringify({ gates, sourceImplemented: false, sourceComplete: false, runtimeAccepted: false, productionReady: false,
      execution: 'Explicit separate environment authorization required; source scenarios and composition remain incomplete' }, null, 2));
    return;
  }
  requireCheck(process.argv.length === 5 && process.argv[2] === '--run', 'Usage: cli.ts --plan | --run /absolute/private-config.json /new/private-output-directory');
  await runQualification(process.argv[3]!, process.argv[4]!);
  process.exitCode = 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Qualification refused or failed; credentials and driver errors suppressed'); process.exitCode = 1; });
}
