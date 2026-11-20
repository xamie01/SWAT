import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { assertion, expectedSqlFailure, gatePassed, qualify, result, transaction, validateConfig, type QualificationConfig } from './core.js';
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
