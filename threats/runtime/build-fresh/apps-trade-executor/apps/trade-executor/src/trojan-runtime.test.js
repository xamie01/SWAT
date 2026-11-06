import { describe, expect, it, vi } from 'vitest';
import { createTrojanAdapter } from './trojan.js';
import { createRedisTrojanPendingStore, createTrojanRuntime, reconcileTrojanPending } from './trojan-runtime.js';
function redisHash() {
    const values = new Map();
    return {
        async hget(key, field) {
            return values.get(key)?.get(field) ?? null;
        },
        async hgetall(key) {
            return Object.fromEntries(values.get(key) ?? []);
        },
        async hset(key, field, value) {
            const hash = values.get(key) ?? new Map();
            hash.set(field, value);
            values.set(key, hash);
            return 1;
        }
    };
}
const before = {
    walletAddress: '11111111111111111111111111111111',
    tokenMint: 'Tokenyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
    nativeLamports: '2000000000',
    tokenBaseUnits: '10000000',
    observedAt: new Date('2026-07-26T10:00:00.000Z'),
    slot: 100
};
describe('Trojan restart-safe runtime', () => {
    it('persists stable SELL intent and does not submit it again after restart', async () => {
        const redis = redisHash();
        const transport = vi.fn().mockResolvedValue({ transactionIdentity: 'solana-signature-1' });
        const runtime = createTrojanRuntime({
            adapter: createTrojanAdapter(transport, { timeoutMs: 100, maxAttempts: 1 }),
            pendingStore: createRedisTrojanPendingStore(redis),
            readBalance: vi.fn().mockResolvedValue(before),
            pendingTtlMs: 600_000
        });
        const first = await runtime.submit({
            signalId: 'signal-sol-1',
            tokenMint: before.tokenMint,
            direction: 'sell',
            sellProportionBps: 2500,
            slippageBps: 1500
        });
        expect(first).toMatchObject({
            status: 'pending_confirmation',
            transactionIdentity: 'solana-signature-1',
            order: { side: 'sell', tokenAmountBaseUnits: '2500000' }
        });
        const restarted = createTrojanRuntime({
            adapter: createTrojanAdapter(transport, { timeoutMs: 100, maxAttempts: 1 }),
            pendingStore: createRedisTrojanPendingStore(redis),
            readBalance: vi.fn().mockResolvedValue(before),
            pendingTtlMs: 600_000
        });
        await expect(restarted.submit({
            signalId: 'signal-sol-1',
            tokenMint: before.tokenMint,
            direction: 'sell',
            sellProportionBps: 2500,
            slippageBps: 1500
        })).resolves.toMatchObject({ status: 'pending_confirmation' });
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('reconciles confirmed identity and actual post-submit balances without resubmission', async () => {
        const redis = redisHash();
        const store = createRedisTrojanPendingStore(redis);
        const transport = vi.fn().mockResolvedValue({ transactionIdentity: 'solana-signature-2' });
        const runtime = createTrojanRuntime({
            adapter: createTrojanAdapter(transport, { timeoutMs: 100, maxAttempts: 1 }),
            pendingStore: store,
            readBalance: vi.fn().mockResolvedValue(before),
            pendingTtlMs: 600_000
        });
        await runtime.submit({
            signalId: 'signal-sol-2',
            tokenMint: before.tokenMint,
            direction: 'buy',
            amountLamports: '100000000',
            slippageBps: 1500
        });
        const results = await reconcileTrojanPending({
            pendingStore: createRedisTrojanPendingStore(redis),
            readConfirmation: vi.fn().mockResolvedValue({
                transactionIdentity: 'solana-signature-2',
                status: 'confirmed',
                observedAt: new Date('2026-07-26T10:00:05.000Z'),
                slot: 110
            }),
            readBalance: vi.fn().mockResolvedValue({
                ...before,
                nativeLamports: '1895000000',
                tokenBaseUnits: '15000000',
                observedAt: new Date('2026-07-26T10:00:05.000Z'),
                slot: 110
            }),
            now: new Date('2026-07-26T10:01:00.000Z')
        });
        expect(results).toMatchObject([{ status: 'filled', transactionIdentity: 'solana-signature-2' }]);
        expect(transport).toHaveBeenCalledTimes(1);
        await expect(store.findResolution('signal-sol-2')).resolves.toMatchObject({ status: 'filled' });
    });
});
//# sourceMappingURL=trojan-runtime.test.js.map