/**
 * Standalone Cron Job Runner: Tier Downgrade Sweep.
 *
 * Scans for users whose paid subscription tier has expired, downgrades them to 'free',
 * creates an immutable audit trail entry, and invalidates their session cache.
 *
 * Can be run via systemd timer, cron daemon, or container job:
 *   pnpm --filter @swat/api run cron:billing-sweep
 *   or: tsx apps/api/src/cron/billing-sweep.ts
 */

import { runTierDowngradeSweep, closePool } from '@swat/db';
import { Redis } from 'ioredis';
import { invalidateCachedUserSessions } from '../auth/session-cache.js';

export async function executeBillingSweepJob(
  now = new Date(),
  invalidateUsers?: (userIds: readonly string[]) => Promise<void>
): Promise<{
  downgradedCount: number;
  downgradedUserIds: string[];
}> {
  console.log(`[billing-sweep] Starting tier downgrade sweep at ${now.toISOString()}...`);
  const result = await runTierDowngradeSweep(now);
  console.log(
    `[billing-sweep] Finished: ${result.downgradedCount} expired user(s) downgraded to 'free'`
  );
  if (result.downgradedCount > 0) {
    console.log(`[billing-sweep] Downgraded User IDs: ${result.downgradedUserIds.join(', ')}`);
    if (invalidateUsers) {
      await invalidateUsers(result.downgradedUserIds);
    } else if (process.env.REDIS_CACHE_URL || process.env.REDIS_URL) {
      const redis = new Redis((process.env.REDIS_CACHE_URL || process.env.REDIS_URL)!, { maxRetriesPerRequest: 2 });
      try {
        await Promise.all(
          result.downgradedUserIds.map((userId) => invalidateCachedUserSessions(redis, userId))
        );
      } finally {
        await redis.quit().catch(() => {});
      }
    }
  }
  return result;
}

// If invoked directly from CLI / runner
if (process.argv[1]?.endsWith('billing-sweep.ts') || process.argv[1]?.endsWith('billing-sweep.js')) {
  executeBillingSweepJob()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (error) => {
      console.error('[billing-sweep] Fatal error executing sweep job:', error);
      await closePool();
      process.exit(1);
    });
}
