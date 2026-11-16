import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
const mocks = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn(), connect: vi.fn() }));
vi.mock('./client.js', () => ({ query: mocks.query, pool: { connect: mocks.connect } }));
import { persistDiscoveredWalletBackfill, persistDiscoveredWalletBackfillWithClient, listPendingDiscoveryBackfills, acknowledgeDiscoveryBackfill } from './discovery-queries.js';
const address = 'solana:11111111111111111111111111111111';
const input = { address, source: 'discovered' as const, discoveryMethod: 'funding' as const };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, on: vi.fn(), off: vi.fn(), release: vi.fn() });
  mocks.clientQuery.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT address')) return { rows: [{ address, chain: 'solana' }] };
    if (sql.startsWith('SELECT id FROM discovery')) return { rows: [{ id: 'intent-a' }] };
    return { rows: [], command: sql === 'COMMIT' ? 'COMMIT' : undefined };
  });
});
describe('package24 discovery durable database seam', () => {
  it('wallet and pending intent use one committed client and never update existing wallet metadata', async () => {
    await expect(persistDiscoveredWalletBackfill(input)).resolves.toEqual({ address, chain: 'solana', intentId: 'intent-a' });
    const statements = mocks.clientQuery.mock.calls.map(call => String(call[0]));
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.find(sql => sql.startsWith('INSERT INTO wallets'))).toContain('ON CONFLICT (address) DO NOTHING');
    expect(statements.some(sql => sql.includes('UPDATE wallets'))).toBe(false);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it('missing intent schema rolls back the wallet insert instead of leaving an orphan obligation', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT address')) return { rows: [{ address, chain: 'solana' }] };
      if (sql.startsWith('INSERT INTO discovery')) throw new Error('intent relation missing');
      return { rows: [] };
    });
    await expect(persistDiscoveredWalletBackfill(input)).rejects.toThrow('intent relation missing');
    const statements = mocks.clientQuery.mock.calls.map(call => call[0]);
    expect(statements.at(-1)).toBe('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
  });
  it('caller-client composition does not obtain another connection or BEGIN/COMMIT', async () => {
    const client = { query: mocks.clientQuery } as unknown as PoolClient;
    await persistDiscoveredWalletBackfillWithClient(client, input);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.clientQuery.mock.calls.map(call => call[0])).not.toContain('BEGIN');
  });
  it('reads pending independently of absent-wallet candidates and acknowledges only queue acceptance', async () => {
    mocks.query.mockResolvedValue([{ id: 'intent-a', wallet_address: address, chain: 'solana' }]);
    await expect(listPendingDiscoveryBackfills()).resolves.toEqual([{ address, chain: 'solana', intentId: 'intent-a' }]);
    expect(mocks.query.mock.calls[0][0]).toContain("WHERE state = 'pending'");
    await acknowledgeDiscoveryBackfill('intent-a');
    expect(mocks.query.mock.calls[1][0]).toContain("state = 'enqueued'");
  });
  it('rejects ambiguous EVM and malformed canonical address before database access', async () => {
    await expect(persistDiscoveredWalletBackfill({ ...input, address: '0xabcdef0123456789abcdef0123456789abcdef01' })).rejects.toThrow('explicit chain');
    await expect(persistDiscoveredWalletBackfill({ ...input, address: 'solana:bad' })).rejects.toThrow('Invalid solana');
    expect(mocks.clientQuery.mock.calls.some(call => String(call[0]).startsWith('INSERT'))).toBe(false);
  });
});
