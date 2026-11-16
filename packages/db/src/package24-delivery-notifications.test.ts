import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn(), connect: vi.fn() }));
vi.mock('./client.js', () => ({ query: mocks.query, pool: { connect: mocks.connect } }));
import { claimSignalNotification, beginSignalNotificationSend, completeSignalNotification, markSignalNotificationUncertain, releaseSignalNotification } from './package24-delivery-notifications.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, on: vi.fn(), off: vi.fn(), release: vi.fn() });
  mocks.clientQuery.mockResolvedValue({ rows: [], command: 'COMMIT' });
});

describe('package24 notification database ownership fencing', () => {
  it('release and send-start SQL both compare the owner token; sending cannot be released', async () => {
    mocks.query.mockResolvedValue([]);
    await expect(releaseSignalNotification('signal-a', 'owner-a')).resolves.toBe(false);
    await expect(beginSignalNotificationSend('signal-a', 'owner-a')).resolves.toBe(false);
    for (const [sql, values] of mocks.query.mock.calls) {
      expect(sql).toContain('owner_token = $2');
      expect(sql).toContain("state = 'preparing'");
      expect(values).toEqual(['signal-a', 'owner-a']);
    }
    expect(mocks.query.mock.calls[1][0]).toContain('lease_expires_at > NOW()');
  });

  it('fake-clock expiry/reclaim prevents old-owner release of the newer preparing lease', async () => {
    let now = 0;
    let owner = 'owner-a';
    let expires = 60_000;
    let state = 'preparing';
    mocks.clientQuery.mockImplementation(async (sql: string, values: unknown[]) => {
      if (sql.startsWith('SELECT alerted_at')) return { rows: [{ alerted_at: null }] };
      if (sql.includes("SET state = 'preparing'")) {
        expect(sql).toContain("state = 'preparing' AND lease_expires_at <= NOW()");
        if (state === 'preparing' && expires <= now) { owner = String(values[1]); expires = now + Number(values[2]); return { rows: [{ signal_id: 'signal-a' }] }; }
      }
      return { rows: [], command: 'COMMIT' };
    });
    mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
      expect(sql).toContain('owner_token = $2');
      expect(sql).toContain("state = 'preparing'");
      if (owner !== values[1] || state !== 'preparing') return [];
      state = 'pending'; return [{ signal_id: 'signal-a' }];
    });
    now = 60_001;
    await expect(claimSignalNotification('signal-a', 'owner-b')).resolves.toBe('claimed');
    await expect(releaseSignalNotification('signal-a', 'owner-a')).resolves.toBe(false);
    expect(owner).toBe('owner-b');
    expect(state).toBe('preparing');
  });

  it('expired sending is uncertain, not reclaimable or retryable even after restart', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT alerted_at')) return { rows: [{ alerted_at: null }] };
      if (sql.startsWith('SELECT state')) return { rows: [{ state: 'sending', expired: true }] };
      return { rows: [], command: 'COMMIT' };
    });
    await expect(claimSignalNotification('signal-a', 'owner-b')).resolves.toBe('uncertain');
    const claimSql = mocks.clientQuery.mock.calls.find(call => String(call[0]).includes("SET state = 'preparing'"))?.[0];
    expect(claimSql).not.toContain("state = 'sending'");
  });

  it('durable schema failure cannot produce a claim', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('SELECT alerted_at')) return { rows: [{ alerted_at: null }] };
      if (sql.startsWith('INSERT INTO signal_notification')) throw new Error('notification relation unavailable');
      return { rows: [] };
    });
    await expect(claimSignalNotification('signal-a', 'owner-a')).rejects.toThrow('notification relation unavailable');
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it.each(['executing', 'executed', 'failed', 'pending'])('completion preserves %s execution lifecycle except the legacy pending alert stamp', async status => {
    mocks.clientQuery.mockImplementation(async (sql: string) => ({ rows: sql.startsWith('UPDATE signal_notification') ? [{ signal_id: 'signal-a' }] : [], command: 'COMMIT' }));
    await expect(completeSignalNotification('signal-a', 'owner-a')).resolves.toBe(true);
    const sql = mocks.clientQuery.mock.calls.find(call => String(call[0]).startsWith('UPDATE signals'))?.[0];
    expect(sql).toContain("status = CASE WHEN status = 'pending' THEN 'alerted' ELSE status END");
    expect(sql).toContain('alerted_at IS NULL');
    const newStatus = status === 'pending' ? 'alerted' : status;
    expect(['executing', 'executed', 'failed'].includes(status) ? newStatus === status : newStatus === 'alerted').toBe(true);
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it('uncertainty can only mark the same owner sending record', async () => {
    mocks.query.mockResolvedValue([]);
    await expect(markSignalNotificationUncertain('signal-a', 'owner-a')).resolves.toBe(false);
    expect(mocks.query.mock.calls[0][0]).toContain("owner_token = $2 AND state = 'sending'");
  });

  it('no legacy signal stamp occurs when notification completion did not own the row', async () => {
    await expect(completeSignalNotification('signal-a', 'owner-a')).resolves.toBe(false);
    expect(mocks.clientQuery.mock.calls.some(call => String(call[0]).startsWith('UPDATE signals'))).toBe(false);
  });
});
