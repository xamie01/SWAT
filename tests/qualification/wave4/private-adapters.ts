import { resolve } from 'node:path';
import type { ReviewedMigrationSelection } from '../../../packages/db/src/migration-selection.js';
import { canonicalMigrationSource } from '../../../packages/db/src/canonical-migration-source.js';
import {
  activateInstalledAuthentication,
  assertAuthenticationInstallation,
  authenticationInstallationSource,
  type AuthenticationInstallation
} from '../../../deploy/postgres/auth-installation.js';
import { qualifyProtectedAuthentication } from './authentication.js';
import type { PrivateAuthenticationComposition } from './cli.js';
import { privateConfig } from './config.js';
import { Deadline } from './containment.js';
import {
  assertion,
  createCommitFence,
  executeGateWithCommitFence,
  gatePassed,
  quarantineClient,
  requireCheck,
  result,
  transaction,
  type Assertion,
  type CommitFence,
  type Gate,
  type GateResult,
  type QualificationConfig,
  type SqlClient
} from './core.js';
import { qualifyDomains, qualifyRoles, seedOwners } from './domains.js';
import { runEvidenceQualification, type EvidenceQualificationPorts } from './evidence-session.js';
import { qualifyConcurrency, qualifyCrashes } from './faults.js';
import {
  OwnedClients,
  bindPostgres,
  bindRedis,
  catalog,
  inspectBoth,
  migratePristine
} from './infrastructure.js';
import { requireLoadFinalAccounting, type LoadFinalAccounting } from './load-durable-economics.js';
import { runIndependentLoad, type IndependentLoadPorts, type LoadLifetimePlan } from './load-lifetime.js';
import { qualifyP6Concurrency, type P6ConcurrencyPorts } from './p6-concurrency-schedules.js';
import { qualifyP6Faults, type P6FaultPorts } from './p6-fault-schedules.js';
import { pipelinePreflight } from './pipeline.js';
import { createExecutedPaperPipeline, type ExecutedPipelineInput } from './pipeline-executed.js';
import { qualifyQueueStall } from './queue-scenario.js';

type CaptureEvidence = Parameters<EvidenceQualificationPorts['execute']>[3];

