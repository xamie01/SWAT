import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { privateConfig } from './config.js';
import { assertion, gates, requireCheck, result, transaction, type Gate } from './core.js';
import { runEvidenceQualification } from './evidence-session.js';
import { OwnedClients, inspectBoth, bindPostgres, bindRedis, migratePristine, catalog } from './infrastructure.js';
import { qualifyDomains, qualifyRoles, runtimeTransaction, seedOwners } from './domains.js';
import { pipelinePreflight } from './pipeline.js';
import { qualifyConcurrency, qualifyCrashes } from './faults.js';
import { qualifyQueueStall } from './queue-scenario.js';

export async function runQualification(configPath: string, output: string) {
  await privateConfig(configPath);
  throw new Error('Wave4 real execution is unavailable until incomplete source scenarios, privilege prerequisites and deadline containment have independent qualification');
}

/** Unwired implementation draft. No exported entrypoint or CLI authorizes infrastructure effects. */
async function runDraftQualification(configPath: string, output: string) {
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
        await migratePristine(reference, deadline);
        await migratePristine(candidate, deadline);
        const baseline = await catalog(reference, c.reference.postgres.url, deadline);
        const installed = await catalog(candidate, c.candidate.postgres.url, deadline);
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
        owners = await seedOwners(runtime, c.candidate.runId);
        return qualifyRoles(runtime, pooled, owners);
      }
      if (gate === 'I3') return transaction(runtime, null, tx => pipelinePreflight(tx));
      if (gate === 'I4') return qualifyDomains(runtime, c.candidate.runId, owners);
      if (gate === 'I5') return qualifyConcurrency(runtime, second, observer, c.candidate.runId, owners[0], deadline);
      if (gate === 'I6') {
        const crashes = await qualifyCrashes(runtime, c.candidate.runId, owners[0], configPath, deadline);
        const queue = await qualifyQueueStall(runtime, c, owners[0], configPath, redisCandidate, deadline);
        return result(gate,[...crashes.assertions,...queue.assertions],
          ['Redis loss and source/outbox/canonical worker faults remain unimplemented'],{crashes:crashes.evidence,queue:queue.evidence});
      }
      return result(gate, [], [gate === 'I7' ? 'Load observations and durable admissions/completions require separate authorized execution'
        : 'Independent real-runtime evidence review is not self-approvable']);
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
