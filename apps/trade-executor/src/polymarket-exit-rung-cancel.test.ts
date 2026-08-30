import { describe, expect, it, vi } from 'vitest';

/**
 * `S4-M36` — proof that the *rung submitter* reads cancellation correctly and
 * refuses to place the next rung against an order it cannot prove is dead.
 *
 * `polymarket-cancellation.test.ts` covers the pure helpers. These cases are
 * about the thing the item actually calls a defect: the submitter had `fetchOrder`
 * in hand, read `sizeMatched` from it, and threw the status away. The helpers are
 * deliberately NOT stubbed here — if the submitter stopped calling them, or went
 * back to inferring cancellation from an absent exception, the assertions below
 * fail.
 */

process.env.EVM_PRIVATE_KEY = 'test-only-placeholder';
process.env.POLYMARKET_SIGNATURE_TYPE = 'EOA';
process.env.POLYMARKET_BUILDER_CODE = `0x${'a'.repeat(64)}`;

vi.mock('ethers', () => {
  const mockProvider = { getNetwork: vi.fn().mockResolvedValue({ chainId: 137 }) };
  const mockWallet = {
    address: '0x1111111111111111111111111111111111111111',
    connect: vi.fn().mockReturnThis()
  };
  return {
    ethers: {
      providers: { JsonRpcProvider: vi.fn().mockReturnValue(mockProvider) },
      Wallet: vi.fn().mockReturnValue(mockWallet),
      utils: { getAddress: vi.fn((value: string) => value) }
    }
  };
});

