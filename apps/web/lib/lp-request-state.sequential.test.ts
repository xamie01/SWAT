import { readFileSync } from 'node:fs';
import { expect, it, vi, afterEach } from 'vitest';
import { lpApi } from './api.js';
import { createLpDomainTransport, lpExactAmount, lpMicroUsd, lpExactAdmissionAllowed, type LpExactAcquisitionRequest, type LpAcquisitionResponse, type LpOperationResponse } from './domain-transport.js';
import { createLpRequestMachine, type LpCommand } from './lp-request-state.js';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const input: LpExactAcquisitionRequest = { operationKey: 'immutable-key', chain: 'solana', poolAddress: 'solana:pool', depositAsset: 'solana:asset',
  deposit: { raw: '900719925474099312345678', scale: 18 }, strategy: { distribution: 'spot', rangeLower: 1, rangeUpper: 2, rungCount: 2 }, autoRebalance: false };
const command: LpCommand = { kind: 'acquire', request: input };
const result = (): LpAcquisitionResponse => ({ broadcast: false, mode: 'paper', capabilities: { fractionalRawscaleDto: true, injectedPortsConfigured: true,
  sourceImplemented: true, runtimeAccepted: false, liveCapabilityAccepted: false, legacyNumericDtoFractionalCapability: false, reason: 'injected-only' },
  position: { id: 'position-1', userId: 'user-1', chain: input.chain, poolAddress: input.poolAddress, depositAsset: input.depositAsset,
    acquisitionKey: input.operationKey, deposit: input.deposit, currentAmount: input.deposit, revision: '900719925474099312345678', state: 'active', mode: 'paper',
    depositMicroUsd: '900719925474099312345678', cumulativeFeesMicroUsd: '0', cumulativeCostsMicroUsd: '0', realizedMicroUsd: null,
    acquisitionQuote: {}, plan: { strategy: input.strategy }, autoRebalance: false, copyOrigin: null } } as LpAcquisitionResponse);
