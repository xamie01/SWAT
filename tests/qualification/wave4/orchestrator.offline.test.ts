import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  assertion,
  CommitUncertainError,
  createCommitFence,
  executeGateWithCommitFence,
  expectedSqlFailure,
  gatePassed,
  isClientQuarantined,
  isCommitUncertainError,
  qualify,
  quarantineClient,
  result,
  sanitizeFailure,
  transaction,
  validateConfig,
  type QualificationConfig,
  type SqlClient
} from './core.js';
import { Deadline } from './containment.js';
import { runEvidenceQualification } from './evidence-session.js';
import {
  createPrivateCoordinatorPorts,
  runIndependentLoadGate,
  type PrivateCoordinatorComposition
} from './private-adapters.js';
import { ExecutedPipelineCommitUncertainError } from './pipeline-executed.js';
import { FinancialCommitUncertainError } from '../../../packages/db/src/withdrawal-owned.js';
import { financialHash, type FinancialAttempt, type FinancialReceipt, type FinancialRecord } from '../../../packages/db/src/withdrawal-contract.js';
import { reducingIntent, type ReducingIntent } from '../../../packages/db/src/reducing-contract.js';
import type { OwnedFinancialJournal } from './withdrawal-owned-observer.js';
import { loadDigest, loadFixtureRequest, loadReceiptDigest, type LoadFixture } from './load-durable-contract.js';
import type { LoadFinalAccounting } from './load-durable-economics.js';
import { lpJobName, queueIdentity, type QueueJournal } from './queue-contract.js';
import { sourceBindingDigest } from '../../../packages/db/src/source-verification.js';
import type { P6ConcurrencyPorts } from './p6-concurrency-schedules.js';
import type { P6FaultPorts } from './p6-fault-schedules.js';
import { syntheticDeposit, syntheticLpProtocol } from './domains.js';
import { createLpPaperSqlStore } from '../../../packages/db/src/lp-paper-store.js';
import { exercisePaperPipeline } from './pipeline.js';
import { runQualification } from './cli.js';
import { assertPackage28IsolationPreflight } from '../../integration/helpers/package28-isolation.js';

