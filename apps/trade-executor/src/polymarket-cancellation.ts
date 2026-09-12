/**
 * One reading of Polymarket's cancellation contract, shared by every call site
 * (checklist `S4-M36`).
 *
 * **Why this module exists rather than two inline reads.** The repo had two
 * disagreeing interpretations of the same API. `reconcilePendingPolymarketTrade`
 * checked `cancellation.canceled.some(...)`; `createPolymarketExitRungSubmitter`
 * wrapped the call in a try/catch and assumed a failure would throw. Only one of
 * those can be right, and the wrong one was silently a no-op on exactly the
 * failure path it was written to cover. Two readings of one contract is the
 * defect, so there is now one reading.
 *
 * **What the venue actually returns** (verified against the live docs, not
 * memory):
 *
 *   * `/trading/manage-orders` → *Cancellation Results*: "A cancellation can
 *     succeed for only some of the requested orders. Reconcile the result before
 *     retrying." The TypeScript SDK's type is
 *     `{ canceled: OrderId[]; notCanceled: Record<OrderId, string> }`; the Python
 *     SDK and the raw REST body spell the second field `not_canceled`. Both
 *     spellings are accepted below because the SDK's camelCase is what
 *     `@polymarket/client` hands us while the API reference documents snake_case,
 *     and a reader of only one page would write a parser that silently never
 *     matches.
 *   * `/api-reference/trade/cancel-single-order`: `DELETE /order` answers **200**
 *     with that same body. A stale order therefore lands in `not_canceled` with
 *     **no exception** — the documented example is
 *     `{"canceled": ["ORDER_ID_1"], "not_canceled": {"ORDER_ID_2": "order already matched"}}`.
 *   * `/concepts/order-lifecycle` → *Cancellation*: "You can cancel orders at any
 *     time before they're matched via the CLOB API, **except while a marketable
 *     order is in a pending delay window**." And *Match or Rest*: "During either
 *     delay, the order is pending and cannot be canceled." So a cancel refused
 *     inside that window is the venue behaving as documented — a reason to wait,
 *     not a failure.
 *   * `/concepts/order-lifecycle` → *Order Statuses*: `live` (resting on the
 *     book), `matched`, `delayed` (accepted into the asynchronous delay window on
 *     a `secondsDelay` market), `unmatched` (placed on the book after the delay
 *     expired without a match). `/trading/manage-orders` shows `fetchOrder`
 *     returning `status: "LIVE"`, i.e. upper-case over the wire.
 *   * `/concepts/order-lifecycle` → *Cancellation*: "Partial fills cannot be
 *     cancelled: only the unfilled portion of an order can be cancelled." This is
 *     why a non-zero `sizeMatched` is **not** evidence the order is finished: a
 *     partially filled order rests on the book for its remainder.
 *
 * **What the docs do not say, and how that is handled.** The docs give one
 * example `not_canceled` message ("order already matched") and never enumerate
 * the set, so the exact prose for a delay-window refusal is unknown. The
 * authoritative wait signal is therefore the *order status* (`delayed`), which is
 * documented, and reason-text matching is only ever an additional hint. Anything
 * unrecognised is reported as `refused`, which fails closed.
 *
 * Pure: no clock, no client, no environment. Every function here is a total
 * function of the venue's response shape.
 */

/** How a cancellation response reads for one specific order id. */
export type PolymarketCancellationReading =
  /** The venue listed the order in `canceled`. It is gone. */
  | { readonly kind: 'confirmed' }
  /**
   * The venue refused because the order was already finished — matched, filled,
   * expired or unknown to it. Not a cancellation, but not something resting
   * either.
   */
  | { readonly kind: 'already-terminal'; readonly reason: string }
  /**
   * The venue refused because the order is inside a matching-delay window. The
   * docs say cancels are blocked there, so this is expected and means wait.
   */
  | { readonly kind: 'delay-window'; readonly reason: string }
  /** Refused for a reason we do not recognise. Not proof of anything. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The order appeared in neither list, so the response says nothing about it. */
  | { readonly kind: 'unreported'; readonly reason: string }
  /** The call itself failed (transport, auth, 5xx). Says nothing about the order. */
  | { readonly kind: 'error'; readonly reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function canceledIds(response: Record<string, unknown>): string[] {
  const raw = response.canceled;
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id));
}

/**
 * The refusal map, under either spelling.
 *
 * `notCanceled` is the `@polymarket/client` TypeScript type; `not_canceled` is
 * what the REST reference and the Python SDK document. Reading only one is how a
 * parser ends up never matching a refusal.
 */
