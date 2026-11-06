import { describe, expect, it, vi } from 'vitest';
import { createTrojanAdapter, createTrojanWebhookTransport, prepareTrojanOrder, reconcileTrojanSubmission, TrojanRequestRejectedError } from './trojan.js';
const WALLET = 'TrojanWallet111111111111111111111111111111111';
const TOKEN = 'Tokenyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const OBSERVED_AT = new Date('2026-07-26T10:00:00.000Z');
const CONFIRMED_AT = new Date('2026-07-26T10:00:05.000Z');
function balance(overrides = {}) {
    return {
        walletAddress: WALLET,
        tokenMint: TOKEN,
        nativeLamports: '2000000000',
        tokenBaseUnits: '0',
        observedAt: OBSERVED_AT,
        slot: 351_000_000,
        ...overrides
    };
}
function buyOrder(overrides = {}) {
    return {
        side: 'buy',
        signalId: 'signal-entry-1',
        tokenMint: TOKEN,
        amountLamports: '100000000',
        slippageBps: 1_500,
        beforeBalance: balance(),
        ...overrides
    };
}
function sellOrder(overrides = {}) {
    return {
        side: 'sell',
        signalId: 'signal-exit-1',
        tokenMint: TOKEN,
        sellProportionBps: 2_500,
        slippageBps: 1_500,
        beforeBalance: balance({ tokenBaseUnits: '10000000' }),
        ...overrides
    };
}
function acceptedTransport(transactionIdentity) {
    return vi.fn().mockResolvedValue({ transactionIdentity });
}
function adapter(transport, overrides = {}) {
    return createTrojanAdapter(transport, {
        timeoutMs: overrides.timeoutMs ?? 100,
        maxAttempts: overrides.maxAttempts ?? 2,
        retryDelayMs: 0,
        now: () => new Date('2026-07-26T10:00:01.000Z')
    });
}
describe('Trojan adapter contract', () => {
    it('keeps the signal ID as the stable client/idempotency ID across a bounded retry', async () => {
        const transport = vi.fn()
            .mockRejectedValueOnce(new Error('transient transport failure'))
            .mockResolvedValueOnce({ transactionIdentity: 'returned-solana-signature' });
        const result = await adapter(transport).submit(buyOrder());
        expect(result).toMatchObject({
            status: 'pending_confirmation',
            clientOrderId: 'signal-entry-1',
            transactionIdentity: 'returned-solana-signature',
            attempts: 2
        });
        expect(transport).toHaveBeenCalledTimes(2);
        expect(transport.mock.calls.map(([order, context]) => ({
            clientOrderId: order.clientOrderId,
            idempotencyKey: context.idempotencyKey
        }))).toEqual([
            { clientOrderId: 'signal-entry-1', idempotencyKey: 'signal-entry-1' },
            { clientOrderId: 'signal-entry-1', idempotencyKey: 'signal-entry-1' }
        ]);
    });
    it('returns a truthful timeout-after-submit state without inventing a signature', async () => {
        const transportMock = vi.fn((...[_order, context]) => (new Promise((_resolve, reject) => {
            context.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })));
        const transport = transportMock;
        const result = await adapter(transport, { timeoutMs: 2, maxAttempts: 2 }).submit(buyOrder());
        expect(result).toMatchObject({
            status: 'submission_unknown',
            clientOrderId: 'signal-entry-1',
            reason: 'timeout-after-submit',
            attempts: 2
        });
        expect(result).not.toHaveProperty('transactionIdentity');
        expect(transportMock).toHaveBeenCalledTimes(2);
    });
    it('does not retry an explicit permanent rejection', async () => {
        const transport = vi.fn().mockRejectedValue(new TrojanRequestRejectedError(422));
        const result = await adapter(transport).submit(buyOrder());
        expect(result).toMatchObject({ status: 'rejected', httpStatus: 422, attempts: 1 });
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('refuses to call an acknowledgement a fill when no transaction identity is returned', async () => {
        const transport = vi.fn().mockResolvedValue({ transactionIdentity: '' });
        const result = await adapter(transport, { maxAttempts: 1 }).submit(buyOrder());
        expect(result).toMatchObject({
            status: 'submission_unknown',
            reason: 'missing-transaction-identity'
        });
    });
    it('replays duplicate submissions with the same client ID and returned identity', async () => {
        const transport = acceptedTransport('deduplicated-solana-signature');
        const trojan = adapter(transport);
        const first = await trojan.submit(buyOrder());
        const duplicate = await trojan.submit(buyOrder());
        expect(duplicate).toMatchObject({
            status: 'pending_confirmation',
            clientOrderId: 'signal-entry-1',
            transactionIdentity: 'deduplicated-solana-signature'
        });
        expect(duplicate).toMatchObject({
            clientOrderId: first.clientOrderId
        });
        expect(transport).toHaveBeenCalledTimes(2);
    });
    it('calculates partial and full SELL quantities from the actual pre-submit balance', () => {
        expect(prepareTrojanOrder(sellOrder())).toMatchObject({
            side: 'sell',
            sellProportionBps: 2_500,
            tokenAmountBaseUnits: '2500000'
        });
        expect(prepareTrojanOrder(sellOrder({ sellProportionBps: 10_000 }))).toMatchObject({
            side: 'sell',
            sellProportionBps: 10_000,
            tokenAmountBaseUnits: '10000000'
        });
        expect(prepareTrojanOrder(sellOrder({
            sellProportionBps: 5_000,
            maximumTokenAmountBaseUnits: '1250000'
        }))).toMatchObject({
            side: 'sell',
            sellProportionBps: 5_000,
            tokenAmountBaseUnits: '1250000'
        });
    });
    it('passes stable identity headers through the codec-controlled webhook transport', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ signature: 'sig-from-api' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
        }));
        const transport = createTrojanWebhookTransport({
            url: 'https://trojan.invalid/reviewed-webhook',
            fetchImpl,
            codec: {
                encode: (order) => ({
                    clientOrderId: order.clientOrderId,
                    side: order.side,
                    tokenMint: order.tokenMint
                }),
                decode: (body) => ({
                    transactionIdentity: body.signature
                })
            }
        });
        const result = await adapter(transport, { maxAttempts: 1 }).submit(buyOrder());
        expect(result).toMatchObject({
            status: 'pending_confirmation',
            transactionIdentity: 'sig-from-api'
        });
        const init = fetchImpl.mock.calls[0][1];
        expect(init.headers).toMatchObject({
            'Idempotency-Key': 'signal-entry-1'
        });
        expect(JSON.parse(init.body)).toEqual({
            clientOrderId: 'signal-entry-1',
            side: 'buy',
            tokenMint: TOKEN
        });
    });
});
describe('Trojan confirmation and balance reconciliation fixtures', () => {
    it('reconciles a confirmed entry from returned identity and actual balances', async () => {
        const submission = await adapter(acceptedTransport('entry-signature')).submit(buyOrder());
        if (submission.status !== 'pending_confirmation')
            throw new Error('fixture submission failed');
        expect(reconcileTrojanSubmission({
            submission,
            confirmation: {
                transactionIdentity: 'entry-signature',
                status: 'confirmed',
                observedAt: CONFIRMED_AT,
                slot: 351_000_010
            },
            afterBalance: balance({
                nativeLamports: '1895000000',
                tokenBaseUnits: '5000000',
                observedAt: CONFIRMED_AT,
                slot: 351_000_010
            })
        })).toEqual({
            status: 'filled',
            transactionIdentity: 'entry-signature',
            fillKind: 'entry',
            nativeLamportsDelta: '-105000000',
            tokenBaseUnitsDelta: '5000000',
            confirmedAt: CONFIRMED_AT,
            slot: 351_000_010
        });
    });
    it.each([
        {
            name: 'partial exit',
            proportion: 2_500,
            afterTokens: '7500000',
            fillKind: 'partial-exit'
        },
        {
            name: 'full exit',
            proportion: 10_000,
            afterTokens: '0',
            fillKind: 'full-exit'
        }
    ])('reconciles a confirmed $name from actual balances', async ({ proportion, afterTokens, fillKind }) => {
        const submission = await adapter(acceptedTransport(`${fillKind}-signature`)).submit(sellOrder({ sellProportionBps: proportion }));
        if (submission.status !== 'pending_confirmation')
            throw new Error('fixture submission failed');
        expect(reconcileTrojanSubmission({
            submission,
            confirmation: {
                transactionIdentity: `${fillKind}-signature`,
                status: 'confirmed',
                observedAt: CONFIRMED_AT
            },
            afterBalance: balance({
                nativeLamports: '2200000000',
                tokenBaseUnits: afterTokens,
                observedAt: CONFIRMED_AT
            })
        })).toMatchObject({
            status: 'filled',
            fillKind,
            transactionIdentity: `${fillKind}-signature`
        });
    });
    it('records an on-chain failure without fabricating balance deltas', async () => {
        const submission = await adapter(acceptedTransport('failed-signature')).submit(buyOrder());
        if (submission.status !== 'pending_confirmation')
            throw new Error('fixture submission failed');
        expect(reconcileTrojanSubmission({
            submission,
            confirmation: {
                transactionIdentity: 'failed-signature',
                status: 'failed',
                observedAt: CONFIRMED_AT
            }
        })).toEqual({ status: 'failed', transactionIdentity: 'failed-signature' });
    });
    it('keeps a confirmed transaction pending until post-submit balances arrive', async () => {
        const submission = await adapter(acceptedTransport('pending-balance-signature')).submit(buyOrder());
        if (submission.status !== 'pending_confirmation')
            throw new Error('fixture submission failed');
        expect(reconcileTrojanSubmission({
            submission,
            confirmation: {
                transactionIdentity: 'pending-balance-signature',
                status: 'confirmed',
                observedAt: CONFIRMED_AT
            }
        })).toEqual({
            status: 'pending_reconciliation',
            transactionIdentity: 'pending-balance-signature'
        });
    });
    it('keeps a confirmed transaction pending when the balance snapshot predates its slot', async () => {
        const submission = await adapter(acceptedTransport('stale-balance-signature')).submit(buyOrder());
        if (submission.status !== 'pending_confirmation')
            throw new Error('fixture submission failed');
        expect(reconcileTrojanSubmission({
            submission,
            confirmation: {
                transactionIdentity: 'stale-balance-signature',
                status: 'confirmed',
                observedAt: CONFIRMED_AT,
                slot: 351_000_010
            },
            afterBalance: balance({
                nativeLamports: '1900000000',
                tokenBaseUnits: '1000000',
                observedAt: CONFIRMED_AT,
                slot: 351_000_009
            })
        })).toEqual({
            status: 'pending_reconciliation',
            transactionIdentity: 'stale-balance-signature'
        });
    });
});
//# sourceMappingURL=trojan.test.js.map