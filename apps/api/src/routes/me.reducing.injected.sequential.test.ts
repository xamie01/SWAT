import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@swat/db', async () => ({
  ...await import('@swat/db/dist/withdrawal-contract.js'), ...await import('@swat/db/dist/withdrawal-store.js'),
  ...await import('@swat/db/dist/withdrawal-service.js'), ...await import('@swat/db/dist/reducing-contract.js'),
  forUser: (userId: string) => ({ userId }), findUserById: vi.fn(), resolveSession: vi.fn(), query: vi.fn(), scopedQuery: vi.fn(), listAuthWallets: vi.fn(),
  isSubscribed: vi.fn(), listTokenWatches: vi.fn(), listWalletSubscriptions: vi.fn(), QuotaExceededError: class extends Error {},
  requestTokenWatch: vi.fn(), subscribeToWallet: vi.fn(), beginWindDown: vi.fn(), requestCloseAll: vi.fn(), getWalletScoringReadiness: vi.fn(),
  checkWalletClusterIndependence: vi.fn(), checkWalletHubStatus: vi.fn(), getPerpsInstruments: vi.fn(), getPerpsAccount: vi.fn(),
  getUserPerpsPositions: vi.fn(), closePerpsPosition: vi.fn(), PerpsCloseUnavailableError: class extends Error {}
}));
vi.mock('@swat/shared', async () => ({ chainSchema: (await import('../../../../packages/shared/src/validation.js')).chainSchema,
  deriveWakeVaultAddress: vi.fn(), capabilitiesFor: vi.fn(), createWalletBackfillJob: vi.fn(), isValidAddressForChain: vi.fn(),
  resolveChainAddress: vi.fn(), tierAllowsChain: vi.fn() }));
