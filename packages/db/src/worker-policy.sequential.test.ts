import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { readCurrentWorkerPolicyWithClient, captureWorkerPolicyWithClient, readCapturedWorkerPolicyWithClient } from './worker-policy.js';
const userId = '11111111-1111-1111-1111-111111111111';
const identity = { userId, chain: 'solana' as const, tokenMint: 'solana:token', targetAccount: 'solana:target', masterWalletAddress: 'solana:master' };
const at = new Date('2026-11-16T00:00:00Z');
const configs = [{ key: 'trading', value: { enabled: true }, updated_at: at },
  { key: 'signals', value: { auto_execute_min_score: 80 }, updated_at: at },
  { key: 'execution_config', value: { solana: 'paper' }, updated_at: at }];
let client: PoolClient;
let state: string;
let killed: boolean;
beforeEach(() => {
  state = 'active'; killed = false;
  client = { query: vi.fn(async (sql: string) => {
    if (sql.includes('FROM config')) return { rows: configs };
    if (sql.includes('FROM users')) return { rows: [{ status: 'active' }] };
    if (sql.includes('FROM user_execution_settings')) return { rows: [{ auto_execute: true, killed, min_signal_score: 90, updated_at: at }] };
    if (sql.includes('FROM user_chain_execution_settings')) return { rows: [{ mode: 'paper', max_slippage_bps: 40, updated_at: at }] };
    if (sql.includes('FROM user_wallet_subscriptions')) return { rows: [{ state, active_since: at }] };
    return { rows: [] };
  }) } as unknown as PoolClient;
});
describe('real persisted current policy reader and claim capture', () => {
  it('joins platform/user/chain/subscription controls on caller client under SHARE locks', async () => {
    const result = await readCurrentWorkerPolicyWithClient(client, identity);
    expect(result).toMatchObject({ minimumScore: 90, platformMode: 'paper', snapshot: { autoExecute: true, killed: false, mirrors: 'buys-and-sells', maxSlippageBps: 40 } });
    expect(vi.mocked(client.query).mock.calls).toHaveLength(5);
    expect(vi.mocked(client.query).mock.calls.every(call => String(call[0]).includes('FOR SHARE'))).toBe(true);
  });
  it('wind-down permits only sells, ended/killed never reads as active', async () => {
    state = 'winding_down';
    expect((await readCurrentWorkerPolicyWithClient(client, identity))!.snapshot.mirrors).toBe('sells-only');
    state = 'ended'; killed = true;
    expect((await readCurrentWorkerPolicyWithClient(client, identity))!.snapshot).toMatchObject({ mirrors: 'none', killed: true });
  });
  it('missing settings/config refuses rather than applying UI defaults or env flags', async () => {
    vi.mocked(client.query).mockResolvedValue({ rows: [] } as never);
    expect(await readCurrentWorkerPolicyWithClient(client, identity)).toBeNull();
  });
  it('captures immutable current revision on actual claim and reads it scoped to tenant/account/master/mode', async () => {
    const execution = { ...identity, id: 'execution', executionMode: 'paper' } as never;
    await captureWorkerPolicyWithClient(client, execution, identity.masterWalletAddress);
    const insert = vi.mocked(client.query).mock.calls.find(call => String(call[0]).startsWith('INSERT INTO copy_execution_policy_snapshots'))!;
    expect(insert[1]).toEqual(expect.arrayContaining([userId, identity.targetAccount, identity.masterWalletAddress, 'paper']));
    expect(String(insert[0])).toContain('ON CONFLICT (execution_id) DO NOTHING');
    await readCapturedWorkerPolicyWithClient(client, execution, identity.masterWalletAddress);
    const selected = vi.mocked(client.query).mock.calls.at(-1)!;
    expect(selected[1]).toEqual(['execution', userId, 'solana', 'solana:target', 'solana:token', 'solana:master', 'paper']);
  });
});
