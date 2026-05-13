import cron from 'node-cron';
import { getWalletMetrics, updateWalletScore, pauseUnderperformingWallets, getActiveWallets, generateFundingClusters, generateBehavioralClusters } from '@swat/db';
import { calculateCompositeScore, scoreToTier } from '@swat/shared';

async function runScoringBatch() {
  console.log('[scorer] Starting nightly scoring batch...');
  
  const wallets = await getActiveWallets();
  for (const wallet of wallets) {
    try {
      const metrics = await getWalletMetrics(wallet.address);
      const score = calculateCompositeScore(metrics);
      const tier = scoreToTier(score);
      await updateWalletScore(wallet.address, score, tier, metrics);
      console.log(`[scorer] Scored ${wallet.address}: ${score} (${tier})`);
    } catch (e) {
      console.error(`[scorer] Error scoring ${wallet.address}:`, e);
    }
  }

  console.log('[scorer] Running pruning rules...');
  await pauseUnderperformingWallets();

  console.log('[scorer] Running clustering engines...');
  await generateFundingClusters();
  await generateBehavioralClusters();

  console.log('[scorer] Batch complete.');
}

cron.schedule('0 2 * * *', () => {
  runScoringBatch().catch(console.error);
}, {
  timezone: "UTC"
});

console.log('[scorer] Service running. Scheduled at 02:00 UTC daily.');

if (process.env.RUN_ON_STARTUP === 'true') {
  runScoringBatch();
}