it('actual LP transport preserves exact JSON through LP proxy paths without a public tenant/provider/receipt/economic body', async () => {
  vi.stubGlobal('window', { location: { protocol: 'https:', hostname: 'app.example' } });
  vi.stubEnv('NEXT_PUBLIC_LP_API_URL', '');
  const fetch = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetch);
  const transport = createLpDomainTransport(lpApi);
  await transport.acquire(input); await transport.position('id/a'); await transport.requestOperation('id/a', 'close', { operationKey: 'same-key' });
  await transport.operation('op/a'); await transport.copyMint({ subscriptionId: 's', eventId: 'e', assetScale: 18 }); await transport.capabilities();
  const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
  expect(calls.map(([url]) => String(url))).toEqual(['/v1/lp/positions/deploy-exact', '/v1/lp/positions/id%2Fa/exact',
    '/v1/lp/positions/id%2Fa/close', '/v1/lp/operations/op%2Fa', '/v1/lp/copy/mint-exact', '/v1/lp/capabilities']);
  expect(JSON.parse(String(calls[0]![1].body))).toEqual(input);
  expect(JSON.parse(String(calls[2]![1].body))).toEqual({ operationKey: 'same-key' });
  expect(JSON.parse(String(calls[4]![1].body))).toEqual({ subscriptionId: 's', eventId: 'e', assetScale: 18 });
  expect(calls.every(([, init]) => init.credentials === 'include')).toBe(true);
  for (const extra of [{ userId: 'other' }, { provider: 'caller' }, { quote: {} }, { receipt: {} }, { economics: {} }, { copyOrigin: {} }]) {
    expect(() => transport.acquire({ ...input, ...extra })).toThrow();
  }
  expect(() => transport.requestOperation('p', 'close', { operationKey: 'k', receipt: {} } as never)).toThrow();
  expect(() => transport.copyMint({ subscriptionId: 's', eventId: 'e', assetScale: 18, allocatedUsd: 1 } as never)).toThrow();
});
it('LP quantities/microdollars and nullable signed accounting format without float conversion', () => {
  expect(lpExactAmount(input.deposit)).toBe('900719.925474099312345678');
  expect(lpMicroUsd('-900719925474099312345678')).toBe('-$900719925474099312.345678'); expect(lpMicroUsd(null)).toBe('Unknown');
  for (const value of ['-0', '01', '1e6', '1.0', '+1']) expect(() => lpMicroUsd(value)).toThrow();
  expect(() => lpExactAmount({ raw: '1', scale: 31 })).toThrow();
  expect(lpExactAdmissionAllowed({ fractionalRawscaleDto: true } as never)).toBe(false);
});
it.each(['acquire', 'operation', 'copy-mint'] as const)('lost %s outcome survives reload, changed drafts and later refusal with identical payload/key', kind => {
  const submitted: LpCommand = kind === 'acquire' ? command : kind === 'operation'
    ? { kind, positionId: 'position-1', action: 'close', request: { operationKey: 'stable-close-key' } }
    : { kind, request: { subscriptionId: 's', eventId: 'event-1', assetScale: 18 } };
  const machine = createLpRequestMachine('user-1', () => {}); machine.begin(submitted);
  const restarted = createLpRequestMachine('user-1', () => {}, machine.state());
  expect(restarted.state().phase).toBe('unknown'); expect(restarted.retry()).toEqual(submitted); restarted.unknown();
  expect(() => restarted.begin(command)).toThrow(); expect(() => restarted.fresh()).toThrow();
  expect(createLpRequestMachine('user-1', () => {}, restarted.state()).retry()).toEqual(submitted);
});
it('storage failure prevents admission and immutable snapshots cannot follow mutable draft inputs', () => {
  const blocked = createLpRequestMachine('user-1', () => { throw new Error('storage failure'); }); expect(() => blocked.begin(command)).toThrow();
  expect(blocked.state().phase).toBe('editable');
  const invalid = createLpRequestMachine('user-1', () => {});
  expect(() => invalid.begin({ kind: 'acquire', request: { ...input, deposit: { raw: '0', scale: 18 } } })).toThrow();
  expect(invalid.state().phase).toBe('editable');
  const draft = structuredClone(command), machine = createLpRequestMachine('user-1', () => {}); machine.begin(draft);
  if (draft.kind === 'acquire') Object.assign(draft.request, { deposit: { raw: '1', scale: 0 } });
  machine.unknown(); expect(machine.retry()).toEqual(command);
});
it('initial acquisition response resolves only bound immutable identity, never substitutes current state', () => {
  const machine = createLpRequestMachine('user-1', () => {}); machine.begin(command); machine.observe(result());
  expect(machine.state()).toMatchObject({ phase: 'resolved', positionId: 'position-1' });
  const changed = result(); Object.assign(changed.position, { deposit: { raw: '1', scale: 18 } });
  const fenced = createLpRequestMachine('user-1', () => {}); fenced.begin(command); expect(() => fenced.observe(changed)).toThrow(); expect(() => fenced.fresh()).toThrow();
});
it('pending close is not closed; public unbound completed receipt cannot release the fence', () => {
  const machine = createLpRequestMachine('user-1', () => {});
  machine.begin({ kind: 'operation', positionId: 'position-1', action: 'close', request: { operationKey: 'close-key' } });
  const pending = { broadcast: false, queued: true, operation: { id: 'op-1', userId: 'user-1', positionId: 'position-1', action: 'close',
    operationKey: 'close-key', status: 'pending', receipt: null, receiptKey: 'receipt-1', positionRevision: '1', amountBefore: input.deposit } } as LpOperationResponse;
  machine.observe(pending); expect(machine.state().phase).toBe('pending'); expect(() => machine.fresh()).toThrow();
  expect(() => machine.observe({ ...pending, operation: { ...pending.operation, status: 'completed' } })).toThrow();
  expect(machine.retry().kind).toBe('operation');
});
it('a bound completed close observation resolves the operation only with exact zero inventory and receipt identity', () => {
  const machine = createLpRequestMachine('user-1', () => {});
  machine.begin({ kind: 'operation', positionId: 'position-1', action: 'close', request: { operationKey: 'close-key' } });
  const pool = { chain: 'solana', networkId: 'network', protocol: 'meteora-dlmm', poolAddress: 'solana:pool', depositAsset: 'solana:asset' };
  const completed = { broadcast: false, operation: { id: 'op-1', userId: 'user-1', positionId: 'position-1', action: 'close', operationKey: 'close-key',
    status: 'completed', receiptKey: 'receipt-1', positionRevision: '1', amountBefore: input.deposit, quote: { pool, quoteId: 'q', amountAfter: { raw: '0', scale: 18 } },
    receipt: { ...pool, userId: 'user-1', positionId: 'position-1', action: 'close', receiptKey: 'receipt-1', positionRevision: '1', mode: 'paper',
      finality: 'paper-settled', quoteId: 'q', amountBefore: input.deposit, amountAfter: { raw: '0', scale: 18 }, proceedsMicroUsd: '1000000',
      collectedFeesMicroUsd: '1', executionCostsMicroUsd: '2' } } } as unknown as LpOperationResponse;
  machine.observe(completed); expect(machine.state().phase).toBe('resolved'); machine.fresh(); expect(machine.state().phase).toBe('editable');
});
it('actual shared UI uses exact controls and legacy list remains explicitly observation-only', () => {
  const builder = readFileSync('apps/web/app/lp/builder/page.tsx', 'utf8'), positions = readFileSync('apps/web/app/lp/positions/page.tsx', 'utf8');
  const copy = readFileSync('apps/web/components/LpCopyPanel.tsx', 'utf8'), panel = readFileSync('apps/web/components/FinancialRequestPanel.tsx', 'utf8');
  expect(builder).toContain('kind="lp-acquire"'); expect(builder).not.toContain('legacyPaperAmount'); expect(builder).not.toContain('lpApi.post');
  expect(positions).toContain('kind="lp-operation"'); expect(positions).toContain('observation-only'); expect(positions).not.toMatch(/lpApi\.(post|patch)|operationKeys/);
  expect(copy).toContain('kind="lp-copy-mint"'); expect(panel).toContain('createLpRequestMachine'); expect(panel).toContain('Read current exact position');
  const config = readFileSync('apps/web/next.config.ts', 'utf8'); expect(config.indexOf("source: '/v1/lp/:path*'")).toBeLessThan(config.indexOf("source: '/v1/:path*'"));
});
