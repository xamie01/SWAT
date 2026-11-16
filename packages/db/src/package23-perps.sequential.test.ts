import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closePerpsPosition, getPerpsAccount, getUserPerpsPositions,
  recordPerpsOrder, upsertPerpsAccount, upsertPerpsPosition
} from './polymarket-perps.js';
import { forUser } from './tenancy.js';

const db = vi.hoisted(() => ({ query: vi.fn(), scopedQuery: vi.fn() }));
vi.mock('./client.js', () => ({ query: db.query }));
vi.mock('./tenancy.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tenancy.js')>();
  return { ...original, scopedQuery: db.scopedQuery };
});
// Keep the real forUser constructor, without loading a database client.
vi.mock('./transaction.js', () => ({ withTransaction: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockResolvedValue([]);
  db.scopedQuery.mockResolvedValue([]);
});

describe('package23 scoped perps liabilities and financial close refusal', () => {
  it.each(['open', 'closing'])('does not close or hide owned %s exposure', async (status) => {
    const row = { id: 'position-1', user_id: 'user-1', status };
    db.scopedQuery.mockResolvedValue([row]);
    await expect(closePerpsPosition('position-1', 'user-1')).rejects.toMatchObject({
      name: 'PerpsCloseUnavailableError', code: 'PERPS_CLOSE_UNAVAILABLE',
      message: expect.stringMatching(/financial.*reducing execution.*reconciliation.*not configured/i)
    });
    expect(row.status).toBe(status);
    expect(db.query).not.toHaveBeenCalled();
    expect(db.scopedQuery).toHaveBeenCalledTimes(1);
    const [scope, sql, values] = db.scopedQuery.mock.calls[0]!;
    expect(scope).toEqual(forUser('user-1'));
    expect(sql).toMatch(/^\s*SELECT\b/i);
    expect(sql).toMatch(/status IN \('open', 'closing'\)/);
    expect(sql).not.toMatch(/UPDATE|DELETE|INSERT/i);
    expect(values).toEqual(['position-1', 'user-1']);
  });

  it.each(['missing', 'other-owner', 'closed', 'liquidated'])('returns false for %s without writes', async () => {
    // The scoped SELECT excludes these rows, just as a tenant DB would.
    await expect(closePerpsPosition('position-1', 'user-1')).resolves.toBe(false);
    expect(db.query).not.toHaveBeenCalled();
    expect(db.scopedQuery).toHaveBeenCalledWith(forUser('user-1'),
      expect.stringMatching(/id = \$1 AND user_id = \$2/), ['position-1', 'user-1']);
  });

  it('includes closing liabilities in the default and explicit open portfolio', async () => {
    await getUserPerpsPositions('user-1');
    await getUserPerpsPositions('user-1', 'open');
    for (const [scope, sql, values] of db.scopedQuery.mock.calls) {
      expect(scope).toEqual(forUser('user-1'));
      expect(sql).toMatch(/status = ANY\(\$2::text\[\]\)/);
      expect(values).toEqual(['user-1', ['open', 'closing']]);
    }
    expect(db.scopedQuery).toHaveBeenCalledTimes(2);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('preserves explicit non-open status selection', async () => {
    await getUserPerpsPositions('user-1', 'closed');
    expect(db.scopedQuery).toHaveBeenCalledWith(forUser('user-1'), expect.any(String),
      ['user-1', ['closed']]);
  });

  it('scopes every tenant account/position/order query without changing signatures', async () => {
    await getPerpsAccount('user-1');
    await upsertPerpsAccount({ userId: 'user-1', totalAccountValue: '10', availableOrderMargin: '0',
      totalInitialMargin: '10', totalMaintenanceMargin: '1', withdrawable: '0' });
    await upsertPerpsPosition({ userId: 'user-1', instrumentId: 1, symbol: 'BTC-PERP', side: 'LONG',
      size: '1', entryPrice: '10', leverage: 1, initialMargin: '10', maintenanceMargin: '1', unrealizedPnl: '0' });
    await recordPerpsOrder({ userId: 'user-1', instrumentId: 1, symbol: 'BTC-PERP', side: 'BUY', price: '10', quantity: '1' });
    expect(db.scopedQuery).toHaveBeenCalledTimes(4);
    for (const [scope, , values] of db.scopedQuery.mock.calls) {
      expect(scope).toEqual(forUser('user-1'));
      expect(values[0]).toBe('user-1');
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it.each(['', ' ', '*'])('rejects blank/wildcard tenant %j before querying', async (userId) => {
    await expect(getPerpsAccount(userId)).rejects.toThrow('non-wildcard user id');
    await expect(closePerpsPosition('position-1', userId)).rejects.toThrow('non-wildcard user id');
    expect(db.query).not.toHaveBeenCalled();
    expect(db.scopedQuery).not.toHaveBeenCalled();
  });
});
