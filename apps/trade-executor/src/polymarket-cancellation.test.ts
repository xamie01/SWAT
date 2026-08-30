import { describe, expect, it } from 'vitest';
import {
  classifyPolymarketOrderLiveness,
  interpretPolymarketCancellation,
  planPolymarketRungRetirement,
  polymarketCancellationError
} from './polymarket-cancellation.js';

/**
 * Tests for the one shared reading of Polymarket's cancellation contract
 * (`S4-M36`).
 *
 * The fixtures below are the documented response bodies, copied from
 * `/trading/manage-orders` → *Cancellation Results* and
 * `/api-reference/trade/cancel-single-order`, not invented. That matters here
 * more than usual: the bug being fixed was a *misread of the contract*, so a test
 * written against a made-up shape would re-encode the same mistake.
 */

describe('interpretPolymarketCancellation', () => {
  it('confirms an order the venue listed in canceled', () => {
    expect(interpretPolymarketCancellation(
      { canceled: ['ORDER_ID_1'], not_canceled: {} },
      'ORDER_ID_1'
    )).toEqual({ kind: 'confirmed' });
  });

  it('reads a not_canceled refusal as terminal, with NO exception thrown', () => {
    // This is the exact documented example. The old code awaited cancelOrder in
    // a try/catch and only acted in the catch, so this 200 response — the one
    // failure path the cancel existed to cover — was silently read as success.
    const reading = interpretPolymarketCancellation(
      { canceled: ['ORDER_ID_1'], not_canceled: { ORDER_ID_2: 'order already matched' } },
      'ORDER_ID_2'
    );
    expect(reading).toEqual({ kind: 'already-terminal', reason: 'order already matched' });
  });

  it('reads the camelCase notCanceled spelling the TypeScript SDK returns', () => {
    // The REST reference documents `not_canceled`; the @polymarket/client type is
    // `notCanceled`. A parser that reads only one silently never matches.
    expect(interpretPolymarketCancellation(
      { canceled: [], notCanceled: { 'stale-1': 'order already matched' } },
      'stale-1'
    )).toEqual({ kind: 'already-terminal', reason: 'order already matched' });
  });

  it('does not treat another order id being canceled as this order being canceled', () => {
    const reading = interpretPolymarketCancellation(
      { canceled: ['someone-elses-order'], not_canceled: {} },
      'my-order'
    );
    expect(reading.kind).toBe('unreported');
  });

  it('reads an unrecognised refusal as refused, never as confirmed', () => {
    const reading = interpretPolymarketCancellation(
      { canceled: [], not_canceled: { 'rung-1': 'internal error 500' } },
      'rung-1'
    );
    expect(reading).toEqual({ kind: 'refused', reason: 'internal error 500' });
  });

  it('recognises a delay-window refusal as its own state', () => {
    const reading = interpretPolymarketCancellation(
      { canceled: [], not_canceled: { 'rung-1': 'order is in a pending delay window' } },
      'rung-1'
    );
    expect(reading.kind).toBe('delay-window');
  });

  it('never throws on a malformed body — it reports learning nothing', () => {
    for (const body of [null, undefined, 'nope', 42, {}, { canceled: 'not-an-array' }]) {
      expect(interpretPolymarketCancellation(body, 'rung-1').kind).toBe('unreported');
    }
  });

  it('coerces non-string order ids, because the venue types them as OrderId', () => {
    expect(interpretPolymarketCancellation(
      { canceled: [12345] },
      '12345'
    )).toEqual({ kind: 'confirmed' });
  });

  it('wraps a thrown call as error, which says nothing about the order', () => {
    expect(polymarketCancellationError(new Error('ECONNRESET')))
      .toEqual({ kind: 'error', reason: 'ECONNRESET' });
  });
});

describe('classifyPolymarketOrderLiveness', () => {
  it('classifies the documented statuses', () => {
    // /concepts/order-lifecycle → Order Statuses: live, matched, delayed,
    // unmatched. fetchOrder returns them upper-cased.
    expect(classifyPolymarketOrderLiveness('LIVE').kind).toBe('resting');
    expect(classifyPolymarketOrderLiveness('MATCHED').kind).toBe('terminal');
    expect(classifyPolymarketOrderLiveness('DELAYED').kind).toBe('delayed');
    expect(classifyPolymarketOrderLiveness('UNMATCHED').kind).toBe('resting');
  });

  it('treats UNMATCHED as resting, not finished', () => {
    // The docs define it as "placed on the book after the delay expired without a
    // match" — i.e. it IS on the book. Reading it as terminal would be the same
    // class of mistake this item fixes.
    expect(classifyPolymarketOrderLiveness('unmatched')).toEqual({
      kind: 'resting',
      status: 'UNMATCHED'
    });
  });

  it('treats cancelled and expired as terminal', () => {
    for (const status of ['CANCELLED', 'CANCELED', 'EXPIRED', 'FAILED', 'REJECTED']) {
      expect(classifyPolymarketOrderLiveness(status).kind).toBe('terminal');
    }
  });

  it('reports an undocumented status as unknown rather than guessing', () => {
    expect(classifyPolymarketOrderLiveness('SOMETHING_NEW')).toEqual({
      kind: 'unknown',
      status: 'SOMETHING_NEW'
    });
    expect(classifyPolymarketOrderLiveness(undefined).kind).toBe('unknown');
  });

  it('strips the ORDER_STATUS_ prefix the venue sometimes carries', () => {
    expect(classifyPolymarketOrderLiveness('ORDER_STATUS_LIVE').kind).toBe('resting');
  });
});