function notCanceledEntries(response: Record<string, unknown>): Record<string, string> {
  const candidate = asRecord(response.notCanceled) ?? asRecord(response.not_canceled);
  if (!candidate) return {};
  const entries: Record<string, string> = {};
  for (const [orderId, reason] of Object.entries(candidate)) {
    entries[String(orderId)] = typeof reason === 'string' ? reason : String(reason);
  }
  return entries;
}

/**
 * Reasons that mean the order is already finished.
 *
 * Only "order already matched" is documented, as the example refusal on
 * `/trading/manage-orders`. The rest are conservative synonyms of the same fact.
 * Being wrong in this direction is the dangerous one, so the list is short and
 * anything outside it reads as `refused`.
 */
const TERMINAL_REFUSAL_PATTERNS: readonly RegExp[] = [
  /already\s+matched/i,
  /already\s+filled/i,
  /already\s+cancell?ed/i,
  /already\s+expired/i,
  /not\s+found/i,
  /does\s+not\s+exist/i,
  /unknown\s+order/i
];

/**
 * Reasons that hint at the documented delay window.
 *
 * A hint only. The docs never state the refusal text for this case, so the
 * decision to wait is driven by the order's own `delayed` status in
 * `planPolymarketRungRetirement`; this exists so a recognisable message is not
 * thrown away.
 */
const DELAY_REFUSAL_PATTERNS: readonly RegExp[] = [
  /delay/i,
  /pending\s+match/i,
  /not\s+cancellable\s+yet/i
];

/**
 * Read a cancellation response for one order id.
 *
 * Never throws: a malformed response is `unreported`, which is treated as "we
 * learned nothing" rather than as success. The alternative — assuming a 200 with
 * an unreadable body means the order is gone — is the assumption this whole
 * module exists to remove.
 */
export function interpretPolymarketCancellation(
  response: unknown,
  orderId: string
): PolymarketCancellationReading {
  const body = asRecord(response);
  if (!body) {
    return {
      kind: 'unreported',
      reason: `Polymarket cancellation returned no readable body for order ${orderId}`
    };
  }

  if (canceledIds(body).includes(orderId)) {
    return { kind: 'confirmed' };
  }

  const refusal = notCanceledEntries(body)[orderId];
  if (refusal !== undefined) {
    if (TERMINAL_REFUSAL_PATTERNS.some((pattern) => pattern.test(refusal))) {
      return { kind: 'already-terminal', reason: refusal };
    }
    if (DELAY_REFUSAL_PATTERNS.some((pattern) => pattern.test(refusal))) {
      return { kind: 'delay-window', reason: refusal };
    }
    return { kind: 'refused', reason: refusal };
  }

  return {
    kind: 'unreported',
    reason:
      `Polymarket cancellation listed order ${orderId} in neither canceled nor not_canceled`
  };
}

/** Wrap a thrown cancellation call so the planner sees one input shape. */
export function polymarketCancellationError(error: unknown): PolymarketCancellationReading {
  return {
    kind: 'error',
    reason: error instanceof Error ? error.message : String(error)
  };
}

/**
 * Whether an order the venue just described is still capable of filling.
 *
 * This is the reading the rung submitter was missing. It already called
 * `fetchOrder` and read `sizeMatched` from it, then threw the status away — so it
 * knew how much had filled and never asked whether anything was still live.
 */
export type PolymarketOrderLiveness =
  /** Provably dead: it cannot fill again. */
  | { readonly kind: 'terminal'; readonly status: string }
  /** Resting on the book, remainder still fillable. */
  | { readonly kind: 'resting'; readonly status: string }
  /** Inside the venue's matching-delay window; cancels are blocked there. */
  | { readonly kind: 'delayed'; readonly status: string }
  /** A status outside the documented set. Not evidence of anything. */
  | { readonly kind: 'unknown'; readonly status: string };

function normalizeStatus(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/^ORDER_STATUS_/, '');
}

/**
 * Classify an order status into "can this still fill?".
 *
 * The documented statuses are `live`, `matched`, `delayed` and `unmatched`.
 * `unmatched` is explicitly "placed on the book after the delay expired without a
 * match", so it is *resting*, not finished — reading it as terminal would be the
 * same class of mistake this item fixes. The extra spellings mirror
 * `classifyOrderState` in `polymarket.ts`, which has to tolerate the venue's
 * upper-case and legacy variants.
 */
