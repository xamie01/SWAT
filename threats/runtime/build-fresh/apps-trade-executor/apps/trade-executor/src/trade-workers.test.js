import { describe, it, expect } from 'vitest';
import { QUEUES, TRADE_QUEUES_BY_CHAIN } from '@swat/shared';
import { TRADE_WORKER_CONCURRENCY, misroutedJobWarning, tradeWorkerSpecs } from './trade-workers.js';
const solanaSpec = {
    queue: 'swat-trades-solana',
    chain: 'solana',
    concurrency: 1,
    drainOnly: false
};
const legacySpec = {
    queue: QUEUES.trades,
    chain: null,
    concurrency: 1,
    drainOnly: true
};
describe('tradeWorkerSpecs (D6 / S3-25)', () => {
    it('runs exactly one worker per chain', () => {
        const specs = tradeWorkerSpecs({ drainLegacyQueue: false });
        expect(specs.map((spec) => spec.chain).sort()).toEqual([
            'base',
            'bsc',
            'ethereum',
            'polygon',
            'robinhood-chain',
            'solana'
        ]);
    });
    it('binds each worker to that chain’s own queue', () => {
        const specs = tradeWorkerSpecs({ drainLegacyQueue: false });
        for (const spec of specs) {
            expect(spec.queue).toBe(TRADE_QUEUES_BY_CHAIN[spec.chain]);
        }
    });
    it('holds every per-chain worker at concurrency 1', () => {
        // Ordering within a chain matters: exposure caps, the circuit breaker and
        // the EVM nonce are chain-keyed, and two concurrent jobs for one chain is
        // the S4-M12 race. If this ever reads 3 again, the isolation D6 bought is
        // gone and the nonce bug is reachable.
        for (const spec of tradeWorkerSpecs()) {
            expect(spec.concurrency).toBe(1);
        }
        expect(TRADE_WORKER_CONCURRENCY).toBe(1);
    });
    it('never gives two workers the same queue', () => {
        const queues = tradeWorkerSpecs().map((spec) => spec.queue);
        expect(new Set(queues).size).toBe(queues.length);
    });
    it('drains the pre-split queue by default', () => {
        // Jobs enqueued by the previous release are still in `swat-trades` at
        // cutover and nothing else will ever read them.
        const legacy = tradeWorkerSpecs().filter((spec) => spec.queue === QUEUES.trades);
        expect(legacy).toHaveLength(1);
        expect(legacy[0]).toMatchObject({ chain: null, drainOnly: true });
    });
    it('can be told to stop draining once the queue is empty', () => {
        const specs = tradeWorkerSpecs({ drainLegacyQueue: false });
        expect(specs.some((spec) => spec.queue === QUEUES.trades)).toBe(false);
        expect(specs.every((spec) => spec.drainOnly === false)).toBe(true);
    });
});
describe('misroutedJobWarning', () => {
    it('stays silent for a job on the queue that owns its chain', () => {
        expect(misroutedJobWarning(solanaSpec, 'solana')).toBeNull();
    });
    it('warns when another chain’s job lands on this queue', () => {
        for (const chain of ['polygon', 'robinhood-chain']) {
            const warning = misroutedJobWarning(solanaSpec, chain);
            expect(warning).toContain('misrouted job');
            expect(warning).toContain(chain);
            expect(warning).toContain('swat-trades-solana');
        }
    });
    it('never warns on the drain queue, which carries every chain', () => {
        // The pre-split queue legitimately holds jobs for all three chains, so a
        // warning there would fire on every drained job.
        expect(misroutedJobWarning(legacySpec, 'polygon')).toBeNull();
        expect(misroutedJobWarning(legacySpec, 'solana')).toBeNull();
        expect(misroutedJobWarning(legacySpec, 'robinhood-chain')).toBeNull();
    });
});
//# sourceMappingURL=trade-workers.test.js.map