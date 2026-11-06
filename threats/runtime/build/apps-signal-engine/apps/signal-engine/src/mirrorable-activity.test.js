import { describe, expect, it } from 'vitest';
import { MIRRORABLE_SOURCE_SIDES, evaluateMirrorableActivity, resolveMinimumMirrorableNotionalUsd } from './mirrorable-activity.js';
/**
 * These tests exist because the copy path cannot be tested through the service.
 * `index.ts` starts `setInterval` at import (`S4-M26`), so the only way to assert
 * that a master's internal transfer is not copied is to assert it here.
 */
/** `minimumNotionalUsd` omitted means "floor disabled", the shipped default. */
function decide(side, amountUsd, minimumNotionalUsd = 0) {
    return evaluateMirrorableActivity({ side, amountUsd, minimumNotionalUsd });
}
describe('mirrorable side classification', () => {
    it.each(['buy', 'sell'])('mirrors a %s', (side) => {
        expect(decide(side, '100')).toEqual({ kind: 'mirror', side, notionalUsd: 100 });
    });
    it.each(['transfer_in', 'transfer_out'])('refuses to mirror a %s, however large', (side) => {
        // The scenario `S4-M5` names: a master moving funds between their own
        // wallets. Notional is irrelevant — a $1M self-transfer is still not a view
        // about a token, and copying it spends a user's money on the master's
        // bookkeeping. Asserted with a huge amount so that no notional gate can be
        // mistaken for the thing that stopped it.
        const decision = decide(side, '1000000');
        expect(decision.kind).toBe('skip');
        expect(decision).toMatchObject({ code: 'source-side-not-mirrorable' });
    });
    it('is exactly buy and sell, so widening it cannot pass unnoticed', () => {
        // Asserting the whole list rather than individual members: anything new that
        // may be mirrored has to change this line.
        expect([...MIRRORABLE_SOURCE_SIDES]).toEqual(['buy', 'sell']);
    });
    it('fails closed on a side it has never classified', () => {
        // Reachable without a compile error: `source_trades.direction` is a
        // VARCHAR(16) whose CHECK (028:77) admits four values, and
        // `SourceTradeSignalCandidate.side` narrows it to two by assertion only.
        // Anything from a future writer — an LP or staking event type, a venue's own
        // label, a typo in a migration — lands here.
        for (const side of ['lp_add', 'stake', 'BUY', 'buy ', '', 'transfer']) {
            const decision = decide(side, '100');
            expect(decision.kind).toBe('skip');
            expect(decision).toMatchObject({ code: 'source-side-unrecognised' });
        }
    });
    it('reports a transfer differently from an unknown side', () => {
        // Two skips a person acts on differently: one is normal master behaviour to
        // be reported calmly, the other means ingestion is producing something this
        // build does not understand. `S4-M24` needs them distinguishable.
        const transfer = decide('transfer_out', '500');
        const unknown = decide('lp_add', '500');
        expect(transfer).not.toEqual(unknown);
        expect(transfer).toMatchObject({ code: 'source-side-not-mirrorable' });
        expect(unknown).toMatchObject({ code: 'source-side-unrecognised' });
    });
    it('cannot be widened at runtime', () => {
        // `readonly` vanishes at runtime and this gate decides whether money moves,
        // so both protections are checked: the exported list is frozen, and the
        // internal lookup is a copy — a caster who defeats the first cannot reach
        // the second.
        const escaped = MIRRORABLE_SOURCE_SIDES;
        expect(() => escaped.push('transfer_in')).toThrow(TypeError);
        expect(Object.isFrozen(MIRRORABLE_SOURCE_SIDES)).toBe(true);
        expect(decide('transfer_in', '100')).toMatchObject({
            code: 'source-side-not-mirrorable'
        });
    });
});
describe('minimum notional boundary', () => {
    it('mirrors a trade exactly at the floor', () => {
        // Inclusive: the item says "above a minimum notional", and a floor a trade
        // lands precisely on is a trade the operator asked to copy. Stated as a test
        // because the alternative is a silent off-by-one at the boundary operators
        // actually configure.
        expect(decide('buy', '50', 50)).toEqual({ kind: 'mirror', side: 'buy', notionalUsd: 50 });
    });
    it('skips a trade one cent under the floor', () => {
        const decision = decide('buy', '49.99', 50);
        expect(decision).toMatchObject({ code: 'source-notional-below-minimum' });
        expect(decision.kind === 'skip' && decision.reason).toContain('49.99');
    });
    it('skips dust', () => {
        expect(decide('sell', '0.42', 50)).toMatchObject({
            code: 'source-notional-below-minimum'
        });
    });
    it('treats a zero notional as dust once a floor is set', () => {
        // `optionalDecimal` in `copy-trade-lifecycle.ts` accepts 0 (allowZero), so a
        // zero-notional row is storable.
        expect(decide('buy', '0', 1)).toMatchObject({ code: 'source-notional-below-minimum' });
    });
    it('applies no floor at all when the floor is zero', () => {
        // 0 is the shipped default and means the gate is off, matching
        // `COPY_MIN_SOURCE_ACTIVITY_USD=0`. Asserting it explicitly so nobody
        // "fixes" 0 into a hidden non-zero minimum.
        expect(decide('buy', '0.000001', 0)).toMatchObject({ kind: 'mirror' });
        expect(decide('buy', '0', 0)).toMatchObject({ kind: 'mirror' });
    });
    it('accepts the numeric text Postgres actually returns', () => {
        // `amount_usd::text` on a NUMERIC, so trailing zeros and exponents are both
        // possible shapes.
        expect(decide('buy', '50.0000', 50)).toMatchObject({ kind: 'mirror', notionalUsd: 50 });
        expect(decide('buy', '1e2', 50)).toMatchObject({ kind: 'mirror', notionalUsd: 100 });
    });
});
describe('unknown versus dust notional', () => {
    it('mirrors an unpriced trade while no floor is set', () => {
        // Not leniency — the absence of a claim. `buildRobinhoodSourceTradeInput`
        // hardcodes `amountUsd: null`, and `deterministicSolanaPricing` returns null
        // for any route without a USDC/USDT leg. Failing closed on NULL at the
        // default settings would be an undeclared kill switch on all of
        // robinhood-chain and most of Solana, presenting as "copying stopped
        // working" rather than as a policy.
        expect(decide('buy', null, 0)).toEqual({ kind: 'mirror', side: 'buy', notionalUsd: null });
        expect(decide('sell', undefined, 0)).toEqual({
            kind: 'mirror',
            side: 'sell',
            notionalUsd: null
        });
    });
    it('reports null as unknown, never as dust', () => {
        // The distinction the item's "dust excluded" clause must not blur: an amount
        // nobody recorded is not a small amount. Telling an operator their master
        // trades dust when the truth is that we cannot price that chain sends them
        // to fix the wrong thing.
        const decision = decide('buy', null, 50);
        expect(decision).toMatchObject({ code: 'source-notional-unknown' });
        expect(decision).not.toMatchObject({ code: 'source-notional-below-minimum' });
    });
    it('fails closed on an unreadable notional even with no floor', () => {
        // Unlike NULL, a present-but-unparseable amount is not produced by any chain
        // by design, so it is evidence of an upstream fault rather than a missing
        // price — and an amount we cannot read is an amount we cannot bound.
        for (const amount of ['', '   ', 'NaN', 'abc', '-10']) {
            expect(decide('buy', amount, 0)).toMatchObject({ code: 'source-notional-unreadable' });
        }
        expect(decide('buy', Number.NaN, 0)).toMatchObject({ code: 'source-notional-unreadable' });
        expect(decide('buy', Number.POSITIVE_INFINITY, 0)).toMatchObject({
            code: 'source-notional-unreadable'
        });
    });
    it('rejects a side before it ever looks at the notional', () => {
        // Order matters for the reason reported: a transfer with no recorded price
        // must read as a transfer, not as an unpriced trade.
        expect(decide('transfer_in', null, 50)).toMatchObject({
            code: 'source-side-not-mirrorable'
        });
    });
});
describe('threshold configuration', () => {
    it('defaults to no floor when unset or blank', () => {
        expect(resolveMinimumMirrorableNotionalUsd(undefined)).toBe(0);
        expect(resolveMinimumMirrorableNotionalUsd('')).toBe(0);
        expect(resolveMinimumMirrorableNotionalUsd('  ')).toBe(0);
    });
    it('parses a configured floor', () => {
        expect(resolveMinimumMirrorableNotionalUsd('50')).toBe(50);
        expect(resolveMinimumMirrorableNotionalUsd('0')).toBe(0);
        expect(resolveMinimumMirrorableNotionalUsd('12.5')).toBe(12.5);
    });
    it('refuses to start on a misconfigured floor rather than guessing', () => {
        // Both silent absorptions are worse than a startup failure: coercing to 0
        // disables the gate for every trade, and skipping everything stops the
        // product. Same reasoning as `resolveToleranceBps` in
        // `apps/trade-executor/src/polymarket-mirror-bound.ts`.
        for (const raw of ['-1', 'fifty', 'Infinity', '50usd']) {
            expect(() => resolveMinimumMirrorableNotionalUsd(raw)).toThrow(/SOURCE_COPY_MIN_NOTIONAL_USD/);
        }
    });
    it('throws on an invalid floor handed straight to the filter', () => {
        // The call site resolves the floor once at import, so this is defence against
        // a future caller — but a gate that silently passed everything on a NaN
        // threshold is exactly the failure the resolver above exists to prevent, and
        // `Number.NaN < x` is false, so without this guard NaN would mirror
        // everything.
        expect(() => decide('buy', '1', Number.NaN)).toThrow(/minimumNotionalUsd/);
        expect(() => decide('buy', '1', -5)).toThrow(/minimumNotionalUsd/);
    });
});
//# sourceMappingURL=mirrorable-activity.test.js.map