export interface GateResultFragment {
  readonly assertions: readonly Assertion[];
  readonly blocked?: readonly string[];
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export interface CoordinatorClients {
  postgres(url: string, name: string): Promise<SqlClient>;
  redis(url: string, name: string): Promise<any>;
  close(shutdown: Deadline): Promise<void>;
}

export interface CoordinatorGateContext {
  readonly config: QualificationConfig;
  readonly deadline: Deadline;
  readonly fence: CommitFence;
  readonly raw: CaptureEvidence;
  readonly clients: CoordinatorClients;
  readonly addresses: { reference: { postgres: string; redis: string }; candidate: { postgres: string; redis: string } };
  readonly runtime: SqlClient | undefined;
  readonly pooled: SqlClient | undefined;
  readonly second: SqlClient | undefined;
  readonly observer: SqlClient | undefined;
  readonly owners: readonly [string, string] | undefined;
  readonly redisCandidate: string | undefined;
  readonly priorResults: readonly GateResult[];
  readonly fencedTransaction: <T>(
    client: SqlClient,
    userId: string | null,
    action: (tx: SqlClient) => Promise<T>
  ) => Promise<T>;
}

export interface SeparateLoadEvidence {
  readonly report: Awaited<ReturnType<typeof runIndependentLoad<LoadFinalAccounting>>>;
  readonly accounting: LoadFinalAccounting;
}

export interface PrivateCoordinatorComposition {
  readonly configPath: string;
  readonly createClients?: (deadline: Deadline) => CoordinatorClients;
  readonly inspectInfrastructure?: typeof inspectBoth;
  readonly bindPostgres?: typeof bindPostgres;
  readonly bindRedis?: typeof bindRedis;
  readonly migratePristine?: typeof migratePristine;
  readonly catalog?: typeof catalog;
  readonly canonicalMigrationSource?: typeof canonicalMigrationSource;
  readonly authentication: PrivateAuthenticationComposition;
  readonly activateAuthentication?: typeof activateInstalledAuthentication;
  readonly qualifyAuthentication?: typeof qualifyProtectedAuthentication;
  readonly qualifyRoles?: typeof qualifyRoles;
  readonly pipelinePreflight?: typeof pipelinePreflight;
  readonly pgbouncerInspect?: (
    c: QualificationConfig,
    deadline: Deadline
  ) => Promise<GateResultFragment>;
  readonly pipeline?: (ctx: CoordinatorGateContext) => ExecutedPipelineInput;
  readonly executePipeline?: (
    input: ExecutedPipelineInput
  ) => Promise<Awaited<ReturnType<ReturnType<typeof createExecutedPaperPipeline>['run']>>>;
  readonly seedOwners?: (client: SqlClient, runId: string) => Promise<[string, string]>;
  readonly qualifyBaseDomains?: typeof qualifyDomains;
  readonly domains?: {
    readonly custody?: (ctx: CoordinatorGateContext) => Promise<GateResultFragment>;
    readonly withdrawal?: (ctx: CoordinatorGateContext) => Promise<GateResultFragment>;
    readonly reducing?: (ctx: CoordinatorGateContext) => Promise<GateResultFragment>;
    readonly lpCopy?: (ctx: CoordinatorGateContext) => Promise<GateResultFragment>;
  };
  readonly qualifyBaseConcurrency?: typeof qualifyConcurrency;
  readonly p6Concurrency?:
    | P6ConcurrencyPorts
    | ((ctx: CoordinatorGateContext) => P6ConcurrencyPorts | Promise<P6ConcurrencyPorts>);
  readonly concurrencySchedules?: (ctx: CoordinatorGateContext) => Promise<GateResultFragment>;
  readonly qualifyBaseCrashes?: typeof qualifyCrashes;
  readonly qualifyBaseQueueStall?: typeof qualifyQueueStall;
  readonly p6Faults?:
    | P6FaultPorts
    | ((ctx: CoordinatorGateContext) => P6FaultPorts | Promise<P6FaultPorts>);
  readonly faultSchedules?: (ctx: CoordinatorGateContext) => Promise<GateResultFragment>;
  readonly separateLoadEvidence?: SeparateLoadEvidence;
  readonly independentAudit?: (
    results: readonly GateResult[],
    deadline: Deadline
  ) => Promise<GateResultFragment>;
}

const MINIMUM_INDEPENDENT_LOAD_MS = 27 * 60_000;

/** I7 load execution always runs outside core.ts's 600_000ms Deadline. */
export async function runIndependentLoadGate(
  plan: LoadLifetimePlan,
  ports: IndependentLoadPorts<LoadFinalAccounting>,
  cancellation?: AbortSignal
): Promise<SeparateLoadEvidence> {
  const report = await runIndependentLoad(plan, ports, cancellation);
  requireCheck(
    report.observationsComplete && report.containmentComplete && report.value !== undefined,
    'Independent 27-minute load phase did not complete with full containment'
  );
  requireLoadFinalAccounting(report.value);
  return { report, accounting: report.value };
}

export function createPrivateCoordinatorPorts(
  _config: QualificationConfig,
  composition: PrivateCoordinatorComposition
): EvidenceQualificationPorts {
  let clients: CoordinatorClients | undefined;
  let addresses: { reference: { postgres: string; redis: string }; candidate: { postgres: string; redis: string } } | undefined;
  let fence: CommitFence | undefined;
  let runtime: SqlClient | undefined;
  let pooled: SqlClient | undefined;
  let second: SqlClient | undefined;
  let observer: SqlClient | undefined;
  let owners: [string, string] | undefined;
  let domainOwners: [string, string] | undefined;
  let redisCandidate: string | undefined;
  const completedResults: GateResult[] = [];

  const bindPg = composition.bindPostgres ?? bindPostgres;
  const bindRd = composition.bindRedis ?? bindRedis;
  const migrate = composition.migratePristine ?? migratePristine;
  const readCatalog = composition.catalog ?? catalog;
  const loadSources = composition.canonicalMigrationSource ?? canonicalMigrationSource;
  const inspectInfra = composition.inspectInfrastructure ?? inspectBoth;
  const activateAuth = composition.activateAuthentication ?? activateInstalledAuthentication;
  const qualifyAuth = composition.qualifyAuthentication ?? qualifyProtectedAuthentication;
  const checkRoles = composition.qualifyRoles ?? qualifyRoles;
  const checkPreflight = composition.pipelinePreflight ?? pipelinePreflight;
  const createOwners = composition.seedOwners ?? seedOwners;
  const runBaseDomains = composition.qualifyBaseDomains ?? qualifyDomains;
  const runBaseConcurrency = composition.qualifyBaseConcurrency ?? qualifyConcurrency;
  const runBaseCrashes = composition.qualifyBaseCrashes ?? qualifyCrashes;
  const runBaseQueueStall = composition.qualifyBaseQueueStall ?? qualifyQueueStall;

  async function runGate(
    gate: Gate,
    c: QualificationConfig,
    deadline: Deadline,
    raw: CaptureEvidence
  ): Promise<GateResult> {
    requireCheck(clients && addresses && fence, 'Owned clients unavailable after inspection');
    const activeClients = clients;
    const activeAddresses = addresses;
    const activeFence = fence;

    const fencedTransaction = <T>(
      client: SqlClient,
      userId: string | null,
      action: (tx: SqlClient) => Promise<T>
    ) =>
      transaction(client, userId, action, {
        deadline,
        onUncertainCommit: c => {
          quarantineClient(c);
        }
      });

    const ctx: CoordinatorGateContext = {
      config: c,
      deadline,
      fence: activeFence,
      raw,
      clients: activeClients,
      addresses: activeAddresses,
      runtime,
      pooled,
      second,
      observer,
      owners: domainOwners ?? owners,
      redisCandidate,
      priorResults: [...completedResults],
      fencedTransaction
    };

    if (gate === 'I1') {
      const reference = await activeClients.postgres(c.reference.postgres.url, `wave4-reference-${c.reference.runId}`);
      const candidate = await activeClients.postgres(c.candidate.postgres.url, `wave4-candidate-${c.candidate.runId}`);
      const referenceId = await bindPg(reference, c.reference, activeAddresses.reference.postgres, deadline);
      const candidateId = await bindPg(candidate, c.candidate, activeAddresses.candidate.postgres, deadline);
      requireCheck(referenceId !== candidateId, 'Connected reference and candidate are the same cluster');
      const rr = await activeClients.redis(c.reference.redis.url, `wave4-reference-${c.reference.runId}`);
      const cr = await activeClients.redis(c.candidate.redis.url, `wave4-candidate-${c.candidate.runId}`);
      const redisReference = await bindRd(rr, activeAddresses.reference.redis);
      redisCandidate = await bindRd(cr, activeAddresses.candidate.redis);
      requireCheck(redisReference !== redisCandidate, 'Connected reference and candidate share Redis identity');
      assertAuthenticationInstallation(composition.authentication?.reference);
      assertAuthenticationInstallation(composition.authentication?.candidate);
      requireCheck(
        composition.authentication.reference.target.systemIdentifier === referenceId
          && composition.authentication.candidate.target.systemIdentifier === candidateId
          && composition.authentication.reference.target.address === activeAddresses.reference.postgres
          && composition.authentication.candidate.target.address === activeAddresses.candidate.postgres
          && composition.authentication.reference.target.database === new URL(c.reference.postgres.url).pathname.slice(1)
          && composition.authentication.candidate.target.database === new URL(c.candidate.postgres.url).pathname.slice(1),
        'Authentication DBA targets differ from independently inspected clusters'
      );
      await migrate(reference, deadline, c.migrationSelection as ReviewedMigrationSelection | undefined, composition.authentication.reference as AuthenticationInstallation);
      await migrate(candidate, deadline, c.migrationSelection as ReviewedMigrationSelection | undefined, composition.authentication.candidate as AuthenticationInstallation);
      const baseline = await readCatalog(reference, c.reference.postgres.url, deadline, c.migrationSelection, composition.authentication.reference);
      const installed = await readCatalog(candidate, c.candidate.postgres.url, deadline, c.migrationSelection, composition.authentication.candidate);
      await raw('reference-catalog.json', baseline);
      await raw('candidate-catalog.json', installed);
      await inspectInfra(c, deadline);
      return result(
        gate,
        [
          assertion('independent connected PG16 and Redis7 identities', true),
          assertion(
            'canonical catalogs roles ACLs and migration journals match',
            baseline.digest === installed.digest
              && baseline.journalDigest === installed.journalDigest
              && baseline.sourceDigest === installed.sourceDigest
          )
        ],
        [],
        {
          referenceCluster: referenceId,
          candidateCluster: candidateId,
          redisReference,
          redisCandidate,
          sourceDigest: baseline.sourceDigest,
          referenceCatalogDigest: baseline.digest,
          candidateCatalogDigest: installed.digest
        }
      );
    }

    if (gate === 'I2') {
      runtime = await activeClients.postgres(c.runtimeUrl, `wave4-runtime-${c.candidate.runId}`);
      pooled = await activeClients.postgres(c.pooledRuntimeUrl, `wave4-pooled-${c.candidate.runId}`);
      second = await activeClients.postgres(c.runtimeUrl, `wave4-competitor-${c.candidate.runId}`);
      observer = await activeClients.postgres(c.runtimeUrl, `wave4-lock-observer-${c.candidate.runId}`);
      for (const client of [runtime, pooled, second, observer]) {
        await fencedTransaction(client, null, async tx => {
          const row = (
            await tx.query(
              'SELECT inet_server_addr()::text AS address,inet_server_port() AS port,current_database() AS database'
            )
          ).rows[0];
          requireCheck(
            row?.address === activeAddresses.candidate.postgres
              && row.port === 5432
              && row.database === new URL(c.candidate.postgres.url).pathname.slice(1),
            'Runtime/pool connected to uninspected server'
          );
        });
      }
      const source = await loadSources(c.migrationSelection);
      const authSql = authenticationInstallationSource(source, composition.authentication.candidate);
      requireCheck(authSql, 'Reviewed authentication migration required');
      deadline.check();
      await activateAuth(composition.authentication.candidate, authSql, composition.authentication.activation);
      deadline.check();
      const authResult = await qualifyAuth(composition.authentication.qualification);
      deadline.check();
      owners = [authResult.users[0]!, authResult.users[1]!];
      await raw('protected-authentication.json', authResult);
      const roles = await checkRoles(runtime, pooled, owners);
      const preflight = await checkPreflight(runtime);
      const baseAssertions: Assertion[] = [
        ...roles.assertions,
        ...preflight.assertions,
        assertion('protected routes owned-store and observed authentication overlap', authResult.schedules.length === 5)
      ];
      if (!composition.pgbouncerInspect) {
        return result(
          gate,
          [...baseAssertions, assertion('inspected PgBouncer transaction-pool qualification supplied', false)],
          ['Inspected PgBouncer transaction-pool qualification capability absent'],
          { ...roles.evidence, preflight: preflight.evidence, authentication: authResult }
        );
      }
      const pgbouncer = await composition.pgbouncerInspect(c, deadline);
      return result(
        gate,
        [...baseAssertions, ...pgbouncer.assertions],
        [...(pgbouncer.blocked ?? [])],
        {
          ...roles.evidence,
          preflight: preflight.evidence,
          pgbouncer: pgbouncer.evidence ?? {},
          authentication: authResult
        }
      );
    }

    if (gate === 'I3') {
      if (!composition.pipeline) {
        return result(
          gate,
          [assertion('executed paper pipeline composition supplied', false)],
          ['Executed paper pipeline composition absent']
        );
      }
      const pipelineInput = composition.pipeline(ctx);
      const maximumLifetimeMs = Math.min(600_000, deadline.remaining(600_000));
      const boundedSignal = pipelineInput.signal
        ? AbortSignal.any([deadline.signal, pipelineInput.signal])
        : deadline.signal;
      const runPipeline =
        composition.executePipeline ?? (input => createExecutedPaperPipeline(input).run());
      const outcome = await activeFence.guard('i3-execute-pipeline', () =>
        runPipeline({
          ...pipelineInput,
          maximumLifetimeMs,
          signal: boundedSignal
        })
      );
      await raw('pipeline-executed.json', {
        kind: outcome.journal.kind,
        scope: outcome.journal.scope,
        economics: outcome.economics,
        runtimeAccepted: false,
        liveCapabilityAccepted: false,
        productionReady: false
      });
      return result(
        gate,
        [
          assertion(
            'executed paper pipeline exact journal and economics reconciled',
            /^[0-9a-f]{64}$/.test(outcome.economics.exactJournalDigest)
              && outcome.economics.stages.length === 5
              && outcome.economics.runtimeAccepted === false
              && outcome.journal.snapshots.length === 5
          )
        ],
        [],
        { economics: outcome.economics }
      );
    }

    if (gate === 'I4') {
      requireCheck(runtime, 'Owned runtime client unavailable for I4');
      domainOwners = await createOwners(runtime, c.candidate.runId);
      const baseDomains = await runBaseDomains(runtime, c.candidate.runId, domainOwners);
      const domainAdapters = composition.domains;
      const requiredKeys = ['custody', 'withdrawal', 'reducing', 'lpCopy'] as const;
      const missing = requiredKeys.filter(key => typeof domainAdapters?.[key] !== 'function');
      if (missing.length > 0) {
        return result(
          gate,
          [...baseDomains.assertions, assertion('all private domain adapters supplied', false)],
          missing.map(key => `Domain adapter absent: ${key}`),
          { base: baseDomains.evidence }
        );
      }
      const domainCtx: CoordinatorGateContext = { ...ctx, owners: domainOwners };
      const custody = await activeFence.guard('i4-custody', () => domainAdapters!.custody!(domainCtx));
      const withdrawal = await activeFence.guard('i4-withdrawal', () => domainAdapters!.withdrawal!(domainCtx));
      const reducing = await activeFence.guard('i4-reducing', () => domainAdapters!.reducing!(domainCtx));
      const lpCopy = await activeFence.guard('i4-lp-copy', () => domainAdapters!.lpCopy!(domainCtx));
      const evidence = {
        base: baseDomains.evidence,
        custody: custody.evidence ?? {},
        withdrawal: withdrawal.evidence ?? {},
        reducing: reducing.evidence ?? {},
        lpCopy: lpCopy.evidence ?? {}
      };
      await raw('domains-i4.json', evidence);
      return result(
        gate,
        [
          ...baseDomains.assertions,
          ...custody.assertions,
          ...withdrawal.assertions,
          ...reducing.assertions,
          ...lpCopy.assertions
        ],
        [
          ...(custody.blocked ?? []),
          ...(withdrawal.blocked ?? []),
          ...(reducing.blocked ?? []),
          ...(lpCopy.blocked ?? [])
        ],
        evidence
      );
    }

    if (gate === 'I5') {
      requireCheck(runtime && second && observer, 'Owned runtime concurrency clients unavailable for I5');
      const ownerId = (domainOwners ?? owners)?.[0];
      requireCheck(ownerId, 'Owned synthetic user unavailable for I5');
      const baseConcurrency = await activeFence.guard('i5-base-concurrency', () =>
        runBaseConcurrency(runtime!, second!, observer!, c.candidate.runId, ownerId, deadline)
      );
      if (!composition.p6Concurrency && !composition.concurrencySchedules) {
        return result(
          gate,
          [...baseConcurrency.assertions, assertion('P6 concurrency schedules supplied', false)],
          ['P6 concurrency schedules absent'],
          { base: baseConcurrency.evidence }
        );
      }
      let p6Result: GateResult | undefined;
      if (composition.p6Concurrency) {
        const p6Ports =
          typeof composition.p6Concurrency === 'function'
            ? await composition.p6Concurrency(ctx)
            : composition.p6Concurrency;
        p6Result = await activeFence.guard('i5-p6-concurrency', () => qualifyP6Concurrency(p6Ports, deadline));
      }
      const extra = composition.concurrencySchedules
        ? await activeFence.guard('i5-extra-concurrency', () => composition.concurrencySchedules!(ctx))
        : undefined;
      const evidence = {
        base: baseConcurrency.evidence,
        p6: p6Result?.evidence ?? null,
        extra: extra?.evidence ?? null
      };
      await raw('concurrency-i5.json', evidence);
      return result(
        gate,
        [
          ...baseConcurrency.assertions,
          ...(p6Result?.assertions ?? []),
          ...(extra?.assertions ?? [])
        ],
        [...(p6Result?.blocked ?? []), ...(extra?.blocked ?? [])],
        evidence
      );
    }

    if (gate === 'I6') {
      requireCheck(runtime && redisCandidate, 'Owned runtime/redis identities unavailable for I6');
      const ownerId = (domainOwners ?? owners)?.[0];
      requireCheck(ownerId, 'Owned synthetic user unavailable for I6');
      const crashes = await activeFence.guard('i6-crashes', () =>
        runBaseCrashes(runtime!, c.candidate.runId, ownerId, composition.configPath, deadline)
      );
      const queueStall = await activeFence.guard('i6-queue-stall', () =>
        runBaseQueueStall(runtime!, c, ownerId, composition.configPath, redisCandidate!, deadline)
      );
      if (!composition.p6Faults && !composition.faultSchedules) {
        return result(
          gate,
          [...crashes.assertions, ...queueStall.assertions, assertion('P6 fault schedules supplied', false)],
          ['P6 fault schedules absent'],
          { crashes: crashes.evidence, queueStall: queueStall.evidence }
        );
      }
      let p6FaultResult: GateResult | undefined;
      if (composition.p6Faults) {
        const p6FaultPorts =
          typeof composition.p6Faults === 'function'
            ? await composition.p6Faults(ctx)
            : composition.p6Faults;
        p6FaultResult = await activeFence.guard('i6-p6-faults', () => qualifyP6Faults(p6FaultPorts, deadline));
      }
      const extra = composition.faultSchedules
        ? await activeFence.guard('i6-extra-faults', () => composition.faultSchedules!(ctx))
        : undefined;
      const evidence = {
        crashes: crashes.evidence,
        queueStall: queueStall.evidence,
        p6: p6FaultResult?.evidence ?? null,
        extra: extra?.evidence ?? null
      };
      await raw('faults-i6.json', evidence);
      return result(
        gate,
        [
          ...crashes.assertions,
          ...queueStall.assertions,
          ...(p6FaultResult?.assertions ?? []),
          ...(extra?.assertions ?? [])
        ],
        [
          ...queueStall.blocked,
          ...(p6FaultResult?.blocked ?? []),
          ...(extra?.blocked ?? [])
        ],
        evidence
      );
    }

    if (gate === 'I7') {
      if (!composition.separateLoadEvidence) {
        return result(
          gate,
          [assertion('independent load evidence supplied', false)],
          ['Separate 27-minute load qualification evidence absent']
        );
      }
      const { report, accounting } = composition.separateLoadEvidence;
      const loadDurationOk =
        Number.isSafeInteger(report?.durations?.loadMs)
        && report.durations.loadMs >= MINIMUM_INDEPENDENT_LOAD_MS;
      const observationsOk =
        report?.observationsComplete === true
        && report.failure === null
        && report.loadComplete === true
        && report.drainComplete === true;
      const containmentOk =
        report?.containmentComplete === true
        && report.cleanupComplete === true
        && report.pendingWork === 0;
      const runIdOk = accounting?.scope?.runId === c.candidate.runId;
      const neverAccepted =
        report?.runtimeAccepted === false
        && report.liveCapabilityAccepted === false
        && report.productionReady === false;

      let accountingSummary: ReturnType<typeof requireLoadFinalAccounting> | null = null;
      let accountingValid = false;
      try {
        accountingSummary = requireLoadFinalAccounting(accounting);
        accountingValid = accountingSummary.exactSourceContract === true;
      } catch {
        accountingValid = false;
      }

      const blocked: string[] = [];
      if (!loadDurationOk) blocked.push('Independent load duration below 27-minute lifetime requirement');
      if (!observationsOk || !containmentOk) blocked.push('Independent load observations or containment incomplete');
      if (!runIdOk) blocked.push('Independent load runId differs from candidate runId');
      if (!accountingValid) blocked.push('Independent load durable final accounting failed');
      if (!neverAccepted) blocked.push('Independent load cannot self-accept runtime or production readiness');

      const evidence = {
        durations: report?.durations ?? null,
        observationsComplete: report?.observationsComplete ?? false,
        containmentComplete: report?.containmentComplete ?? false,
        runId: accounting?.scope?.runId ?? null,
        accounting: accountingSummary,
        runtimeAccepted: false,
        liveCapabilityAccepted: false,
        productionReady: false
      };
      await raw('load-i7.json', evidence);
      return result(
        gate,
        [
          assertion('independent load exceeds core 10-minute deadline (>= 27 minutes)', loadDurationOk),
          assertion('independent load observations and containment complete', observationsOk && containmentOk),
          assertion('independent load runId matches candidate runId', runIdOk),
          assertion('independent load durable final accounting reconciled', accountingValid),
          assertion('independent load remains non-accepting', neverAccepted)
        ],
        blocked,
        evidence
      );
    }

    // I8
    const allPriorPassed = completedResults.length === 7 && completedResults.every(gatePassed);
    if (!composition.independentAudit) {
      return result(
        gate,
        [
          assertion('all prior gates I1-I7 passed before I8 audit', allPriorPassed),
          assertion('independent I8 audit capability supplied', false)
        ],
        ['Independent I8 audit capability absent'],
        { runtimeAccepted: false, liveCapabilityAccepted: false, productionReady: false }
      );
    }
    const audit = await activeFence.guard('i8-audit', () =>
      composition.independentAudit!([...completedResults], deadline)
    );
    const i8Evidence = {
      gatesVerified: completedResults.map(r => r.gate),
      allPriorGatesPassed: allPriorPassed,
      audit: audit.evidence ?? {},
      runtimeAccepted: false,
      liveCapabilityAccepted: false,
      productionReady: false
    };
    await raw('acceptance-i8.json', i8Evidence);
    return result(
      gate,
      [
        assertion('all prior gates I1-I7 passed before I8 audit', allPriorPassed),
        ...audit.assertions,
        assertion('qualification output remains non-accepting', true)
      ],
      [...(audit.blocked ?? [])],
      i8Evidence
    );
  }

  return {
    inspect: async (c, deadline) => {
      completedResults.length = 0;
      runtime = undefined;
      pooled = undefined;
      second = undefined;
      observer = undefined;
      owners = undefined;
      domainOwners = undefined;
      redisCandidate = undefined;
      fence = createCommitFence(deadline);
      clients = (composition.createClients ?? (d => new OwnedClients(d)))(deadline);
      addresses = await inspectInfra(c, deadline);
    },
    execute: async (gate, c, deadline, raw) => {
      requireCheck(fence, 'Commit fence unavailable after inspection');
      const gateOutcome = await executeGateWithCommitFence(
        gate,
        `execute:${gate}`,
        fence,
        () => fence!.guard(`next-gate:${gate}`, () => runGate(gate, c, deadline, raw)),
        deadline
      );
      completedResults.push(structuredClone(gateOutcome));
      return gateOutcome;
    },
    close: async deadline => {
      if (clients) await clients.close(deadline);
    }
  };
}

export async function runPrivateQualification(
  configPath: string,
  output: string,
  composition: PrivateCoordinatorComposition
) {
  const config = await privateConfig(configPath);
  return runEvidenceQualification(
    config,
    resolve(output),
    createPrivateCoordinatorPorts(config, composition)
  );
}