export function classifyPolymarketOrderLiveness(status: unknown): PolymarketOrderLiveness {
  const normalized = normalizeStatus(status);
  switch (normalized) {
    case 'LIVE':
    case 'OPEN':
    case 'UNMATCHED':
      return { kind: 'resting', status: normalized };
    case 'DELAYED':
    case 'PENDING':
      return { kind: 'delayed', status: normalized };
    case 'MATCHED':
    case 'FILLED':
    case 'COMPLETED':
    case 'CANCELLED':
    case 'CANCELED':
    case 'EXPIRED':
    case 'FAILED':
    case 'REJECTED':
    case 'INVALID':
      return { kind: 'terminal', status: normalized };
    default:
      return { kind: 'unknown', status: normalized };
  }
}

/**
 * What to do with an escalation rung once its resting window has elapsed.
 *
 * The whole point is the `blocked` branch. An exit ladder places the next rung
 * for whatever the previous rung did not fill, so if the previous rung is still
 * resting we would have **two live sell orders whose combined size exceeds the
 * position** — selling a user's shares twice. Refusing to continue costs a slower
 * exit and an alert; continuing costs an oversell. That asymmetry is why this
 * fails closed, and it is deliberately the opposite of `S4-M31`, where failing
 * closed would have halted all copying to avoid one odd trade.
 */
export type PolymarketRungRetirement =
  /** Provably dead. Safe to read its fill and move to the next rung. */
  | { readonly kind: 'retired'; readonly reason: string }
  /** Expected transient state (delay window). Wait, then re-check. */
  | { readonly kind: 'wait'; readonly reason: string }
  /** Still resting or unproven, and attempts remain. Cancel again. */
  | { readonly kind: 'retry-cancel'; readonly reason: string }
  /** Not provably dead and out of attempts. Do not place another rung. */
  | { readonly kind: 'blocked'; readonly reason: string };

export interface PolymarketRungRetirementInput {
  readonly orderId: string;
  readonly cancellation: PolymarketCancellationReading;
  readonly liveness: PolymarketOrderLiveness;
  /** 1-based count of cancel attempts already made. */
  readonly attempt: number;
  readonly maxAttempts: number;
}

/**
 * Decide whether a rung is retired, worth another cancel, or must stop the
 * ladder.
 *
 * The fetched order state wins over the cancellation response wherever the two
 * disagree, because it describes the order rather than describing one request
 * about the order. A cancel the venue confirmed while the order still reads
 * `LIVE` is therefore *not* accepted as retired — the ordering is what makes
 * requirement (1) of the item ("require the order to be terminal, not merely
 * partially matched") actually bind.
 */
export function planPolymarketRungRetirement(
  input: PolymarketRungRetirementInput
): PolymarketRungRetirement {
  const attemptsRemain = input.attempt < input.maxAttempts;
  const suffix =
    `after ${input.attempt} of ${input.maxAttempts} cancel attempts`;

  if (input.liveness.kind === 'terminal') {
    return {
      kind: 'retired',
      reason:
        `order ${input.orderId} is terminal (${input.liveness.status}), so nothing is resting`
    };
  }

  if (input.liveness.kind === 'delayed' || input.cancellation.kind === 'delay-window') {
    const detail = input.cancellation.kind === 'delay-window'
      ? input.cancellation.reason
      : `status ${input.liveness.status}`;
    return attemptsRemain
      ? {
        kind: 'wait',
        reason:
          `order ${input.orderId} is inside the venue's matching-delay window (${detail}); `
          + 'the docs block cancels there, so this is expected'
      }
      : {
        kind: 'blocked',
        reason:
          `order ${input.orderId} is still inside the venue's matching-delay window (${detail}) `
          + `${suffix}; refusing to place the next rung against an order that can still match`
      };
  }

  if (input.liveness.kind === 'resting') {
    return attemptsRemain
      ? {
        kind: 'retry-cancel',
        reason:
          `order ${input.orderId} is still resting on the book (${input.liveness.status}) `
          + `despite cancellation reading '${input.cancellation.kind}'`
      }
      : {
        kind: 'blocked',
        reason:
          `order ${input.orderId} is still resting on the book (${input.liveness.status}) `
          + `${suffix}; placing the next rung would leave two live sell orders whose `
          + 'combined size can exceed the position'
      };
  }

  // Unknown status. An unreadable order is not a dead order, and the cost of
  // guessing wrong here is an oversell, so it is never treated as retired.
  return attemptsRemain
    ? {
      kind: 'retry-cancel',
      reason:
        `order ${input.orderId} returned an unrecognised status '${input.liveness.status}', `
        + 'which is not proof it stopped resting'
    }
    : {
      kind: 'blocked',
      reason:
        `order ${input.orderId} returned an unrecognised status '${input.liveness.status}' `
        + `${suffix}; it cannot be shown to be dead, so the ladder stops here`
    };
}