import type { UserScope } from '../../../packages/db/src/tenancy.js';
import { createLpPaperService } from '../../../packages/db/src/lp-paper-service.js';
import { lpPaperFixture } from '../../../packages/db/src/lp-paper-fixture.js';
import { lpRequest } from './domains.js';
import { lpExactHash } from '../../../packages/db/src/lp-exact.js';
import { config } from './offline-fixture.js';
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
describe('main Wave4 offline qualification contracts (not infrastructure evidence)', () => {
  it('accepts only independent bounded canonical declarations', () => { expect(validateConfig(config())).toEqual(config()); });
  it.each(['authorization','shared-container','shared-run','shared-endpoint','unbounded-memory','unbounded-cpu','default-port','remote-host','wrong-runtime','wrong-runtime-target','shared-pool'])(
    'refuses %s before opening or closing infrastructure', async field => {
      const c: any = config();
      if (field === 'authorization') c.authorization = 'yes';
      if (field === 'shared-container') c.reference.postgres.containerId = c.candidate.postgres.containerId;
      if (field === 'shared-run') c.reference = structuredClone(c.candidate);
      if (field === 'shared-endpoint') c.reference.redis.url = c.candidate.redis.url;
      if (field === 'unbounded-memory') c.candidate.postgres.memoryBytes = 0;
      if (field === 'unbounded-cpu') c.candidate.redis.nanoCpus = 0;
      if (field === 'default-port') c.candidate.postgres.url = c.candidate.postgres.url.replace('55432','5432');
      if (field === 'remote-host') c.candidate.redis.url = c.candidate.redis.url.replace('127.0.0.1','example.com');
      if (field === 'wrong-runtime') c.runtimeUrl = c.candidate.postgres.url;
      if (field === 'wrong-runtime-target') c.runtimeUrl = c.runtimeUrl.replace('55432','55439');
      if (field === 'shared-pool') c.pooledRuntimeUrl = c.runtimeUrl;
      const inspect = vi.fn(), execute = vi.fn(), close = vi.fn();
      await expect(qualify(c, { inspect, execute, close })).rejects.toThrow();
      expect(inspect).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    });
  it('inspection failure opens no migration or dependent gates and closes own clients', async () => {
    const execute = vi.fn(), close = vi.fn();
    const r = await qualify(config(), { inspect: async () => { throw new Error('mismatch'); }, execute, close });
    expect(r.runtimeAccepted).toBe(false); expect(execute).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce();
  });
  it.each(['blocked','failed','empty','duplicate','substituted'])('stops dependencies on %s gate evidence', async mode => {
    const execute = vi.fn(async () => mode === 'substituted' ? result('I2', [assertion('ok', true)]) : result('I1',
      mode === 'empty' ? [] : mode === 'duplicate' ? [assertion('same',true),assertion('same',true)] : [assertion('check',mode !== 'failed')],
      mode === 'blocked' ? ['missing actual identity'] : []));
    const r = await qualify(config(), { inspect: async () => {}, execute, close: async () => {} });
    expect(r.runtimeAccepted).toBe(false); expect(execute).toHaveBeenCalledOnce(); expect(r.unexecuted).toContain('I3');
  });
  it('shutdown failure cannot become acceptance', async () => {
    const r = await qualify(config(), { inspect: async () => {}, execute: async gate => result(gate,[assertion('mock',true)]), close: async () => { throw new Error('close'); } });
    expect(r.runtimeAccepted).toBe(false); expect(r.productionReady).toBe(false);
  });
  it('gate pass requires literal true, nonempty unique assertions and no blocked capability', () => {
    expect(gatePassed(result('I1',[assertion('truthy',1)]))).toBe(false);
    expect(gatePassed(result('I1',[assertion('true',true)]))).toBe(true);
  });
  it('transaction returns only after actual COMMIT response', async () => {
    const calls: string[] = [];
    const client = { query: async (sql: string) => { calls.push(sql); return { rows: [], command: sql }; } };
    expect(await transaction(client, null, async () => { calls.push('action'); return 'value'; })).toBe('value');
    expect(calls.at(-1)).toBe('COMMIT'); expect(calls.indexOf('action')).toBeLessThan(calls.indexOf('COMMIT'));
  });
  it.each(['commit-reject','rollback-command','action-reject'])('%s retains uncertainty and prevents downstream enqueue', async mode => {
    const enqueue = vi.fn(), calls: string[] = [];
    const client = { query: async (sql: string) => { calls.push(sql);
      if (sql === 'COMMIT' && mode === 'commit-reject') throw new Error('disconnected');
      return { rows: [], command: sql === 'COMMIT' && mode === 'rollback-command' ? 'ROLLBACK' : sql }; } };
    await expect(transaction(client, null, async () => { if (mode === 'action-reject') throw new Error('failed'); return 'descriptor'; }).then(enqueue)).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe(mode === 'action-reject' ? 'ROLLBACK' : 'COMMIT');
    expect(calls.includes('ROLLBACK')).toBe(mode === 'action-reject');
  });
  it('SQL negative checks reject unrelated connection failures as proof', async () => {
    const client = { query: vi.fn(async (_sql: string) => ({ rows: [] })) };
    expect(await expectedSqlFailure(client, async () => { throw { code: 'ECONNRESET' }; }, ['P0001'])).toBe(false);
    expect(await expectedSqlFailure(client, async () => { throw { code: 'P0001' }; }, ['P0001'])).toBe(true);
    expect(client.query.mock.calls.map(c => c[0])).toContain('ROLLBACK TO SAVEPOINT qualification_negative');
  });
  it('LP SQL store construction and injected transactions never require ambient DATABASE_URL', () => {
    expect(createLpPaperSqlStore()).toBeDefined(); expect(createLpPaperSqlStore(vi.fn())).toBeDefined();
  });
  it('synthetic provider quotes exact fractional values and cannot sign or submit', async () => {
    const provider = syntheticLpProtocol(config().candidate.runId);
    const q = await provider.quote({ userId: 'alice', chain: 'solana', poolAddress: 'solana:wave4-pool', depositAsset: 'solana:wave4-mint',
      deposit: syntheticDeposit, action: 'close', intentHash: 'a'.repeat(64), positionId: null, positionRevision: null });
    expect(q!.valueMicroUsd).toBe('1111999096'); expect(q!.amountAfter).toEqual({ raw:'0',scale:18 });
    expect(Object.keys(provider).sort()).toEqual(['networks','providerId','quote','receipt']);
  });
  it('Package28 still refuses even canonical valid declarations', () => {
    const c = config().candidate;
    expect(() => assertPackage28IsolationPreflight({ INTEGRATION_DISPOSABLE:'true',INTEGRATION_RUN_ID:c.runId,SWAT_DB_PROFILE:'core',
      INTEGRATION_DATABASE_URL:c.postgres.url,INTEGRATION_REDIS_URL:c.redis.url,INTEGRATION_REDIS_NAMESPACE:`swat:integration:${c.runId}` })).toThrow(/unavailable/);
  });
  it('fault controller targets only newly owned child and no database/container service kill', () => {
    const text = source('faults.ts');
    expect(text).toContain("child.kill('SIGKILL')"); expect(text).toContain("signal === 'SIGKILL' && point === input.point && !ack");
    expect(text).not.toMatch(/process\.kill|pkill|pg_terminate_backend|docker.*(?:kill|stop|restart)|FLUSHALL/);
  });
  it('even complete injected gate results cannot self-accept runtime', async () => {
    const r = await qualify(config(), { inspect: async () => {}, execute: async gate => result(gate,[assertion('injected',true)]), close: async () => {} });
    expect(r.observedGatesComplete).toBe(true); expect(r.runtimeAccepted).toBe(false);
  });
  it('pipeline positive execution remains refused before dynamic ambient imports', async () => {
    await expect(exercisePaperPipeline(undefined as any)).rejects.toThrow(/unavailable/);
  });
  it('runtime entrypoint is wired to explicit refusal rather than the migration draft', () => {
    expect(runQualification).toBeTypeOf('function');
    const text = source('cli.ts');
    expect(text.slice(text.indexOf('export async function runQualification'), text.indexOf('async function runDraftQualification'))).toContain("throw new Error('Wave4 real execution is unavailable");
  });
  it('fixture seeding refuses missing canonical LP grants before inserts', () => {
    const text = source('domains.ts');
    expect(text.indexOf('Canonical base LP DML privileges unavailable')).toBeLessThan(text.indexOf('INSERT INTO users'));
    expect(text).not.toMatch(/GRANT |ALTER ROLE|CREATE POLICY/);
  });
  it('same-operation synthetic receipts are immutable across provider instances', async () => {
    const provider = syntheticLpProtocol(config().candidate.runId);
    const quote = await provider.quote({ userId:'alice',chain:'solana',poolAddress:'solana:wave4-pool',depositAsset:'solana:wave4-mint',deposit:syntheticDeposit,action:'close',intentHash:'a'.repeat(64),positionId:null,positionRevision:null });
    const input: any = { operation:{ id:'operation',userId:'alice',positionId:'position',positionRevision:'0',receiptKey:'key',action:'close',quote,amountBefore:syntheticDeposit },
      position:{chain:'solana',protocol:'meteora-dlmm',poolAddress:'solana:wave4-pool',depositAsset:'solana:wave4-mint'} };
    expect(await provider.receipt(input)).toEqual(await syntheticLpProtocol(config().candidate.runId).receipt(input));
  });
  it('child close and settled competing transactions precede fault results', () => {
    const text = source('faults.ts');
    expect(text).toContain("child.once('close'"); expect(text).toContain('Promise.allSettled');
    expect(text).toContain('message.operationId === input.operationId');
    expect(text).toContain('child.send(input, error');
  });
  it('child verifies its own runtime backend before processing', () => {
    const text = source('worker-child.ts');
    expect(text.indexOf('Child runtime backend differs')).toBeLessThan(text.indexOf('const outcome = await service.process'));
  });
  it('Wave4 synthetic provider supports receipt rebalance then close with exact cumulative economics in a fixture', async () => {
    const plan = async (quote: any, strategy: any) => ({version:2 as const,protocol:quote.pool.protocol,strategy,poolEvidenceId:quote.pool.evidenceId,
      rungs:[{priceLower:strategy.rangeLower,priceUpper:strategy.rangeUpper,allocation:quote.amountAfter,binLower:1,binUpper:2}]});
    const fixture = lpPaperFixture(plan);
    const service = createLpPaperService({...fixture.deps,now:()=>new Date(),protocol:syntheticLpProtocol(config().candidate.runId)});
    const scope = {userId:'alice'} as UserScope, request = lpRequest(config().candidate.runId);
    const position = await service.acquire(scope,request);
    const rebalance = await service.requestOperation(scope,{positionId:position.id,operationKey:'rebalance',action:'rebalance',automatic:true});
    await service.process(scope,{operationId:rebalance.operation.id,chain:'solana'});
    const saved = await service.position(scope,position.id);
    expect(saved?.revision).toBe('1'); expect(saved?.realizedMicroUsd).toBeNull();
    await service.process(scope,{operationId:rebalance.operation.id,chain:'solana'});
    expect(lpExactHash(await service.position(scope,position.id))).toBe(lpExactHash(saved));
    const close = await service.requestOperation(scope,{positionId:position.id,operationKey:'close',action:'close'});
    await service.process(scope,{operationId:close.operation.id,chain:'solana'});
    expect(await service.position(scope,position.id)).toMatchObject({state:'closed',revision:'2',realizedMicroUsd:'100000',
      cumulativeFeesMicroUsd:'200000',cumulativeCostsMicroUsd:'100000',currentAmount:{raw:'0',scale:18}});
  });
  it('child has write-ahead and postcommit pre-ack kill points and independent durable re-read', () => {
    const text = source('worker-child.ts');
    expect(text).toContain("sql === 'COMMIT' && writes && input.point === 'before-settlement-commit'");
    expect(text).toContain("sql === 'COMMIT' && writes && input.point === 'after-settlement-commit-before-ack'");
    expect(text.indexOf('Durable completion journal required before ack')).toBeLessThan(text.indexOf("kind: 'ack'"));
  });
});