describe('planPolymarketRungRetirement', () => {
  const base = { orderId: 'rung-1', attempt: 1, maxAttempts: 3 } as const;

  it('retires an order the venue reports terminal', () => {
    const plan = planPolymarketRungRetirement({
      ...base,
      cancellation: { kind: 'already-terminal', reason: 'order already matched' },
      liveness: { kind: 'terminal', status: 'MATCHED' }
    });
    expect(plan.kind).toBe('retired');
  });

  it('does NOT retire on a confirmed cancel while the order still reads LIVE', () => {
    // The fetched order wins over the cancellation response. This is requirement
    // (1) of the item: the order must be terminal, not merely "we asked nicely".
    const plan = planPolymarketRungRetirement({
      ...base,
      cancellation: { kind: 'confirmed' },
      liveness: { kind: 'resting', status: 'LIVE' }
    });
    expect(plan.kind).toBe('retry-cancel');
  });

  it('retries the cancel while a resting order still has attempts left', () => {
    const plan = planPolymarketRungRetirement({
      ...base,
      cancellation: { kind: 'refused', reason: 'internal error' },
      liveness: { kind: 'resting', status: 'LIVE' }
    });
    expect(plan.kind).toBe('retry-cancel');
  });

  it('BLOCKS the next rung when a resting order survives every attempt', () => {
    // The whole point. Placing the next rung on top of a live one gives two live
    // sell orders whose combined size can exceed the position.
    const plan = planPolymarketRungRetirement({
      ...base,
      attempt: 3,
      cancellation: { kind: 'refused', reason: 'internal error' },
      liveness: { kind: 'resting', status: 'LIVE' }
    });
    expect(plan.kind).toBe('blocked');
    expect(plan.reason).toContain('two live sell orders');
  });

  it('treats a delay-window refusal as WAIT, not as failure', () => {
    // /concepts/order-lifecycle documents cancels as blocked in the delay window,
    // so the refusal is the venue behaving as specified.
    const plan = planPolymarketRungRetirement({
      ...base,
      cancellation: { kind: 'delay-window', reason: 'pending delay window' },
      liveness: { kind: 'resting', status: 'LIVE' }
    });
    expect(plan.kind).toBe('wait');
  });

  it('treats a DELAYED order status as wait even when the cancel merely errored', () => {
    const plan = planPolymarketRungRetirement({
      ...base,
      cancellation: { kind: 'error', reason: 'ECONNRESET' },
      liveness: { kind: 'delayed', status: 'DELAYED' }
    });
    expect(plan.kind).toBe('wait');
  });

  it('blocks rather than waits forever when the delay window outlasts the attempts', () => {
    const plan = planPolymarketRungRetirement({
      ...base,
      attempt: 3,
      cancellation: { kind: 'delay-window', reason: 'pending delay window' },
      liveness: { kind: 'delayed', status: 'DELAYED' }
    });
    expect(plan.kind).toBe('blocked');
  });

  it('never retires an order whose status it cannot recognise', () => {
    const attemptsLeft = planPolymarketRungRetirement({
      ...base,
      cancellation: { kind: 'confirmed' },
      liveness: { kind: 'unknown', status: 'WAT' }
    });
    expect(attemptsLeft.kind).toBe('retry-cancel');

    const exhausted = planPolymarketRungRetirement({
      ...base,
      attempt: 3,
      cancellation: { kind: 'confirmed' },
      liveness: { kind: 'unknown', status: 'WAT' }
    });
    expect(exhausted.kind).toBe('blocked');
  });

  it('never returns retired for any non-terminal liveness, across every cancellation reading', () => {
    // Exhaustive rather than illustrative: 'retired' is the branch that unlocks
    // the next rung, so the invariant worth pinning is that ONLY a terminal
    // fetched order can produce it.
    const readings = [
      { kind: 'confirmed' },
      { kind: 'already-terminal', reason: 'r' },
      { kind: 'delay-window', reason: 'r' },
      { kind: 'refused', reason: 'r' },
      { kind: 'unreported', reason: 'r' },
      { kind: 'error', reason: 'r' }
    ] as const;
    const livenesses = [
      { kind: 'resting', status: 'LIVE' },
      { kind: 'delayed', status: 'DELAYED' },
      { kind: 'unknown', status: 'WAT' }
    ] as const;

    for (const cancellation of readings) {
      for (const liveness of livenesses) {
        for (const attempt of [1, 3]) {
          const plan = planPolymarketRungRetirement({
            orderId: 'rung-1',
            attempt,
            maxAttempts: 3,
            cancellation,
            liveness
          });
          expect(plan.kind, `${cancellation.kind}/${liveness.kind}/${attempt}`)
            .not.toBe('retired');
        }
      }
    }
  });
});
