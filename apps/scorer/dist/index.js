import cron from 'node-cron';
import { getWalletMetrics, updateWalletScore, pauseUnderperformingWallets, promoteHighScoringDiscoveredWallets, reactivateDormantWallets, getActiveWallets, generateFundingClusters, generateBehavioralClusters } from '@swat/db';
import { calculateCompositeScore, scoreToTier } from '@swat/shared';
async function runScoringBatch() {
    console.log('[scorer] Starting nightly scoring batch...');
    const startTime = Date.now();
    const wallets = await getActiveWallets();
    console.log(`[scorer] Scoring ${wallets.length} active wallets...`);
    let scored = 0;
    let errors = 0;
    for (const wallet of wallets) {
        try {
            const metrics = await getWalletMetrics(wallet.address);
            const score = calculateCompositeScore(metrics);
            const tier = scoreToTier(score);
            await updateWalletScore(wallet.address, score, tier, metrics);
            scored++;
        }
        catch (e) {
            console.error(`[scorer] Error scoring ${wallet.address}:`, e);
            errors++;
        }
    }
    console.log(`[scorer] Scored ${scored} wallets (${errors} errors)`);
    console.log('[scorer] Running pruning rules...');
    await pauseUnderperformingWallets();
    await promoteHighScoringDiscoveredWallets();
    await reactivateDormantWallets();
    console.log('[scorer] Running clustering engines...');
    await generateFundingClusters();
    await generateBehavioralClusters();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[scorer] Batch complete in ${elapsed}s.`);
}
// Nightly at 02:00 UTC
cron.schedule('0 2 * * *', () => {
    runScoringBatch().catch(console.error);
}, { timezone: 'UTC' });
console.log('[scorer] Service running. Scheduled at 02:00 UTC daily.');
if (process.env.RUN_ON_STARTUP === 'true') {
    runScoringBatch().catch(console.error);
}
//# sourceMappingURL=index.js.map