async function withOutputDir(action: (dir: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'swat-p8-orch-'));
  try {
    await action(join(root, 'run'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OP_ID = '33333333-3333-4333-8333-333333333333';
const POS_ID = '44444444-4444-4444-8444-444444444444';
const INTENT_ID = '55555555-5555-4555-8555-555555555555';
const ATTEMPT_ID = '66666666-6666-4666-8666-666666666666';
const RECEIPT_ID = '77777777-7777-4777-8777-777777777777';
const EXECUTION_ID = '88888888-8888-4888-8888-888888888888';

function validLoadAccounting(runId: string): LoadFinalAccounting {
  const FIXTURE = '99999999-9999-4999-8999-999999999999';
  const SOURCE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SIGNAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const EVIDENCE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const TRADE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const LOT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const HTTP_ATTEMPT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const at = '2026-11-24T00:00:00.000Z';
  const scope = {
    runId,
    namespace: `wave4-load-${runId}`,
    network: `solana:wave4-${runId}`,
    backendIdentity: 'inert-owned-backend-not-approval'
  };
  const walletAddress = 'solana:11111111111111111111111111111111';
  const tokenMint = 'solana:11111111111111111111111111111112';
  const fixture: LoadFixture = {
    scope,
    fixtureId: FIXTURE,
    userId: TENANT_A,
    kind: 'wallet',
    walletAddress,
    tokenMint,
    targetAccount: walletAddress,
    binding: {
      chain: 'solana',
      network: scope.network,
      sourceEventType: 'transaction',
      sourceEventId: `${scope.namespace}/${FIXTURE}`,
      sourceEventIndex: '0',
      transactionHash: `${scope.namespace}/${FIXTURE}`,
      walletAddress,
      tokenMint,
      side: 'buy',
      rawQuantity: '9007199254740993000000000000000001',
      quantityScale: 18,
      eventAt: at,
      amountUsd: '1',
      priceUsd: null,
      feeUsd: '0'
    },
    base: { raw: '9007199254740993000000000000000002', scale: 18 },
    quoteBudget: { raw: '124000000000000000000', scale: 18 },
    quote: { raw: '123456789012345678901', scale: 18 },
    fee: { raw: '1', scale: 18 },
    requestDigest: ''
  };
  (fixture as { requestDigest: string }).requestDigest = loadDigest(loadFixtureRequest(fixture));
  const base = '9007199254740993.000000000000000002';
  const quote = '123.456789012345678901';
  const fee = '0.000000000000000001';
  const debit = '123.456789012345678902';
  const jobId = `source-trade-${SIGNAL}-u-${TENANT_A}`;
  const attempt = {
    attemptId: HTTP_ATTEMPT,
    fixtureId: FIXTURE,
    runId,
    namespace: scope.namespace,
    userId: TENANT_A,
    requestDigest: fixture.requestDigest,
    route: '/v1/me/wallets' as const,
    status: 201,
    startedAt: at,
    finishedAt: at
  };
  const admission = {
    attemptId: HTTP_ATTEMPT,
    fixtureId: FIXTURE,
    runId,
    namespace: scope.namespace,
    userId: TENANT_A,
    requestDigest: fixture.requestDigest,
    outcome: 'admitted' as const,
    reason: null,
    sourceTradeId: SOURCE,
    signalId: SIGNAL,
    executionId: EXECUTION_ID,
    jobId,
    admittedAt: at
  };
  const snapshot = {
    executionId: EXECUTION_ID,
    userId: TENANT_A,
    tradeId: TRADE,
    fence: '1',
    totals: {
      base,
      quote,
      debit,
      fee,
      unknown: '0',
      quoteUnknown: '0',
      completes: true,
      evidenceCount: '1',
      invalidCorrections: '0'
    },
    accountingComplete: true
  };
  return {
    scope,
    fixtures: [fixture],
    attempts: [attempt],
    admissions: [admission],
    durable: {
      scope,
      sources: [
        {
          id: SOURCE,
          binding: fixture.binding,
          bindingDigest: sourceBindingDigest(fixture.binding),
          accepted: true,
          evidenceId: 'inert-protected-source',
          finality: 'confirmed',
          applicationActive: true
        }
      ],
      executions: [
        {
          id: EXECUTION_ID,
          signalId: SIGNAL,
          sourceTradeId: SOURCE,
          userId: TENANT_A,
          targetAccount: walletAddress,
          chain: 'solana',
          tokenMint,
          direction: 'buy',
          executionMode: 'paper',
          state: 'confirmed',
          requestedBase: null,
          requestedQuote: '124',
          confirmedBase: base,
          confirmedQuote: quote,
          quoteUnknown: '0'
        }
      ],
      deliveries: [
        {
          executionId: EXECUTION_ID,
          signalId: SIGNAL,
          userId: TENANT_A,
          targetAccount: walletAddress,
          executionMode: 'paper',
          jobId,
          state: 'completed',
          fence: '1',
          descriptor: {
            chain: 'solana',
            options: { jobId },
            data: {
              copyExecutionId: EXECUTION_ID,
              signalId: SIGNAL,
              sourceTradeId: SOURCE,
              userId: TENANT_A,
              chain: 'solana',
              tokenMint,
              targetAccount: walletAddress,
              masterWalletAddress: walletAddress,
              executionMode: 'paper',
              direction: 'buy',
              requestedBaseQuantity: null,
              requestedQuoteQuantity: '124',
              exitLotId: null,
              score: 90
            }
          }
        }
      ],
      workerAttempts: [
        { executionId: EXECUTION_ID, userId: TENANT_A, fence: '1', policyRevision: 'inert-policy', riskEpoch: '1', state: 'settled' }
      ],
      evidence: [
        {
          id: EVIDENCE,
          executionId: EXECUTION_ID,
          userId: TENANT_A,
          sourceTradeId: SOURCE,
          evidenceId: 'inert-original-paper-receipt',
          evidenceType: 'paper_simulation',
          confirmationState: 'confirmed',
          completes: true,
          base,
          quote,
          fee,
          quoteCurrency: 'USD',
          nativeQuote: quote,
          nativePrice: '1',
          effectiveQuote: quote,
          effectiveFee: fee,
          correctionId: null,
          applicationActive: true
        }
      ],
      trades: [
        {
          id: TRADE,
          executionId: EXECUTION_ID,
          userId: TENANT_A,
          signalId: SIGNAL,
          sourceTradeId: SOURCE,
          tokenMint,
          chain: 'solana',
          direction: 'buy',
          executionMode: 'paper',
          base,
          quote,
          fee,
          status: 'filled'
        }
      ],
      receipts: [{ receiptId: loadReceiptDigest(snapshot), snapshot }],
      applications: [
        {
          evidenceId: EVIDENCE,
          executionId: EXECUTION_ID,
          positionId: POS_ID,
          userId: TENANT_A,
          targetAccount: walletAddress,
          tokenMint,
          chain: 'solana',
          active: true
        }
      ],
      positions: [
        { id: POS_ID, userId: TENANT_A, targetAccount: walletAddress, tokenMint, chain: 'solana', base, basis: debit }
      ],
      lots: [
        {
          id: LOT,
          positionId: POS_ID,
          userId: TENANT_A,
          tokenMint,
          chain: 'solana',
          masterWalletAddress: walletAddress,
          acquisitionExecutionId: EXECUTION_ID,
          acquisitionEvidenceId: EVIDENCE,
          acquisitionSourceTradeId: SOURCE,
          acquisitionMode: 'paper',
          acquiredBase: base,
          remainingBase: base,
          acquiredBasis: debit,
          remainingBasis: debit
        }
      ],
      risk: [
        {
          executionId: EXECUTION_ID,
          account: TENANT_A,
          epoch: '1',
          state: 'confirmed',
          debit,
          liability: debit,
          chain: 'solana',
          executionMode: 'paper'
        }
      ],
      capacity: [
        {
          sourceTradeId: SOURCE,
          executionMode: 'paper',
          notional: quote,
          chain: 'solana',
          tokenMint,
          masterWalletAddress: walletAddress
        }
      ],
      corrections: [],
      reductions: []
    }
  };
}

function validFinancialJournal(outcome: 'cancelled' | 'settled'): OwnedFinancialJournal<ReducingIntent> {
  const intent = reducingIntent(
    TENANT_A,
    {
      requestKey: `reduce-${outcome}`,
      chain: 'polygon',
      network: 'polygon:137',
      venue: 'polymarket-perps',
      positionId: 'pos-1',
      accountId: 'acc-1',
      assetId: 'USDC',
      assetScale: 6,
      mode: 'paper',
      positionSide: 'LONG',
      quantityRaw: '100',
      maxFeeRaw: '5',
      feeAssetId: 'USDC',
      feeAssetScale: 6,
      feeFundingAccountId: 'fee-1',
      limitPriceExact: '1.0',
      expectedRevision: '1'
    },
    '2026-12-01T00:00:00.000Z'
  );
  const intentHash = financialHash(intent);
  if (outcome === 'cancelled') {
    const record: FinancialRecord<ReducingIntent> = {
      id: INTENT_ID,
      userId: TENANT_A,
      intent,
      intentHash,
      status: 'cancelled',
      completedRaw: '0',
      terminal: true,
      createdAt: '2026-11-24T00:00:00.000Z',
      cancellationReason: 'user-cancelled'
    };
    return {
      record,
      attempts: [],
      receipts: [],
      applications: [],
      reservations: [{ budgetKey: 'k1', amountRaw: '100', feeRaw: '5', reservedRaw: '0' }],
      outbox: [{ intentHash }],
      authorization: []
    };
  }
  const record: FinancialRecord<ReducingIntent> = {
    id: INTENT_ID,
    userId: TENANT_A,
    intent,
    intentHash,
    status: 'settled',
    completedRaw: '100',
    terminal: true,
    createdAt: '2026-11-24T00:00:00.000Z',
    cancellationReason: null
  };
  const attempt: FinancialAttempt = {
    id: ATTEMPT_ID,
    intentId: INTENT_ID,
    userId: TENANT_A,
    intentHash,
    clientOrderId: 'order-1',
    state: 'settled',
    completedRaw: '100',
    completedFeeRaw: '2',
    terminal: true
  };
  const receipt: FinancialReceipt = {
    receiptId: RECEIPT_ID,
    providerIdentity: 'inert-provider',
    proof: 'inert-proof',
    intentId: INTENT_ID,
    intentHash,
    attemptId: ATTEMPT_ID,
    clientOrderId: 'order-1',
    cumulativeRaw: '100',
    feeRaw: '2',
    feeAssetId: 'USDC',
    feeAssetScale: 6,
    feeFundingAccountId: 'fee-1',
    terminal: true,
    outcome: 'fill',
    observedAt: '2026-11-24T00:01:00.000Z'
  };
  return {
    record,
    attempts: [attempt],
    receipts: [{ receipt, hash: financialHash(receipt) }],
    applications: [{ receiptId: RECEIPT_ID, attemptId: ATTEMPT_ID, deltaRaw: '100', accountingReference: 'acct-ref-1' }],
    reservations: [{ budgetKey: 'k1', amountRaw: '100', feeRaw: '0', reservedRaw: '0' }],
    outbox: [{ intentHash }],
    authorization: []
  };
}

function validCompletedQueueJournal(runId: string): {
  journal: QueueJournal;
  input: { runId: string; userId: string; operationId: string };
  jobId: string;
} {
  const input = { runId, userId: TENANT_A, operationId: OP_ID };
  const identity = queueIdentity(input);
  const amount = syntheticDeposit;
  const zero = { raw: '0', scale: 18 };
  const basis = (BigInt(amount.raw) * 1234567n / 10n ** 18n).toString();
  const acquisitionFingerprint = lpExactHash({
    chain: 'solana',
    poolAddress: 'solana:wave4-pool',
    depositAsset: 'solana:wave4-mint',
    deposit: amount,
    strategy: { distribution: 'spot', rangeLower: 90, rangeUpper: 110, rungCount: 1 },
    autoRebalance: true,
    origin: null
  });
  const fingerprint = lpExactHash({
    positionId: POS_ID,
    action: 'close',
    revision: '0',
    amountBefore: amount,
    chain: 'solana',
    poolAddress: 'solana:wave4-pool',
    depositAsset: 'solana:wave4-mint'
  });
  const observedAt = '2026-11-24T00:00:00.000Z';
  const acquisitionQuote = {
    version: 1,
    action: 'acquire',
    mode: 'paper',
    userId: TENANT_A,
    providerId: `wave4-${runId}`,
    intentHash: acquisitionFingerprint,
    quoteId: 'q-acq',
    pool: {
      chain: 'solana',
      networkId: `solana:wave4-${runId}`,
      protocol: 'meteora-dlmm',
      poolAddress: 'solana:wave4-pool',
      depositAsset: 'solana:wave4-mint',
      depositScale: 18
    },
    deposit: amount,
    amountAfter: amount,
    proceedsMicroUsd: '0',
    valueMicroUsd: basis,
    unitPriceUsd: { raw: '1234567', scale: 6 }
  };
  const closeQuote = {
    version: 1,
    action: 'close',
    mode: 'paper',
    userId: TENANT_A,
    providerId: `wave4-${runId}`,
    intentHash: fingerprint,
    quoteId: 'q-close',
    pool: {
      chain: 'solana',
      networkId: `solana:wave4-${runId}`,
      protocol: 'meteora-dlmm',
      poolAddress: 'solana:wave4-pool',
      depositAsset: 'solana:wave4-mint',
      depositScale: 18
    },
    deposit: amount,
    amountAfter: zero,
    proceedsMicroUsd: basis,
    valueMicroUsd: basis,
    unitPriceUsd: { raw: '1234567', scale: 6 },
    observedAt
  };
  const operationKey = `bullmq-close-${runId}`;
  const receiptKey = `lp-receipt-${lpExactHash([TENANT_A, operationKey, fingerprint])}`;
  const receipt = {
    version: 1,
    providerId: `wave4-${runId}`,
    receiptId: `receipt-${OP_ID}`,
    receiptKey,
    userId: TENANT_A,
    positionId: POS_ID,
    positionRevision: '0',
    mode: 'paper',
    action: 'close',
    networkId: `solana:wave4-${runId}`,
    chain: 'solana',
    protocol: 'meteora-dlmm',
    poolAddress: 'solana:wave4-pool',
    depositAsset: 'solana:wave4-mint',
    quoteId: closeQuote.quoteId,
    quoteHash: lpExactHash(closeQuote),
    amountBefore: amount,
    amountAfter: zero,
    proceedsMicroUsd: basis,
    collectedFeesMicroUsd: '100000',
    executionCostsMicroUsd: '50000',
    settledAt: observedAt,
    finality: 'paper-settled'
  };
  const operation = {
    id: OP_ID,
    userId: TENANT_A,
    positionId: POS_ID,
    operationKey,
    action: 'close',
    positionRevision: '0',
    amountBefore: amount,
    fingerprint,
    quote: closeQuote,
    receiptKey,
    status: 'completed',
    receipt
  };
  const acquisition = {
    id: POS_ID,
    userId: TENANT_A,
    acquisitionKey: identity.acquisitionKey,
    mode: 'paper',
    chain: 'solana',
    protocol: 'meteora-dlmm',
    poolAddress: 'solana:wave4-pool',
    depositAsset: 'solana:wave4-mint',
    deposit: amount,
    currentAmount: amount,
    revision: '0',
    state: 'active',
    cumulativeFeesMicroUsd: '0',
    cumulativeCostsMicroUsd: '0',
    realizedMicroUsd: null,
    acquisitionFingerprint,
    autoRebalance: true,
    copyOrigin: null,
    acquisitionQuote,
    depositMicroUsd: basis
  };
  const position = {
    id: POS_ID,
    userId: TENANT_A,
    acquisitionKey: identity.acquisitionKey,
    deposit: amount,
    depositMicroUsd: basis,
    acquisitionQuote,
    revision: '1',
    state: 'closed',
    cumulativeFeesMicroUsd: '100000',
    cumulativeCostsMicroUsd: '50000',
    realizedMicroUsd: '50000',
    currentAmount: zero,
    lastReceiptKey: receiptKey
  };
  const receiptRow = {
    receipt_hash: lpExactHash(receipt),
    data: receipt,
    operation_id: OP_ID,
    position_id: POS_ID,
    user_id: TENANT_A,
    receipt_key: receiptKey,
    provider_id: receipt.providerId,
    receipt_id: receipt.receiptId
  };
  return {
    input,
    jobId: identity.jobId,
    journal: {
      operationId: OP_ID,
      userId: TENANT_A,
      positionId: POS_ID,
      acquisitionKey: identity.acquisitionKey,
      status: 'completed',
      raw: '0',
      revision: '1',
      receipts: '1',
      fees: '100000',
      costs: '50000',
      realized: '50000',
      operation,
      position,
      receipt,
      acquisition,
      receiptRow,
      legacyState: 'closed',
      legacy: { id: POS_ID, user_id: TENANT_A, state: 'closed' },
      history: [
        { position_id: POS_ID, from_state: null, to_state: 'building' },
        { position_id: POS_ID, from_state: 'building', to_state: 'active' },
        { position_id: POS_ID, from_state: 'active', to_state: 'closed' }
      ]
    }
  };
}

function buildInertComposition(
  cfg: QualificationConfig,
  overrides: Partial<PrivateCoordinatorComposition> = {}
): {
  composition: PrivateCoordinatorComposition;
  spies: { p6ConcurrencyCalled: () => boolean; p6FaultsCalled: () => boolean; closed: () => boolean };
} {
  let p6ConcurrencyRan = false;
  let p6FaultsRan = false;
  let closed = false;

  const mockClient = (label: string): SqlClient => ({
    query: async (sql: string) => {
      if (sql.includes('inet_server_addr')) {
        return {
          command: 'SELECT',
          rows: [{ address: '127.0.0.10', port: 5432, database: `swat_integration_${cfg.candidate.runId.replaceAll('-', '')}` }]
        };
      }
      return { command: sql.split(' ')[0] ?? 'SELECT', rows: [{ label }] };
    }
  });

  const makeInstallation = (runId: string, address: string, systemIdentifier: string) => ({
    target: {
      database: `swat_integration_${runId.replaceAll('-', '')}`,
      address,
      port: 5432,
      systemIdentifier
    },
    dbaRole: 'dba_admin',
    acquireDba: async () => ({ client: mockClient('dba') as any, release: () => {} })
  });

  const p6ConcurrencyPorts: P6ConcurrencyPorts = {
    competingClaims: {
      runId: cfg.candidate.runId,
      userId: TENANT_A,
      runClaim: async runner => {
        p6ConcurrencyRan = true;
        return {
          created: runner === 'first',
          claimed: runner === 'first',
          execution: { id: EXECUTION_ID }
        } as any;
      },
      claimInput: {} as any,
      submitWithdrawalRace: async () => [
        { status: 'fulfilled', value: { ok: true } },
        { status: 'rejected', reason: new Error('otp-consumed') }
      ],
      withdrawalSubmit: {} as any,
      requestReducingRace: async () => [
        { status: 'fulfilled', value: { id: INTENT_ID, intentHash: 'a'.repeat(64) } as any },
        { status: 'fulfilled', value: { id: INTENT_ID, intentHash: 'a'.repeat(64) } as any }
      ],
      reducingRequest: {} as any,
      runFinancialRace: async () => [
        { status: 'fulfilled', value: {} as any },
        { status: 'fulfilled', value: {} as any }
      ],
      observeCounts: async () => ({
        executions: 1,
        deliveries: 1,
        otpConsumedCount: 1,
        intents: 1,
        attempts: 1,
        reservations: 1
      })
    },
    tenantInterference: {
      tenantA: TENANT_A,
      tenantB: TENANT_B,
      probeGucAndIsolation: async () => ({
        tenantAOnlyVisibleToA: true,
        tenantBBlockedFromAExecution: true,
        tenantBBlockedFromACustody: true,
        tenantBBlockedFromALot: true,
        pooledGucResetAfterCommitAndRollback: true
      }),
      raceBudgetDrain: async () => ({
        firstCommitted: true,
        secondRejectedInsufficient: true,
        reservedRaw: '100',
        availableRaw: '100'
      }),
      attackForeignFeeAndLot: async () => ({
        foreignFeeAccountRejected: true,
        foreignLotRejected: true
      })
    },
    expiryCancelFeeOnly: {
      runPostLockExpiry: async () => ({
        pipelineExpiredAfterLockRejected: true,
        pipelineInsertedCount: 0,
        financialExpiredAuthRejected: true,
        financialDispatchedCount: 0
      }),
      raceCancelVsSettlement: async winner => ({
        winnerOutcome: winner === 'cancel' ? 'cancelled' : 'settled',
        loserBlockedOrNoop: true,
        conserved: true,
        journal: validFinancialJournal(winner === 'cancel' ? 'cancelled' : 'settled')
      }),
      runFeeOnlyAndZeroBaseCases: async () => ({
        perpsFeeOnlyConserved: true,
        perpsAfterRawZero: true,
        valuationFeeOnlyComplete: true,
        valuationOriginalFeeStillNull: true,
        spotZeroBaseRefusedBeforeSql: true,
        spotZeroDeltaRefusedBeforeSql: true
      })
    }
  };

  const completedQ = validCompletedQueueJournal(cfg.candidate.runId);
  const p6FaultPorts: P6FaultPorts = {
    redisDrop: {
      simulatePreEnqueueRedisDrop: async () => {
        p6FaultsRan = true;
        return { enqueueRejected: true, durablePendingPreserved: true, recoveredOnce: true, finalReceipts: 1 };
      },
      simulateMidWaitRedisDrop: async () => ({ waitRejectedBounded: true, connectionsDisconnected: true }),
      simulatePostCommitRedisDrop: async () => ({
        committedHashBefore: 'abc',
        committedHashAfter: 'abc',
        receipts: 1
      })
    },
    preCommitCrash: {
      simulatePipelinePreCommitCrash: async () => ({
        preCommitRolledBack: true,
        zeroPartialRowsAfterCrash: true,
        retrySingleExecution: true,
        retrySingleReceipt: true
      }),
      simulatePipelineAmbiguousCommit: async () => ({
        threwCommitUncertain: true,
        didNotEmitRollback: true,
        leaseQuarantined: true
      }),
      simulateFinancialPreCommitAndFenceCrash: async () => ({
        prePrepareRolledBack: true,
        postFenceRetryDidNotResubmit: true,
        submitCallCount: 1,
        applicationCount: 1,
        conserved: true,
        journal: validFinancialJournal('settled')
      })
    },
    bullMqUnack: {
      input: completedQ.input,
      simulateUnackRedelivery: async () => ({
        beforeJournal: completedQ.journal,
        afterJournal: completedQ.journal,
        retainedJob: {
          id: completedQ.jobId,
          name: lpJobName,
          data: { userId: TENANT_A, operationId: OP_ID, chain: 'solana' },
          attemptsStarted: 2,
          stalledCounter: 1
        },
        finalState: 'completed',
        stream: [
          { event: 'active', jobId: completedQ.jobId },
          { event: 'stalled', jobId: completedQ.jobId },
          { event: 'active', jobId: completedQ.jobId },
          { event: 'completed', jobId: completedQ.jobId }
        ]
      })
    }
  };

  const accounting = validLoadAccounting(cfg.candidate.runId);
  const composition: PrivateCoordinatorComposition = {
    configPath: '/inert/private-config.json',
    createClients: () => ({
      postgres: async (_url, name) => mockClient(name),
      redis: async (_url, name) => ({ name }),
      close: async () => { closed = true; }
    }),
    inspectInfrastructure: async () => ({
      reference: { postgres: '127.0.0.11', redis: '127.0.0.12' },
      candidate: { postgres: '127.0.0.10', redis: '127.0.0.13' }
    }),
    bindPostgres: async (_client, e) => (e.runId === cfg.reference.runId ? '100001' : '100002'),
    bindRedis: async (_client, addr) => (addr === '127.0.0.12' ? 'a'.repeat(40) : 'b'.repeat(40)),
    migratePristine: async () => ({ files: [], digest: 'd'.repeat(64) } as any),
    catalog: async () => ({
      digest: 'c'.repeat(64),
      sourceDigest: 's'.repeat(64),
      journalDigest: 'j'.repeat(64),
      journal: [],
      ddl: '',
      roles: {}
    }),
    canonicalMigrationSource: async () => {
      const sql = readFileSync(new URL('../../../packages/db/sql/087_wave4_protected_authentication.sql', import.meta.url), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      return {
        files: [{ file: '087_wave4_protected_authentication.sql', sql, checksum }],
        digest: 's'.repeat(64)
      } as any;
    },
    authentication: {
      reference: makeInstallation(cfg.reference.runId, '127.0.0.11', '100001'),
      candidate: makeInstallation(cfg.candidate.runId, '127.0.0.10', '100002'),
      activation: { activateExternally: async () => {}, expiresAt: new Date(Date.now() + 60_000) },
      qualification: { overlapObservation: 'postgres-blocking-edge' } as any
    },
    activateAuthentication: async () => {},
    qualifyAuthentication: async () => ({
      scenario: 'protected-authentication-signup-password-session-wallet-races',
      boundary: { sourceImplemented: true, runtimeAccepted: false, liveAccepted: false, productionReady: false },
      users: [TENANT_A, TENANT_B],
      facts: {},
      schedules: [1, 2, 3, 4, 5],
      observation: 'postgres-blocking-edge',
      blocked: []
    } as any),
    qualifyRoles: async () => result('I2', [assertion('seven domain tables force tenant RLS', true)], []),
    pipelinePreflight: async () => result('I3', [assertion('direct authenticated swat_app runtime identity', true)], []),
    pgbouncerInspect: async () => ({ assertions: [assertion('pgbouncer transaction pool isolated', true)], blocked: [] }),
    pipeline: () => ({} as any),
    executePipeline: async () => ({
      journal: { kind: 'canonical-executed-paper-pipeline', snapshots: [1, 2, 3, 4, 5], scope: { runId: cfg.candidate.runId } } as any,
      economics: {
        runtimeAccepted: false,
        sourceComplete: false,
        liveCapabilityAccepted: false,
        exactJournalDigest: 'f'.repeat(64),
        stages: ['buy', 'sell', 'reversal', 'correction', 'replay'],
        finalPosition: {}
      }
    }),
    seedOwners: async () => [TENANT_A, TENANT_B],
    qualifyBaseDomains: async () => result('I4', [assertion('base LP domains passed', true)], []),
    domains: {
      custody: async () => ({ assertions: [assertion('custody metadata-only grant projection', true)] }),
      withdrawal: async () => ({ assertions: [assertion('withdrawal one-use OTP and 24h cooling', true)] }),
      reducing: async () => ({ assertions: [assertion('reducing non-impersonating conservation', true)] }),
      lpCopy: async () => ({ assertions: [assertion('LP copy ONE-CLOSE boundary preserved', true)] })
    },
    qualifyBaseConcurrency: async () => result('I5', [assertion('base rollback concurrency passed', true)], []),
    p6Concurrency: p6ConcurrencyPorts,
    qualifyBaseCrashes: async () => result('I6', [assertion('base worker crashes passed', true)], []),
    qualifyBaseQueueStall: async () => result('I6', [assertion('base queue stall passed', true)], []),
    p6Faults: p6FaultPorts,
    separateLoadEvidence: {
      accounting,
      report: {
        value: accounting,
        failure: null,
        loadComplete: true,
        drainComplete: true,
        cleanupComplete: true,
        pendingWork: 0,
        containmentComplete: true,
        durations: { loadMs: 27 * 60_000, drainMs: 60_000 },
        observationsComplete: true,
        runtimeAccepted: false,
        liveCapabilityAccepted: false,
        productionReady: false
      }
    },
    independentAudit: async results => ({
      assertions: [assertion('independent I8 audit reviewed all 7 gates', results.length === 7)],
      evidence: { reviewedGates: results.map(r => r.gate) }
    }),
    ...overrides
  };

  return {
    composition,
    spies: {
      p6ConcurrencyCalled: () => p6ConcurrencyRan,
      p6FaultsCalled: () => p6FaultsRan,
      closed: () => closed
    }
  };
}

describe('M5 P8 private coordinator adapters, ambiguous-COMMIT fences and sanitized failure artifacts', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('executes concrete I1-I8 adapters sequentially with P6 schedules and records evidence without self-accepting', async () =>
    withOutputDir(async dir => {
      const cfg = config();
      const { composition, spies } = buildInertComposition(cfg);
      const report = await runEvidenceQualification(cfg, dir, createPrivateCoordinatorPorts(cfg, composition));

      expect(report.observedGatesComplete).toBe(true);
      expect(report.containmentComplete).toBe(true);
      expect(report.failure).toBeNull();
      expect(report.failureArtifact).toBeNull();
      expect(report.results.map(r => r.gate)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8']);
      expect(report.unexecuted).toEqual([]);
      expect(report.runtimeAccepted).toBe(false);
      expect(report.liveCapabilityAccepted).toBe(false);
      expect(report.productionReady).toBe(false);
      expect(spies.p6ConcurrencyCalled()).toBe(true);
      expect(spies.p6FaultsCalled()).toBe(true);
      expect(spies.closed()).toBe(true);

      const index = JSON.parse(await readFile(join(dir, 'evidence-index.json'), 'utf8'));
      const recordedFiles = index.records.map((r: { file: string }) => r.file);
      for (const g of ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8']) {
        expect(recordedFiles).toContain(`gate-${g}.json`);
      }
      expect(await readdir(dir)).not.toContain('failure.json');
    }));

  it.each(['missing-i3-pipeline', 'missing-i7-load', 'missing-i4-domain'] as const)(
    'propagates blocker at %s and leaves subsequent gates unexecuted',
    async mode =>
      withOutputDir(async dir => {
        const cfg = config();
        const overrides: Partial<PrivateCoordinatorComposition> =
          mode === 'missing-i3-pipeline'
            ? { pipeline: undefined }
            : mode === 'missing-i7-load'
              ? { separateLoadEvidence: undefined }
              : { domains: { custody: async () => ({ assertions: [assertion('ok', true)] }) } };
        const { composition } = buildInertComposition(cfg, overrides);
        const report = await runEvidenceQualification(cfg, dir, createPrivateCoordinatorPorts(cfg, composition));

        expect(report.observedGatesComplete).toBe(false);
        expect(report.runtimeAccepted).toBe(false);
        if (mode === 'missing-i3-pipeline') {
          expect(report.results.map(r => r.gate)).toEqual(['I1', 'I2', 'I3']);
          expect(report.unexecuted).toEqual(['I4', 'I5', 'I6', 'I7', 'I8']);
          expect(report.results[2]?.blocked.length).toBeGreaterThan(0);
        } else if (mode === 'missing-i7-load') {
          expect(report.results.map(r => r.gate)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7']);
          expect(report.unexecuted).toEqual(['I8']);
          expect(report.results[6]?.blocked.length).toBeGreaterThan(0);
        } else {
          expect(report.results.map(r => r.gate)).toEqual(['I1', 'I2', 'I3', 'I4']);
          expect(report.unexecuted).toEqual(['I5', 'I6', 'I7', 'I8']);
          expect(report.results[3]?.blocked.length).toBeGreaterThan(0);
        }
      })
  );

  it('keeps I7 27-minute load lifetime separate from core 10-minute deadline and preserves public CLI refusals', async () => {
    vi.useFakeTimers();
    let nowMs = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const cfg = config();
    const accounting = validLoadAccounting(cfg.candidate.runId);
    let closed = false;

    const gatePromise = runIndependentLoadGate(
      { secondRampMinutes: 2, drainMs: 60_000 },
      {
        run: async () => {
          await new Promise<void>(resolve =>
            setTimeout(() => {
              nowMs += 27 * 60_000 + 1;
              resolve();
            }, 27 * 60_000)
          );
          return accounting;
        },
        drain: async (_life, val) => val,
        close: async () => { closed = true; }
      }
    );
    await vi.advanceTimersByTimeAsync(27 * 60_000 + 10);
    const separate = await gatePromise;

    expect(closed).toBe(true);
    expect(separate.report.observationsComplete).toBe(true);
    expect(separate.report.containmentComplete).toBe(true);
    expect(separate.report.durations.loadMs).toBe(27 * 60_000);
    expect(() => new Deadline(separate.report.durations.loadMs)).toThrow('Invalid bounded deadline');
    expect(() => validateConfig({ ...cfg, maxDurationMs: 600_001 })).toThrow('Bounded qualification duration required');
    await expect(runQualification('/inert/config.json', '/inert/out')).rejects.toThrow();

    vi.useRealTimers();
    await withOutputDir(async dir => {
      for (const badEvidence of [
        { ...separate, report: { ...separate.report, durations: { loadMs: 600_000, drainMs: 60_000 } } },
        { ...separate, report: { ...separate.report, observationsComplete: false } },
        { ...separate, accounting: validLoadAccounting(cfg.reference.runId) }
      ]) {
        const { composition } = buildInertComposition(cfg, { separateLoadEvidence: badEvidence });
        const r = await runEvidenceQualification(cfg, `${dir}-${Math.random().toString(16).slice(2)}`, createPrivateCoordinatorPorts(cfg, composition));
        expect(r.observedGatesComplete).toBe(false);
        expect(r.unexecuted).toEqual(['I8']);
        expect(gatePassed(r.results.at(-1)!)).toBe(false);
      }
    });
  });

  it('fences ambiguous COMMIT on deadline abort without ROLLBACK, quarantines client, and blocks downstream transitions', async () => {
    const deadline = new Deadline(5000);
    const calls: string[] = [];
    const onUncertainCommit = vi.fn();
    let releaseCommit!: () => void;
    const client: SqlClient = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql === 'COMMIT') {
          await new Promise<void>(resolve => { releaseCommit = resolve; });
        }
        return { rows: [], command: sql };
      }
    };

    const txPromise = transaction(
      client,
      null,
      async tx => {
        await tx.query('SELECT 1');
        return 'ok';
      },
      { deadline, onUncertainCommit }
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    deadline.abort();

    await expect(txPromise).rejects.toBeInstanceOf(CommitUncertainError);
    releaseCommit?.();
    expect(calls).not.toContain('ROLLBACK');
    expect(isClientQuarantined(client)).toBe(true);
    expect(onUncertainCommit).toHaveBeenCalledOnce();
    await expect(transaction(client, null, async () => 'reused')).rejects.toThrow(/Quarantined SQL client refused/);
    deadline.dispose();

    // Abort / failure BEFORE COMMIT issues ROLLBACK (when signal not yet aborted) and never throws CommitUncertainError
    const beforeCommitCalls: string[] = [];
    const cleanClient: SqlClient = {
      query: async (sql: string) => {
        beforeCommitCalls.push(sql);
        return { rows: [], command: sql };
      }
    };
    const d2 = new Deadline(5000);
    await expect(
      transaction(
        cleanClient,
        null,
        async () => { throw new Error('pre-commit-action-failure'); },
        { deadline: d2 }
      )
    ).rejects.toThrow('pre-commit-action-failure');
    expect(beforeCommitCalls).toContain('ROLLBACK');
    expect(isClientQuarantined(cleanClient)).toBe(false);
    d2.dispose();

    // Deadline abort during action (before COMMIT) does not throw CommitUncertainError
    const d3 = new Deadline(5000);
    const abortedCalls: string[] = [];
    const abortedClient: SqlClient = {
      query: async (sql: string) => {
        abortedCalls.push(sql);
        return { rows: [], command: sql };
      }
    };
    let caughtPreCommit: unknown;
    try {
      await transaction(
        abortedClient,
        null,
        async tx => {
          d3.abort();
          await tx.query('SELECT 1');
          return 'unreachable';
        },
        { deadline: d3 }
      );
    } catch (err) {
      caughtPreCommit = err;
    }
    expect(isCommitUncertainError(caughtPreCommit)).toBe(false);
    expect(abortedCalls).not.toContain('COMMIT');
    d3.dispose();

    // CommitFence blocks downstream enqueue, publish, and next-gate across all 3 uncertain-commit classes
    for (const err of [
      new CommitUncertainError(),
      new ExecutedPipelineCommitUncertainError(),
      new FinancialCommitUncertainError()
    ]) {
      const fence = createCommitFence();
      const enqueue = vi.fn(async () => 'enqueued');
      const publish = vi.fn(async () => 'published');
      const nextGate = vi.fn(async () => result('I4', [assertion('ok', true)]));

      const gated = await executeGateWithCommitFence('I3', 'commit', fence, async () => {
        throw err;
      });
      expect(gatePassed(gated)).toBe(false);
      expect(gated.evidence).toMatchObject({ errorCode: 'COMMIT_UNCERTAIN', quarantined: true, retried: false, downstreamAborted: true });
      expect(fence.tripped).toBe(true);
      await expect(fence.guard('enqueue', enqueue)).rejects.toThrow();
      await expect(fence.guard('publish', publish)).rejects.toThrow();
      await expect(fence.guard('next-gate', nextGate)).rejects.toThrow();
      expect(enqueue).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(nextGate).not.toHaveBeenCalled();
    }
  });

  it('logs strictly sanitized failure artifacts without credentials, SQL, or PEM material in qualification.json or failure.json', async () => {
    const secretMsg =
      'postgresql://swat_app:topsecret@127.0.0.1:55432/db SELECT sealed_secret FROM user_execution_grants -----BEGIN PRIVATE KEY-----';

    const directArtifact = sanitizeFailure(
      Object.assign(new Error(secretMsg), { code: '28P01', sql: 'SELECT sealed_secret', detail: 'topsecret' }),
      'execute',
      'I3'
    );
    expect(directArtifact).toMatchObject({
      gate: 'I3',
      phase: 'execute',
      errorCode: '28P01',
      errorName: 'Error',
      commitUncertain: false
    });
    expect(JSON.stringify(directArtifact)).not.toMatch(/topsecret|sealed_secret|SELECT|BEGIN PRIVATE KEY/);

    for (const point of ['inspect', 'execute', 'close'] as const) {
      await withOutputDir(async dir => {
        const cfg = config();
        const report = await runEvidenceQualification(cfg, dir, {
          inspect: async () => {
            if (point === 'inspect') throw Object.assign(new Error(secretMsg), { code: '08006' });
          },
          execute: async gate => {
            if (point === 'execute' && gate === 'I3') {
              throw new CommitUncertainError(secretMsg);
            }
            return result(gate, [assertion('ok', true)]);
          },
          close: async () => {
            if (point === 'close') throw new Error(secretMsg);
          }
        });

        expect(report.failure).not.toBeNull();
        expect(report.failureArtifact).not.toBeNull();
        expect(report.failureArtifact?.phase).toBe(point);
        if (point === 'execute') {
          expect(report.failureArtifact?.gate).toBe('I3');
          expect(report.failureArtifact?.commitUncertain).toBe(true);
          expect(report.failureArtifact?.errorCode).toBe('COMMIT_UNCERTAIN');
        }

        const qualRaw = await readFile(join(dir, 'qualification.json'), 'utf8');
        const failRaw = await readFile(join(dir, 'failure.json'), 'utf8');
        for (const text of [qualRaw, failRaw]) {
          expect(text).not.toContain('topsecret');
          expect(text).not.toContain('sealed_secret');
          expect(text).not.toContain('SELECT');
          expect(text).not.toContain('BEGIN PRIVATE KEY');
        }
        const failJson = JSON.parse(failRaw);
        expect(failJson.failed).toBe(true);
        expect(failJson.failureArtifact).toMatchObject({
          phase: point,
          gate: point === 'execute' ? 'I3' : null
        });
      });
    }
  });
});
