import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './api.js';
import { createDomainTransport, admissionAllowed, financialNotice, rawAmount, decimalAmountRaw } from './domain-transport.js';
import { legacyPaperAmount } from './portfolio-model.js';
afterEach(() => vi.unstubAllGlobals());
it('actual api transport serializes raw units/network/fee exactly and confirms only stored identifiers/code', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ record: { id: 'intent-1' } }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const transport = createDomainTransport(api);
  const request = { requestKey: 'withdraw-1', chain: 'polygon' as const, network: 'network-genesis', assetId: 'USDC', assetScale: 18,
    sourceWalletId: 'custody-1', destination: '0x' + 'a'.repeat(40), amountRaw: '900719925474099312345678', maxFeeRaw: '123456789012345678',
    feeAssetId: 'POL', feeAssetScale: 18, feeFundingAccountId: 'gas-account', mode: 'paper' as const };
  await transport.requestWithdrawal(request);
  const init = fetch.mock.calls[0]![1] as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual(request); expect(init.credentials).toBe('include');
  expect(init.headers).not.toHaveProperty('x-api-key');
  await transport.confirmWithdrawal({ intentId: 'intent-1', authorizationId: 'auth-1', otp: '123456', amountRaw: '1' } as never);
  expect(JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body))).toEqual({ intentId: 'intent-1', authorizationId: 'auth-1', otp: '123456' });
});
it('actual api error propagates rather than producing success/empty observations', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'withdrawal-cooling-off', message: 'Cooling off' }), { status: 409 })));
  await expect(createDomainTransport(api).requestWithdrawal({} as never)).rejects.toBeInstanceOf(ApiError);
});
it('exact decimal/raw formatting never rounds through Number', () => {
  expect(rawAmount('900719925474099312345678', 18)).toBe('900719.925474099312345678');
  expect(decimalAmountRaw('900719.925474099312345678', 18)).toBe('900719925474099312345678');
  for (const invalid of ['1e6', '+1', '01', '1.0000001']) expect(() => decimalAmountRaw(invalid, 6)).toThrow();
});
it('source or boolean labels alone never enable admission and admission never implies live readiness', () => {
  for (const capability of [null, {}, { supported: true }, { admissionSupported: true }, { contractVersion: 1, admissionSupported: true }]) {
    expect(admissionAllowed(capability)).toBe(false);
  }
  expect(admissionAllowed({ contractVersion: 1, admissionSupported: true, injectedPortsConfigured: true, liveAccepted: false })).toBe(true);
});
it('success/queued/uncertain/partial are not rendered as closed or transferred', () => {
  expect(financialNotice({ success: true })).toContain('unverified');
  const record = { id: 'intent-1', completedRaw: '0', intent: { mode: 'paper', kind: 'reducing', quantityRaw: '0' } };
  expect(financialNotice({ record: { ...record, status: 'queued' } })).toContain('not financial completion');
  expect(financialNotice({ record: { ...record, status: 'uncertain' } })).toContain('do not submit a new intent');
  expect(financialNotice({ record: { ...record, status: 'partial', completedRaw: '40', terminal: true } })).toContain('not closed');
  expect(financialNotice({ record: { ...record, status: 'settled', terminal: false } })).not.toContain('settled in');
  expect(financialNotice({ record: { ...record, status: 'settled', terminal: true } })).toContain('not live provider acceptance');
  expect(financialNotice({ record: { ...record, status: 'cancelled', terminal: true, cancellationReason: 'expired-before-attempt' } })).toContain('expired-before-attempt');
  expect(financialNotice({ record: { ...record, status: 'cancelled', terminal: true, completedRaw: '1', cancellationReason: 'expired-before-attempt' } })).not.toContain('resolved as cancelled');
});
it('legacy LP number DTO refuses precision loss, scientific notation and fractional/raw claims', () => {
  expect(legacyPaperAmount('500')).toBe(500);
  for (const value of ['9007199254740993', '1e6', '1.000001', '0', '01']) expect(() => legacyPaperAmount(value)).toThrow();
});
it('duplicate LP views share actual components without fabricated fallback economics or alternate deployment actions', () => {
  const workspace = readFileSync('apps/web/app/workspace/views/LpView.tsx', 'utf8');
  const copy = readFileSync('apps/web/components/LpCopyPanel.tsx', 'utf8');
  const discover = readFileSync('apps/web/app/lp/discover/page.tsx', 'utf8');
  expect(workspace).toContain('<Positions />'); expect(workspace).toContain('<Builder />'); expect(workspace).not.toContain('lpApi.post');
  for (const path of ['apps/web/app/lp/copy/page.tsx', 'apps/web/app/lp/whales/page.tsx']) expect(readFileSync(path, 'utf8')).toContain('<LpCopyPanel');
  expect(copy).not.toMatch(/CURATED_LP_MASTERS|85\.0%|Forward-only execution enabled|184\.2/);
  expect(copy).toContain('Subscription recorded only'); expect(copy).toContain('No recorded masters'); expect(copy).toContain('not an empty leaderboard');
  expect(discover).not.toMatch(/'0\.0%'|'\$0'|Live Feed/);
});
