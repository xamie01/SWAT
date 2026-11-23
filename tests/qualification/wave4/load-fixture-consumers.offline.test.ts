import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from '../../../packages/db/src/copy-trade-lifecycle-owned.js';
import { createExactFollowerEntryRequest } from '../../../packages/db/src/exact-follower-sizing.js';
import { sourceContentDigest } from '../../../packages/db/src/source-verification.js';
import { createLoadFixtureConsumers, loadFixtureConsumerBlockers, type LoadFixtureConsumerPorts,
  type LoadFixtureInvocation } from './load-fixture-consumers.js';
import { loadDigest, loadFixtureRequest, type LoadFixture } from './load-durable-contract.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const FIXTURE = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = '44444444-4444-4444-8444-444444444444';
const at = '2026-11-23T00:00:00.000Z';
const scope = { runId: RUN, namespace: `wave4-load-${RUN}`, network: `solana:wave4-${RUN}`, backendIdentity: 'inert-backend-not-approved' };
const walletAddress = 'solana:11111111111111111111111111111111';
const tokenMint = 'solana:11111111111111111111111111111112';
function invocation(kind: 'wallet' | 'token' = 'wallet'): LoadFixtureInvocation {
  const fixture: LoadFixture = { scope, fixtureId: FIXTURE, userId: USER, kind, walletAddress, tokenMint,
    targetAccount: walletAddress, binding: { chain: 'solana', network: scope.network, sourceEventType: 'transaction',
      sourceEventId: `${scope.namespace}/${FIXTURE}`, sourceEventIndex: '0', transactionHash: `${scope.namespace}/${FIXTURE}`,
      walletAddress, tokenMint, side: 'buy', rawQuantity: '1000000000', quantityScale: 9, eventAt: at,
      amountUsd: '100', priceUsd: null, feeUsd: '0' }, base: { raw: '1500000000', scale: 9 },
    quoteBudget: { raw: '20000000000', scale: 9 },
    quote: { raw: '20000000000', scale: 9 }, fee: { raw: '10000000', scale: 9 }, requestDigest: '' };
  (fixture as { requestDigest: string }).requestDigest = loadDigest(loadFixtureRequest(fixture));
  return { fixture, principal: { kind: 'user', userId: USER }, attempt: { attemptId: ATTEMPT, fixtureId: FIXTURE,
    runId: RUN, namespace: scope.namespace, userId: USER, requestDigest: fixture.requestDigest,
    route: kind === 'wallet' ? '/v1/me/wallets' : '/v1/me/tokens/backfill', status: 201, startedAt: at, finishedAt: at },
    evidence: { evidenceId: 'inert-evidence', binding: fixture.binding, finality: 'confirmed', blockHash: 'inert-block',
      blockHeight: '1', revision: '1', reversesEvidenceId: null, observedAt: at,
      provenance: { providerId: 'inert-provider', authorityId: 'inert-authority', verifierVersion: 'inert-v1', receiptId: 'inert-receipt' },
      content: 'inert-receipt-content', contentDigest: sourceContentDigest('inert-receipt-content') } };
}
function ports() {
  const query = vi.fn(async () => { throw new Error('SQL must not run before protected invocation approval'); });
  const client = { query } as unknown as PoolClient;
  const assertInvocationWithClient = vi.fn(async () => { throw new Error('approved protected HTTP correlation unavailable'); });
  const p = { scope, sourceTransaction: vi.fn(async (action: (c: PoolClient) => Promise<unknown>) => action(client)),
    protectedCapture: { assertInvocationWithClient, bindCanonicalWithClient: vi.fn(async () => {}) },
    verifier: { validateProvider: vi.fn(async () => null), verifyEvidence: vi.fn(async () => { throw new Error('not approved'); }) },
    policy: { transaction: vi.fn(async (action: (c: PoolClient) => Promise<unknown>) => action(client)),
      operatorAutoExecute: () => false, mode: vi.fn(async () => null), safety: vi.fn(async () => ({ isSafe: false })),
      capacity: vi.fn(async () => { throw new Error('approved capacity unavailable'); }), paperTargetAccount: () => walletAddress,
      now: () => new Date(at), minimumBalanceUsd: 0, minimumSignalScore: 80, maximumSourceEventAgeMs: 1000,
      log: vi.fn(), warn: vi.fn(), error: vi.fn() }, fanoutOwner: 'inert-owner', now: () => new Date(at), maximumAgeMs: 1000,
    signalTerms: { confidence: 90, signalScore: 90, triggerData: {}, maxEventAgeMs: 1000, maxPositionEvidenceAgeMs: 1000 },
    clusterTier: 'elite', followerSizing: { providerId: 'inert-sizing', providerIdentity: 'inert-sizing-identity',
      networkForChain: () => scope.network, readBalance: vi.fn(async () => null) },
    workerTransaction: vi.fn(async (action: (c: PoolClient) => Promise<unknown>) => action(client)),
    authorize: vi.fn(async () => { throw new Error('approved authority unavailable'); }), platformMode: vi.fn(async () => 'off'),
    paperValuation: { providerId: 'inert-provider', providerIdentity: 'inert-identity', networkForChain: () => scope.network,
      readValuation: vi.fn(async () => null) }, workerOwner: 'inert-worker' } as unknown as LoadFixtureConsumerPorts;
  return { p, query, client, assertInvocationWithClient };
}
/** No test in this file claims runtime success or invents canonical provider SQL. */
describe('run-bound contained wallet/token source consumers', () => {
  it.each(['wallet', 'token'] as const)('does not treat %s labels, HTTP 201 or injected callbacks as protected runtime authority', async kind => {
    const { p, query, client, assertInvocationWithClient } = ports();
    const consumers = createLoadFixtureConsumers(p);
    await expect(consumers[kind](invocation(kind))).rejects.toThrow(/protected HTTP correlation unavailable/);
    expect(assertInvocationWithClient).toHaveBeenCalledWith(client, expect.objectContaining({ scope,
      principal: { kind: 'user', userId: USER }, stage: 'source' }));
    expect(query).not.toHaveBeenCalled(); expect(p.verifier.validateProvider).not.toHaveBeenCalled();
    expect(p.policy.transaction).not.toHaveBeenCalled(); expect(p.workerTransaction).not.toHaveBeenCalled();
  });
  const hostile: [string, (input: any) => void][] = [
    ['actual principal tenant differs', i => i.principal.userId = FIXTURE],
    ['operator principal', i => i.principal = { kind: 'operator' }],
    ['HTTP tenant differs', i => i.attempt.userId = FIXTURE],
    ['fixture tenant differs', i => i.fixture.userId = FIXTURE],
    ['hostile attempt UUID', i => i.attempt.attemptId = `${ATTEMPT}\n`],
    ['path fixture ID', i => i.fixture.fixtureId = '../../outside'],
    ['wrong run', i => i.attempt.runId = FIXTURE],
    ['wrong namespace', i => i.attempt.namespace += '-outside'],
    ['wrong runtime backend', i => i.fixture.scope.backendIdentity = 'label-impostor'],
    ['wrong network', i => i.evidence.binding.network += '-outside'],
    ['wrong token', i => i.fixture.tokenMint = walletAddress],
    ['wrong route', i => i.attempt.route = '/v1/wallets'],
    ['failed HTTP response', i => i.attempt.status = 429],
    ['wrong request digest', i => i.attempt.requestDigest = 'a'.repeat(64)],
    ['observed financial proof', i => i.evidence.finality = 'observed'],
    ['reversed financial proof', i => i.evidence.finality = 'reversed'],
    ['invented raw quantity number', i => i.fixture.base.raw = 1.5],
    ['scale outside exact domain', i => i.fixture.base.scale = 19],
    ['prototype authority', i => i.fixture = Object.assign(Object.create({ runtimeAccepted: true }), i.fixture)],
    ['function in fixture', i => i.fixture.approved = () => true],
    ['invalid timestamp', i => i.attempt.startedAt = 'now'],
    ['reversed attempt timestamps', i => i.attempt.startedAt = '2026-11-23T00:00:01.000Z']
  ];
  it.each(hostile)('refuses %s before protected SQL/admission or queue effect', async (_label, mutate) => {
    const { p, query, assertInvocationWithClient } = ports(), input = structuredClone(invocation());
    mutate(input); await expect(createLoadFixtureConsumers(p).wallet(input)).rejects.toThrow();
    expect(p.sourceTransaction).not.toHaveBeenCalled(); expect(assertInvocationWithClient).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('requires precise external ports and never accepts a label/env boolean opt-in', () => {
    const { p } = ports();
    for (const key of ['sourceTransaction', 'workerTransaction', 'authorize', 'platformMode', 'paperValuation', 'followerSizing', 'protectedCapture', 'verifier']) {
      expect(() => createLoadFixtureConsumers({ ...p, [key]: null, approved: true } as unknown as LoadFixtureConsumerPorts)).toThrow();
    }
    expect(() => createLoadFixtureConsumers({ ...p, policy: { ...p.policy, operatorAutoExecute: () => true } })).toThrow(/operator/);
    for (const maximumAgeMs of [0, 60001, 0.1, NaN]) expect(() => createLoadFixtureConsumers({ ...p, maximumAgeMs })).toThrow();
    expect(loadFixtureConsumerBlockers.join(' ')).toMatch(/Public HTTP routes do not persist/);
  });
  it('refuses queue/worker calls with forged or reconstructed prepared payloads', async () => {
    const { p } = ports(), consumers = createLoadFixtureConsumers(p), queue = { add: vi.fn(async () => ({ accepted: true })) };
    const prepared: any = { invocation: invocation(), plan: { users: [] } };
    await expect(consumers.enqueue(prepared, queue)).rejects.toThrow(/original prepared/);
    await expect(consumers.execute(prepared, {} as any)).rejects.toThrow(/original prepared/);
    expect(queue.add).not.toHaveBeenCalled(); expect(p.workerTransaction).not.toHaveBeenCalled();
  });
  it('wallet/token discriminants are strict and token identity is not an authenticated principal', async () => {
    const { p } = ports(), consumers = createLoadFixtureConsumers(p);
    expect(() => consumers.wallet(invocation('token'))).toThrow(/kind mismatch/);
    expect(() => consumers.token(invocation('wallet'))).toThrow(/kind mismatch/);
    expect(p.sourceTransaction).not.toHaveBeenCalled();
  });
  it('actual trusted follower sizing yields quote-only budget from persisted settings/risk, never fixture/master base', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('user_execution_settings')
      ? { rows: [{ max_position_pct: '20', auto_execute: true, killed: false }] }
      : { rows: [{ cap_usd: '100', enabled: true, accounting_ready: true, spent: '90', unknown: false }] });
    const sizing = createExactFollowerEntryRequest({ now: () => new Date(at), maximumAgeMs: 1000,
      provider: { providerId: 'inert-provider', providerIdentity: 'inert-identity', networkForChain: () => scope.network,
        readBalance: async (_client, identity) => ({ providerId: 'inert-provider', providerIdentity: 'inert-identity',
          evidenceId: 'inert-balance', userId: USER, chain: 'solana', network: scope.network,
          targetAccount: identity.targetAccount, executionMode: 'paper', availableUsd: '100', observedAt: new Date(at),
          expiresAt: new Date('2026-11-23T00:01:00.000Z') }) } });
    const request = await sizing({ query } as unknown as PoolClient, { chain: 'solana', data: { userId: USER,
      targetAccount: walletAddress, tokenMint, direction: 'buy', executionMode: 'paper' } });
    expect(request).toEqual({ requestedBaseQuantity: null, requestedQuoteQuantity: '10' });
    expect(query).toHaveBeenCalledTimes(2);
  });
  it('a no-op capture callback cannot manufacture source/provider authority; actual canonical intake still runs and refuses', async () => {
    const { p, query } = ports();
    p.protectedCapture.assertInvocationWithClient = vi.fn(async () => {});
    query.mockImplementation(async () => ({ rows: [], rowCount: 0 }) as never);
    await expect(createLoadFixtureConsumers(p).wallet(invocation())).rejects.toThrow(/Source event insert did not return a row/);
    const call = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(call[0]).toContain('INSERT INTO source_trades');
    expect(call[1]).toEqual(expect.arrayContaining([walletAddress, tokenMint, '1', `${scope.namespace}/${FIXTURE}`, 'observed']));
    expect(p.verifier.validateProvider).not.toHaveBeenCalled(); expect(p.workerTransaction).not.toHaveBeenCalled();
  });
  it('source imports actual owned canonical production leaves, not boot/root DB/pg or divergent provider implementations', () => {
    const source = readFileSync(new URL('./load-fixture-consumers.ts', import.meta.url), 'utf8');
    expect(source).toContain('recordSourceTradeEventWithClient'); expect(source).toContain('applyVerifiedSourceEvidenceWithClient');
    expect(source).toContain('createOwnedFanoutPolicy'); expect(source).toContain('createCanonicalFanoutPreparation');
    expect(source).toContain('createDurableFanoutDelivery'); expect(source).toContain('runCanonicalWorkerJob');
    expect(source).toContain('createExactPaperQuote'); expect(source).toContain('createExactFollowerEntryRequest');
    expect(source).toContain('return trustedSizing(client, descriptor)');
    expect(source).not.toContain('loadAmount(fixture.base)'); expect(source).not.toContain('loadAmount(fixture.quote');
    expect(source).toContain('readOwnedWorkerRuntimeCapability');
    expect(source).toContain('capability.backendIdentity === scope.backendIdentity');
    expect(source).not.toMatch(/from ['"](?:pg|@swat\/db)['"]/);
    expect(source).not.toMatch(/(?:index\.js|runtime\.mjs|createPool|new Pool|fetch\(|process\.env)/);
    expect(source).not.toMatch(/(?:INSERT INTO|CREATE TABLE|GRANT )/);
    expect(source).toContain('runtimeAccepted: false'); expect(source).toContain('economicSuccess: false');
  });
});
