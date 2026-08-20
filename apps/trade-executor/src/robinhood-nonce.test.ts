import { describe, expect, it, vi } from 'vitest';
import {
  NonceContentionError,
  executeRobinhoodOrder,
  type EvmNonceLock,
  type RobinhoodExecutionAdapter,
  type RobinhoodExecutionConfig,
  type RobinhoodPendingStore
} from './robinhood.js';

/**
 * S4-M12 — nonce serialisation.
 *
 * These cases deliberately use an order that fails validation immediately (an
 * empty `clientOrderId`), so the adapter and pending store are never reached.
 * What is under test is the *locking* around the order, not the order itself —
 * which has 28 cases of its own in `robinhood.test.ts`. Keeping the body trivial
 * means a failure here can only be the lock.
 */
function minimalOrder(account: `0x${string}`, nonceLock: EvmNonceLock) {
  return {
    order: {
      clientOrderId: '', // rejected before any adapter or store call
      token: '0x5000000000000000000000000000000000000005' as `0x${string}`,
      direction: 'buy' as const,
      amountInBaseUnits: 1n,
      slippageBps: 100
    },
    config: { maxSlippageBps: 500 } as unknown as RobinhoodExecutionConfig,
    account,
    adapter: {} as unknown as RobinhoodExecutionAdapter,
    pendingStore: {} as unknown as RobinhoodPendingStore,
    safetyAssessment: vi.fn(),
    requireReadiness: false as const,
    nonceLock
  };
}

const ACCOUNT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
const ACCOUNT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;

/** A lock whose critical section blocks until the returned latch is released. */
function latchedLock() {
  const entered: string[] = [];
  const released: string[] = [];
  const gates = new Map<string, () => void>();
  const lock: EvmNonceLock = async (account, run) => {
    entered.push(account);
    await new Promise<void>((resolve) => gates.set(account, resolve));
    const result = await run();
    released.push(account);
    return { acquired: true, result };
  };
  return {
    lock,
    entered,
    released,
    open: (account: string) => gates.get(account)?.()
  };
}

describe('cross-process nonce lock (S4-M12)', () => {
  it('refuses to run the order when the lock is held elsewhere', async () => {
    // The whole point of the item: a second process must not read the same
    // pending nonce. Running the body anyway is the bug.
    const run = vi.fn();
    const contended: EvmNonceLock = async () => {
      run();
      return { acquired: false };
    };

    await expect(executeRobinhoodOrder(minimalOrder(ACCOUNT_A, contended)))
      .rejects.toBeInstanceOf(NonceContentionError);
  });

  it('names the account in the contention error', async () => {
    const contended: EvmNonceLock = async () => ({ acquired: false });
    await expect(executeRobinhoodOrder(minimalOrder(ACCOUNT_A, contended)))
      .rejects.toThrow(new RegExp(ACCOUNT_A));
  });

  it('is NOT an UnrecoverableError, so the queue retries rather than burying the job', async () => {
    // An UnrecoverableError would drop the mirror permanently for a millisecond
    // overlap. BullMQ must be free to retry once the holder has submitted.
    const contended: EvmNonceLock = async () => ({ acquired: false });
    const error = await executeRobinhoodOrder(minimalOrder(ACCOUNT_A, contended)).catch((e) => e);
    expect(error).toBeInstanceOf(NonceContentionError);
    expect(error.constructor.name).toBe('NonceContentionError');
  });

  it('runs the order inside the lock, not around it', async () => {
    const calls: string[] = [];
    const lock: EvmNonceLock = async (account, run) => {
      calls.push('lock-acquired');
      const result = await run();
      calls.push('lock-released');
      return { acquired: true, result };
    };

    await executeRobinhoodOrder(minimalOrder(ACCOUNT_A, lock));
    expect(calls).toEqual(['lock-acquired', 'lock-released']);
  });

  it('passes the signing account through as the lock key', async () => {
    const seen: string[] = [];
    const lock: EvmNonceLock = async (account, run) => {
      seen.push(account);
      return { acquired: true, result: await run() };
    };
    await executeRobinhoodOrder(minimalOrder(ACCOUNT_B, lock));
    expect(seen).toEqual([ACCOUNT_B]);
  });
});

describe('in-process submission chain is per account (S4-M12)', () => {
  it('lets two different accounts hold their locks concurrently', async () => {
    // Before S4-M12 this chain was global: user B's mirror waited on user A's,
    // on a venue where being late is the entire risk. Both must be in flight.
    const { lock, entered, open } = latchedLock();

    const a = executeRobinhoodOrder(minimalOrder(ACCOUNT_A, lock));
    const b = executeRobinhoodOrder(minimalOrder(ACCOUNT_B, lock));
    await vi.waitFor(() => expect(entered).toHaveLength(2));

    expect(entered).toEqual([ACCOUNT_A, ACCOUNT_B]);
    open(ACCOUNT_A);
    open(ACCOUNT_B);
    await Promise.all([a, b]);
  });

  it('serialises two orders for the SAME account', async () => {
    // This is the ordering nonce allocation actually requires: one account's
    // second order must not read the pending nonce until the first has submitted.
    const { lock, entered, open } = latchedLock();

    const first = executeRobinhoodOrder(minimalOrder(ACCOUNT_A, lock));
    const second = executeRobinhoodOrder(minimalOrder(ACCOUNT_A, lock));
    await vi.waitFor(() => expect(entered).toHaveLength(1));

    // The second call has not entered the lock at all while the first is inside.
    expect(entered).toEqual([ACCOUNT_A]);

    open(ACCOUNT_A);
    await first;
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    open(ACCOUNT_A);
    await second;
  });

  it('releases the chain when an order throws, so one failure cannot wedge an account', async () => {
    const boom: EvmNonceLock = async () => { throw new Error('lock backend down'); };
    await expect(executeRobinhoodOrder(minimalOrder(ACCOUNT_A, boom)))
      .rejects.toThrow('lock backend down');

    // A wedged chain would hang here instead of resolving.
    const ok: EvmNonceLock = async (_a, run) => ({ acquired: true, result: await run() });
    await expect(executeRobinhoodOrder(minimalOrder(ACCOUNT_A, ok)))
      .resolves.toMatchObject({ status: 'skipped' });
  });

  it('releases the chain after a contention throw too', async () => {
    const contended: EvmNonceLock = async () => ({ acquired: false });
    await expect(executeRobinhoodOrder(minimalOrder(ACCOUNT_A, contended)))
      .rejects.toBeInstanceOf(NonceContentionError);

    const ok: EvmNonceLock = async (_a, run) => ({ acquired: true, result: await run() });
    await expect(executeRobinhoodOrder(minimalOrder(ACCOUNT_A, ok)))
      .resolves.toMatchObject({ status: 'skipped' });
  });

  it('treats differently-cased forms of one account as one chain', async () => {
    // viem returns checksummed addresses; other paths lowercase them. Two
    // spellings must not both proceed for the same account.
    const { lock, entered, open } = latchedLock();
    const upper = ACCOUNT_A.toUpperCase().replace('0X', '0x') as `0x${string}`;

    const first = executeRobinhoodOrder(minimalOrder(ACCOUNT_A, lock));
    const second = executeRobinhoodOrder(minimalOrder(upper, lock));
    await vi.waitFor(() => expect(entered).toHaveLength(1));
    expect(entered).toHaveLength(1);

    open(ACCOUNT_A);
    await first;
    await vi.waitFor(() => expect(entered).toHaveLength(2));
    open(upper);
    await second;
  });
});