vi.mock('@swat/db', () => ({
  query: vi.fn().mockResolvedValue([]),
  recordCopyExecutionEvidence: vi.fn().mockResolvedValue(undefined),
  transitionCopyExecution: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('@polymarket/client/actions', () => ({
  fetchBalanceAllowance: vi.fn(),
  fetchBuilderFeeRates: vi.fn()
}));

vi.mock('bullmq', () => ({
  UnrecoverableError: class UnrecoverableError extends Error {}
}));

const {
  createPolymarketExitRungSubmitter,
  POLYMARKET_RUNG_CANCEL_ATTEMPTS
} = await import('./polymarket.js');
import type { PolymarketExitLimitRung } from './polymarket-exit-escalation.js';

const ORDER_ID = 'rung-order-1';

function rung(overrides: Partial<PolymarketExitLimitRung> = {}): PolymarketExitLimitRung {
  return {
    kind: 'limit',
    attempt: 0,
    rungBps: 150,
    price: 0.58,
    shares: 40,
    expiration: Math.floor(Date.now() / 1000) + 180,
    effectiveLifetimeMs: 120_000,
    crossesBook: false,
    ...overrides
  };
}

/** The `OpenOrder` shape `/trading/manage-orders` documents `fetchOrder` returning. */
function openOrder(params: { status: string; sizeMatched: string }) {
  return {
    id: ORDER_ID,
    conditionId: `0x${'1'.repeat(64)}`,
    tokenId: '99887766',
    owner: 'owner',
    makerAddress: '0x1111111111111111111111111111111111111111',
    side: 'SELL',
    price: '0.58',
    originalSize: '40',
    sizeMatched: params.sizeMatched,
    outcome: 'Yes',
    orderType: 'GTD',
    status: params.status,
    associateTrades: [],
    createdAt: new Date().toISOString()
  } as never;
}

function submitter(options: {
  cancelOrder: (input: { orderId: string }) => Promise<unknown>;
  fetchOrder: (input: { orderId: string }) => Promise<never>;
  emitAlert?: (alert: { orderId: string; reason: string }) => Promise<void>;
}) {
  const logs: string[] = [];
  const slept: number[] = [];
  const submit = createPolymarketExitRungSubmitter({
    tokenID: '99887766',
    sleep: async (ms: number) => { slept.push(ms); },
    submit: async () => ({ orderId: ORDER_ID }),
    cancelOrder: options.cancelOrder,
    fetchOrder: options.fetchOrder,
    emitAlert: options.emitAlert,
    cancelRetryDelayMs: 1,
    log: (message: string) => logs.push(message)
  });
  return { submit, logs, slept };
}

describe('createPolymarketExitRungSubmitter cancellation reading (S4-M36)', () => {
  it('reports the fill when the order is terminal', async () => {
    const { submit } = submitter({
      cancelOrder: async () => ({ canceled: [ORDER_ID], not_canceled: {} }),
      fetchOrder: async () => openOrder({ status: 'MATCHED', sizeMatched: '12' })
    });

    await expect(submit(rung())).resolves.toEqual({ filledShares: 12 });
  });

  it('accepts an expired order as terminal — the GTD expiry is the normal path', async () => {
    const { submit } = submitter({
      cancelOrder: async () => ({
        canceled: [],
        not_canceled: { [ORDER_ID]: 'order already matched' }
      }),
      fetchOrder: async () => openOrder({ status: 'EXPIRED', sizeMatched: '0' })
    });

    await expect(submit(rung())).resolves.toEqual({ filledShares: 0 });
  });

  it('THROWS rather than reporting a partial fill when the rung is still resting', async () => {
    // The oversell path, in one test. Before the fix: the cancel landed in
    // not_canceled with no exception, the catch never ran, sizeMatched was read as
    // a partial fill, and the ladder placed the next rung for the remainder —
    // leaving two live sell orders on the same position.
    const { submit } = submitter({
      cancelOrder: async () => ({
        canceled: [],
        not_canceled: { [ORDER_ID]: 'internal error' }
      }),
      fetchOrder: async () => openOrder({ status: 'LIVE', sizeMatched: '15' })
    });

    await expect(submit(rung())).rejects.toThrow(/not provably retired/);
  });

  it('does not accept a confirmed cancel while the order still reads LIVE', async () => {
    // The venue can answer 200-with-canceled and still have the order on the
    // book from the read's point of view. The fetched order is authoritative.
    const { submit } = submitter({
      cancelOrder: async () => ({ canceled: [ORDER_ID], not_canceled: {} }),
      fetchOrder: async () => openOrder({ status: 'LIVE', sizeMatched: '0' })
    });

    await expect(submit(rung())).rejects.toThrow(/not provably retired/);
  });

  it('retries the cancel and proceeds once the order goes terminal', async () => {
    const statuses = ['LIVE', 'LIVE', 'CANCELED'];
    let call = 0;
    const cancelOrder = vi.fn(async () => ({ canceled: [], not_canceled: {} }));
    const { submit } = submitter({
      cancelOrder,
      fetchOrder: async () => openOrder({
        status: statuses[call++] ?? 'CANCELED',
        sizeMatched: '5'
      })
    });

    await expect(submit(rung())).resolves.toEqual({ filledShares: 5 });
    expect(cancelOrder).toHaveBeenCalledTimes(3);
  });

  it('stops after the configured attempt budget rather than spinning', async () => {
    const cancelOrder = vi.fn(async () => ({ canceled: [], not_canceled: {} }));
    const { submit } = submitter({
      cancelOrder,
      fetchOrder: async () => openOrder({ status: 'LIVE', sizeMatched: '0' })
    });

    await expect(submit(rung())).rejects.toThrow(/not provably retired/);
    expect(cancelOrder).toHaveBeenCalledTimes(POLYMARKET_RUNG_CANCEL_ATTEMPTS);
  });

  it('alerts before it stops, so a blocked ladder is not silent', async () => {
    const emitAlert = vi.fn(async () => {});
    const { submit } = submitter({
      cancelOrder: async () => ({ canceled: [], not_canceled: {} }),
      fetchOrder: async () => openOrder({ status: 'LIVE', sizeMatched: '0' }),
      emitAlert
    });

    await expect(submit(rung())).rejects.toThrow();
    expect(emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID })
    );
  });

  it('treats a thrown cancel as saying nothing, and still decides from the order', async () => {
    // A transport failure is not evidence the order died. The old code logged it
    // and carried on to read sizeMatched as though the cancel had worked.
    const { submit } = submitter({
      cancelOrder: async () => { throw new Error('ECONNRESET'); },
      fetchOrder: async () => openOrder({ status: 'LIVE', sizeMatched: '0' })
    });

    await expect(submit(rung())).rejects.toThrow(/not provably retired/);
  });

  it('proceeds when a thrown cancel is followed by a terminal order', async () => {
    const { submit } = submitter({
      cancelOrder: async () => { throw new Error('ECONNRESET'); },
      fetchOrder: async () => openOrder({ status: 'CANCELED', sizeMatched: '40' })
    });

    await expect(submit(rung())).resolves.toEqual({ filledShares: 40 });
  });

  it('refuses an order id the venue swapped underneath it', async () => {
    const { submit } = submitter({
      cancelOrder: async () => ({ canceled: [], not_canceled: {} }),
      fetchOrder: async () => ({
        ...(openOrder({ status: 'CANCELED', sizeMatched: '0' }) as never as Record<string, unknown>),
        id: 'a-different-order'
      }) as never
    });

    await expect(submit(rung())).rejects.toThrow(/returned order a-different-order/);
  });

  it('waits out the rung lifetime before it tries to cancel', async () => {
    const { submit, slept } = submitter({
      cancelOrder: async () => ({ canceled: [ORDER_ID] }),
      fetchOrder: async () => openOrder({ status: 'CANCELED', sizeMatched: '0' })
    });

    await submit(rung({ effectiveLifetimeMs: 120_000 }));
    expect(slept[0]).toBe(120_000);
  });
});
