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
export declare function executeBillingSweepJob(now?: Date): Promise<{
    downgradedCount: number;
    downgradedUserIds: string[];
}>;
//# sourceMappingURL=billing-sweep.d.ts.map