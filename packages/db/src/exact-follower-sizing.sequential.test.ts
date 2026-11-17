import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createExactFollowerEntryRequest } from './exact-follower-sizing.js';
const now = new Date('2026-11-17T00:00:00Z');
const descriptor = { chain: 'solana' as const, data: { userId: '11111111-1111-1111-1111-111111111111',
  targetAccount: 'solana:target', tokenMint: 'solana:token', executionMode: 'paper', direction: 'buy' } };
const balance = { providerId: 'reviewed', providerIdentity: 'backend-v1', evidenceId: 'balance-1',
  userId: descriptor.data.userId, chain: descriptor.chain, network: 'solana-fixture', targetAccount: descriptor.data.targetAccount,
  executionMode: 'paper' as const, availableUsd: '9007199254740993.123456789123456789', observedAt: now,
  expiresAt: new Date(now.getTime()+5000) };
function setup(observation = balance, cap = '999999999999999999', spent = '0') {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('user_execution_settings')
    ? [{ max_position_pct: '0.1', auto_execute: true, killed: false }]
    : [{ cap_usd: cap, spent, enabled: true, accounting_ready: true, unknown: false }] }));
  const provider = { providerId: 'reviewed', providerIdentity: 'backend-v1', networkForChain: () => 'solana-fixture',
    readBalance: vi.fn(async () => observation) };
  return { query, provider, client: { query } as unknown as PoolClient,
    request: createExactFollowerEntryRequest({ provider, now: () => now, maximumAgeMs: 1000 }) };
}
describe('exact follower buy sizing consumed by canonical fanout', () => {
  it('computes persisted follower percentage exactly instead of master quantity or float balance', async () => {
    const s = setup(); expect(await s.request(s.client, descriptor)).toEqual({ requestedBaseQuantity: null,
      requestedQuoteQuantity: '9007199254740.993123456789123456' });
    expect(s.provider.readBalance).toHaveBeenCalledWith(s.client, expect.objectContaining({ userId: descriptor.data.userId }));
  });
  it('clamps exact budget to persisted outstanding risk liabilities', async () => {
    const s = setup(balance, '10.1', '9.9'); expect(await s.request(s.client, descriptor)).toEqual({
      requestedBaseQuantity: null, requestedQuoteQuantity: '0.2' });
    expect(s.query.mock.calls[1]![0]).toContain('liability_usd');
  });
  it.each(['userId','targetAccount','network','providerIdentity','executionMode'])('refuses mismatched provider %s scope', async field => {
    const s = setup({ ...balance, [field]: 'foreign' } as typeof balance); expect(await s.request(s.client, descriptor)).toBeNull();
    expect(s.query).not.toHaveBeenCalled();
  });
  it.each([new Date(now.getTime()-1001),new Date(now.getTime()+1)])('refuses stale/future balance', async observedAt => {
    const s = setup({ ...balance, observedAt }); expect(await s.request(s.client, descriptor)).toBeNull();
  });
  it('missing trusted provider stays explicitly unavailable', async () => {
    const s = setup(); const request = createExactFollowerEntryRequest({ provider: null, now: () => now, maximumAgeMs: 1000 });
    expect(await request(s.client, descriptor)).toBeNull(); expect(s.query).not.toHaveBeenCalled();
  });
  it('never turns missing persisted opt-in or unknown liability into a buy', async () => {
    const s = setup(); s.query.mockResolvedValue({ rows: [] }); expect(await s.request(s.client, descriptor)).toBeNull();
    s.query.mockImplementation(async sql => ({ rows: sql.includes('user_execution_settings')
      ? [{ max_position_pct: '1', auto_execute: true, killed: false }]
      : [{ cap_usd: '100', spent: '0', enabled: true, accounting_ready: true, unknown: true }] }));
    expect(await s.request(s.client, descriptor)).toBeNull();
  });
});
