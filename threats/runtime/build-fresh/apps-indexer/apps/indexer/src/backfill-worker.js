import { isChain, resolveChainAddress } from '@swat/shared';
import { runTrackedIngestion } from './ingestion-health.js';
export function getBackfillSource(chain) {
    if (chain === 'solana')
        return 'solana-backfill';
    if (chain === 'polygon')
        return 'polymarket-data-api';
    return 'robinhood-evm';
}
export function createWalletBackfillProcessor(dependencies) {
    return async (job) => {
        const data = job.data;
        if (!isChain(data.chain)) {
            throw new Error(`Unsupported wallet backfill chain: ${String(data.chain)}`);
        }
        if (typeof data.address !== 'string') {
            throw new Error('Wallet backfill job is missing an address');
        }
        const resolved = resolveChainAddress(data.address, data.chain);
        const { chain, raw: address } = resolved;
        const source = dependencies.sourceForChain?.(chain) ?? getBackfillSource(chain);
        console.log(`[indexer] backfill started for ${address} (${chain})`);
        const result = await runTrackedIngestion({
            chain,
            source,
            run: () => {
                if (chain === 'solana')
                    return dependencies.backfillSolana(address);
                if (chain === 'polygon')
                    return dependencies.backfillPolygon(address);
                return dependencies.backfillRobinhood(address);
            }
        }, dependencies.recordBatch);
        console.log(`[indexer] backfill complete for ${address} (${chain}):`, result);
        // Immediate post-backfill scoring so trader metrics are created instantly
        try {
            const { getWalletMetrics, updateWalletScore } = await import('@swat/db');
            const { calculateCompositeScore, scoreToTier } = await import('@swat/shared');
            const metrics = await getWalletMetrics(resolved.prefixed, chain);
            const score = calculateCompositeScore(metrics);
            const tier = scoreToTier(score);
            await updateWalletScore(resolved.prefixed, score, tier, metrics);
            console.log(`[indexer] immediate post-backfill scoring complete for ${resolved.prefixed}: score=${score}, tier=${tier}`);
        }
        catch (scoreErr) {
            console.warn(`[indexer] post-backfill scoring deferred for ${resolved.prefixed}:`, scoreErr);
        }
        return { address, chain, ...result };
    };
}
//# sourceMappingURL=backfill-worker.js.map