import { registerMeRoutes } from './me.js';
import { createReducingService } from '@swat/db/dist/reducing-service.js';
import type { ReducingExposure, ReducingIntent } from '@swat/db/dist/reducing-contract.js';
import { withdrawalSqlFixture, financialFundingFixture, reducingMappingFixture, financialAuthorizationFixture } from '@swat/db/dist/withdrawal-test-fixture.js';
import type { FinancialAttempt, FinancialReceipt, FinancialRecord } from '@swat/db/dist/withdrawal-contract.js';
import { createDurableFinancialRunner } from '../../../trade-executor/src/reducing-orchestration.js';
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup(venue: 'spot' | 'polymarket-perps' = 'polymarket-perps', side: 'LONG' | 'SHORT' = 'LONG') {
  const db = withdrawalSqlFixture();
  db.state().held = '100'; // canonical fixture inventory matches the authoritative exposure used for admission
  const input = { requestKey: 'reduce-1', chain: venue === 'spot' ? 'solana' as const : 'polygon' as const,
    network: 'inert-network', assetId: 'asset-1', assetScale: 8, mode: 'paper' as const, maxFeeRaw: '0', accountId: 'account-1',
    feeAssetId: 'fee-asset', feeAssetScale: 6, feeFundingAccountId: 'fee-account',
    positionSide: side, quantityRaw: '100', limitPriceExact: '65000.000000000000000001', expectedRevision: 'r1' };
  const exposure: ReducingExposure = { ...input, venue, positionId: 'position-1', userId: 'user-1', heldRaw: '100', revision: 'r1',
    observedAt: db.now, validUntil: '2026-11-17T12:01:00.000Z', proof: 'inert-independent-exposure' };
  const service = createReducingService({ transaction: db.transaction, lockExposure: async () => exposure,
    lockFunding: async (_client, userId, budget) => financialFundingFixture(userId, budget, db.now),
    lockVenueMapping: async (_client, record) => { const mapping = reducingMappingFixture(record, db.now); db.admitMapping(record, mapping); return mapping; } });
  const app = Fastify({ logger: false }); apps.push(app);
  app.addHook('onRequest', async request => {
    const id = request.headers['x-fixture-user'];
    if (typeof id === 'string') request.principal = { kind: 'user', sessionId: null, user: { id } as never };
  });
  await registerMeRoutes(app, { backfillQueue: { add: vi.fn() } as never, tokenDiscoveryQueue: { add: vi.fn() } as never,
    financial: { reducing: service } });
  const url = venue === 'spot' ? '/v1/me/positions/position-1/exit' : '/v1/me/perps/positions/position-1/close';
  const post = (payload: unknown = input, user = 'user-1') => app.inject({ method: 'POST', url, payload: payload as never, headers: { 'x-fixture-user': user } });
  const status = (id: string, user = 'user-1') => app.inject({ url: '/v1/me/reducing/' + id, headers: { 'x-fixture-user': user } });
  return { db, input, exposure, service, app, url, post, status };
}
it.each(['LONG', 'SHORT'] as const)('registered me perps route admits exact %s intent through actual factory without false closure', async side => {
  const s = await setup('polymarket-perps', side); const response = await s.post();
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json().record).toMatchObject({ status: 'queued', completedRaw: '0', terminal: false,
    intent: { ...s.input, positionId: 'position-1', venue: 'polymarket-perps', side: side === 'LONG' ? 'SELL' : 'BUY' } });
  expect(s.db.state().held).toBe('100'); expect(s.db.state().outbox).toHaveLength(1);
  expect(response.json()).not.toHaveProperty('success'); expect(response.json().capability.liveAccepted).toBe(false);
  expect((await s.post()).json().record.id).toBe(response.json().record.id); expect(s.db.state().outbox).toHaveLength(1);
  expect((await s.status(response.json().record.id, 'user-2')).statusCode).toBe(404);
});
it('spot route invokes actual reducing admission, refuses aggregate close-all and cannot cross zero', async () => {
  const s = await setup('spot'); expect((await s.post({ ...s.input, quantityRaw: '101' })).statusCode).toBe(409);
  expect(s.db.state().outbox).toHaveLength(0);
  expect((await s.post()).statusCode).toBe(200);
  expect((await s.app.inject({ method: 'POST', url: '/v1/me/positions/close-all', headers: { 'x-fixture-user': 'user-1' } })).statusCode).toBe(503);
  expect(s.db.state().outbox).toHaveLength(1);
});
it.each(['revision', 'network', 'mode', 'tenant'])('actual route rejects stale/substituted %s without reserving/queueing', async kind => {
  const s = await setup(); Object.assign(s.exposure, kind === 'revision' ? { revision: 'r2' } : kind === 'network' ? { network: 'other' }
    : kind === 'mode' ? { mode: 'live' } : { userId: 'other' });
  expect((await s.post()).statusCode).toBeGreaterThanOrEqual(400); expect(s.db.state().outbox).toHaveLength(0); expect(s.db.state().reservations).toHaveLength(0);
});
it('rejects public provider receipt/authority and path identity substitution', async () => {
  const s = await setup();
  for (const extra of [{ positionId: 'other' }, { userId: 'other' }, { receipt: { terminal: true } }, { authority: { enabled: true } }]) {
    expect((await s.post({ ...s.input, ...extra })).statusCode).toBe(400);
  }
  expect((await s.app.inject({ method: 'POST', url: s.url, payload: s.input })).statusCode).toBe(401);
  expect(s.db.events).toHaveLength(0);
});
it('actual expired no-attempt cancellation is visible through me status without claiming position closure', async () => {
  const s = await setup('spot'); const admitted = (await s.post()).json(); s.db.advance(300_001);
  const submit = vi.fn(), authorize = vi.fn();
  const runner = createDurableFinancialRunner<ReducingIntent>({ transaction: s.db.transaction, revalidate: s.service.revalidate,
    effects: { authorize, submit, reconcile: async () => null, verify: async () => null }, account: vi.fn() });
  const cancelled = await runner.cancelExpired('user-1', admitted.record.id);
  expect(cancelled.status).toBe('cancelled');
  expect((await s.status(admitted.record.id)).json().record).toMatchObject({ status: 'cancelled', terminal: true,
    completedRaw: '0', cancellationReason: 'expired-before-attempt', intent: { feeAssetId: s.input.feeAssetId,
      feeAssetScale: s.input.feeAssetScale, feeFundingAccountId: s.input.feeFundingAccountId } });
  expect(s.db.state().held).toBe('100'); expect(submit).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
});
it('actual runner receipt progress is observed by actual me status; uncertain retries never resubmit or falsely close', async () => {
  const s = await setup(); const admission = (await s.post()).json();
  let selected: FinancialReceipt | null = null;
  let pinned: { record: FinancialRecord<ReducingIntent>; attempt: FinancialAttempt } | null = null;
  const submit = vi.fn(async () => null);
  const runner = createDurableFinancialRunner<ReducingIntent>({ transaction: s.db.transaction, revalidate: s.service.revalidate,
    effects: { authorize: async (record, attempt) => { pinned = { record, attempt }; return financialAuthorizationFixture(record, attempt, s.db.now); }, submit,
      reconcile: async () => selected, verify: async (_record, _attempt, observed) => observed as FinancialReceipt | null },
    account: async (client, record, receipt, delta, fee) => {
      // Explicit inert journal on the same fixture transaction, not a provider/PnL assertion.
      await client.query('SELECT $1,$2,$3,$4,$5 /* fixture:economics */', [record.id, record.userId, receipt.receiptId,
        'inert-journal:' + receipt.receiptId, JSON.stringify({ deltaRaw: delta, deltaFeeRaw: fee, fixtureOnly: true })]);
      await client.query('SELECT $1 /* fixture:account */', [delta, fee]); return 'canonical:' + record.id + ':' + receipt.receiptId;
    } });
  await runner.run('user-1', admission.record.id); await runner.run('user-1', admission.record.id);
  expect(submit).toHaveBeenCalledTimes(1);
  expect((await s.status(admission.record.id)).json().record).toMatchObject({ status: 'uncertain', completedRaw: '0', terminal: false });
  const receipt = (cumulativeRaw: string, terminal: boolean, receiptId: string): FinancialReceipt => {
    if (!pinned) throw new Error('Missing prepared attempt');
    return { receiptId, providerIdentity: 'inert-independent-verifier', proof: 'fixture-proof', intentId: pinned.record.id,
      intentHash: pinned.record.intentHash, attemptId: pinned.attempt.id, clientOrderId: pinned.attempt.clientOrderId,
      cumulativeRaw, feeRaw: '0', feeAssetId: s.input.feeAssetId, feeAssetScale: s.input.feeAssetScale,
      feeFundingAccountId: s.input.feeFundingAccountId, terminal, outcome: 'fill', observedAt: s.db.now };
  };
  selected = receipt('40', false, 'partial'); s.db.admit(selected, 'user-1'); await runner.run('user-1', admission.record.id);
  expect((await s.status(admission.record.id)).json().record).toMatchObject({ status: 'partial', completedRaw: '40', terminal: false });
  selected = receipt('100', true, 'final'); s.db.admit(selected, 'user-1'); await runner.run('user-1', admission.record.id);
  expect((await s.status(admission.record.id)).json().record).toMatchObject({ status: 'settled', completedRaw: '100', terminal: true });
  expect(submit).toHaveBeenCalledTimes(1); expect(s.db.state().held).toBe('0');
});
