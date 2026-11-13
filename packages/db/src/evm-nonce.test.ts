import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const client = {
    query: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    connect: vi.fn(async () => {}),
    end: vi.fn(async () => {})
  };
  return { client };
});

vi.mock('pg', () => ({ Client: class { constructor() { return mocks.client; } } }));

import { evmNonceLockKey, withEvmNonceLock } from './evm-nonce.js';
const role = { role_name: 'swat_app', session_role: 'swat_app', rolsuper: false, rolbypassrls: false,
  rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false,
  has_memberships: false, owns_objects: false, can_create: false, row_security: 'on' };
afterEach(() => vi.unstubAllEnvs());

/** Mirrors `pg_try_advisory_lock` returning `locked`, then the unlock. */
function grantLock(): void {
  mocks.client.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [role] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true, backend_pid: 101 }] };
    return { rows: [{ unlocked: true, backend_pid: 101 }] };
  });
}

function refuseLock(): void {
  mocks.client.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [role] };
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: false, backend_pid: 101 }] };
    return { rows: [{ unlocked: true, backend_pid: 101 }] };
  });
}

describe('evmNonceLockKey (S4-M12)', () => {
  it('separates the same address on different chains', () => {
    // Nonces are per (chain, account). Keying on the address alone would
    // serialise a user's Polymarket and Robinhood mirrors against each other.
    const account = '0x1111111111111111111111111111111111111111';
    expect(evmNonceLockKey('polygon', account)).not.toBe(
      evmNonceLockKey('robinhood-chain', account)
    );
  });

  it('separates different accounts on the same chain', () => {
    expect(evmNonceLockKey('robinhood-chain', '0x' + '1'.repeat(40))).not.toBe(
      evmNonceLockKey('robinhood-chain', '0x' + '2'.repeat(40))
    );
  });

  it('treats checksummed and lowercased forms of one address as the same lock', () => {
    // viem returns `getAddress` (checksummed) form; `resolveChainValue`
    // lowercases every EVM value. If these keyed differently the two code paths
    // would not exclude each other, which is exactly the bug being fixed.
    const checksummed = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    expect(evmNonceLockKey('robinhood-chain', checksummed)).toBe(
      evmNonceLockKey('robinhood-chain', checksummed.toLowerCase())
    );
  });

  it('ignores surrounding whitespace', () => {
    const account = '0x' + 'a'.repeat(40);
    expect(evmNonceLockKey('polygon', ` ${account} `)).toBe(evmNonceLockKey('polygon', account));
  });

  it('refuses a chain-prefixed address', () => {
    // A prefixed value would key differently from the bare address the executor
    // signs with, so the two would not exclude each other — silently.
    expect(() => evmNonceLockKey('robinhood-chain', 'robinhood-chain:0x' + '1'.repeat(40)))
      .toThrow(/bare address/);
  });

  it('refuses an empty account', () => {
    expect(() => evmNonceLockKey('polygon', '   ')).toThrow(/non-empty account/);
  });

  it('is namespaced away from other advisory locks', () => {
    expect(evmNonceLockKey('polygon', '0x' + '1'.repeat(40))).toContain('evm-nonce');
  });
});

describe('withEvmNonceLock (S4-M12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DIRECT_DATABASE_URL', 'postgresql://swat_app:fixture@127.0.0.1:59998/review_test');
    vi.stubEnv('DIRECT_DATABASE_SESSION_CONFIRMED', 'true');
  });

  it('runs the critical section and releases the lock', async () => {
    grantLock();
    const run = vi.fn().mockResolvedValue('submitted');

    await expect(withEvmNonceLock({ chain: 'robinhood-chain', account: '0xabc', run }))
      .resolves.toEqual({ acquired: true, result: 'submitted' });

    expect(run).toHaveBeenCalledOnce();
    const sql = mocks.client.query.mock.calls.map(([text]) => text as string);
    expect(sql.some((s) => s.includes('pg_try_advisory_lock'))).toBe(true);
    expect(sql.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(mocks.client.end).toHaveBeenCalledOnce();
  });

  it('does NOT run the critical section when another holder has the lock', async () => {
    // The whole point: a second concurrent job must not read the same pending
    // nonce. Running anyway would reintroduce the bug.
    refuseLock();
    const run = vi.fn();

    await expect(withEvmNonceLock({ chain: 'robinhood-chain', account: '0xabc', run }))
      .resolves.toEqual({ acquired: false });

    expect(run).not.toHaveBeenCalled();
  });

  it('does not attempt an unlock it never acquired', async () => {
    // Unlocking a lock we do not hold logs a Postgres warning and, worse, would
    // release a *different* holder's lock if the key ever collided.
    refuseLock();
    await withEvmNonceLock({ chain: 'polygon', account: '0xabc', run: vi.fn() });

    const sql = mocks.client.query.mock.calls.map(([text]) => text as string);
    expect(sql.some((s) => s.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('releases the lock and rethrows when the critical section fails', async () => {
    grantLock();
    const boom = new Error('submit failed');

    await expect(withEvmNonceLock({
      chain: 'robinhood-chain',
      account: '0xabc',
      run: vi.fn().mockRejectedValue(boom)
    })).rejects.toBe(boom);

    const sql = mocks.client.query.mock.calls.map(([text]) => text as string);
    expect(sql.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
    expect(mocks.client.end).toHaveBeenCalledOnce();
  });

  it('destroys the connection when the unlock fails, so the lock cannot leak', async () => {
    // A session advisory lock dies with its backend session. Returning a client
    // that still holds the lock to the pool would wedge the account for the life
    // of that pooled connection — worse than failing this one trade.
    mocks.client.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: [role] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true, backend_pid: 101 }] };
      if (sql.includes('pg_advisory_unlock')) throw new Error('backend gone');
      return { rows: [{ unlocked: true, backend_pid: 101 }] };
    });

    await expect(withEvmNonceLock({
      chain: 'robinhood-chain',
      account: '0xabc',
      run: vi.fn().mockResolvedValue(1)
    })).rejects.toThrow('backend gone');

    expect(mocks.client.end).toHaveBeenCalledOnce();
  });

  it('always destroys the dedicated session', async () => {
    grantLock();
    await withEvmNonceLock({ chain: 'polygon', account: '0xabc', run: vi.fn() });
    expect(mocks.client.end).toHaveBeenCalledOnce();
  });

  it('registers and removes a client error handler around the critical section', async () => {
    // A database restart mid-trade emits 'error' on the checked-out client; with
    // no listener that throws and takes the process down instead of failing one
    // trade. Same hardening as `withTransaction`.
    grantLock();
    await withEvmNonceLock({ chain: 'polygon', account: '0xabc', run: vi.fn() });
    expect(mocks.client.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mocks.client.off).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
