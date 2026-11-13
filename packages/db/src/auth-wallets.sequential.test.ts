import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn(), client: { query: vi.fn(), on: vi.fn(), off: vi.fn(), release: vi.fn() }, rows: [] as any[], events: [] as any[] }));
vi.mock('./client.js', () => ({ query: db.query, pool: { connect: async () => db.client } }));
import { linkAuthWallet, listAuthWallets, findUserIdByAuthWallet } from './auth-wallets.js';
const userId = '11111111-1111-4111-8111-111111111111';
const address = '0x1111111111111111111111111111111111111111';
beforeEach(() => {
  vi.clearAllMocks(); db.rows = []; db.events = [];
  db.query.mockImplementation(async (sql: string) => db.rows.filter(r => !sql.includes('EXISTS') || db.events.some(e => e === r.address)));
  let rows: any[], events: any[];
  db.client.query.mockImplementation(async (sql: string) => {
    if (sql === 'COMMIT') return { rows: [], command: 'COMMIT' };
    if (sql === 'BEGIN') { rows = [...db.rows]; events = [...db.events]; }
    if (sql === 'ROLLBACK') { db.rows = rows; db.events = events; }
    if (sql.includes('INSERT INTO user_auth_wallets')) { db.rows = [{ id: 'wallet', user_id: userId, chain_kind: 'evm', address, verified_at: new Date() }]; return { rows: db.rows }; }
    if (sql.includes('INSERT INTO audit_log')) db.events.push(address);
    return { rows: [] };
  });
});
it('does not expose a historical link without a verified-link audit as a login or payer', async () => {
  db.rows = [{ user_id: userId, chain_kind: 'evm', address }];
  expect(await listAuthWallets({ userId } as any)).toEqual([]);
  expect(await findUserIdByAuthWallet('evm', address)).toBeNull();
});
it('verified linking remains usable for wallet login and billing', async () => {
  await linkAuthWallet({ userId } as any, { chainKind: 'evm', address });
  expect(await findUserIdByAuthWallet('evm', address)).toBe(userId);
  expect(await listAuthWallets({ userId } as any)).toHaveLength(1);
});
it('does not leave a link after proof provenance persistence fails', async () => {
  const run = db.client.query.getMockImplementation()!;
  db.client.query.mockImplementation(async (sql: string) => { if (sql.includes('INSERT INTO audit_log')) throw new Error('audit failed'); return run(sql); });
  await expect(linkAuthWallet({ userId } as any, { chainKind: 'evm', address })).rejects.toThrow('audit failed');
  expect(await findUserIdByAuthWallet('evm', address)).toBeNull();
});
