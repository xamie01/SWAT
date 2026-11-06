import { buildIngestionHealthSnapshots } from '@swat/shared';
function formatDuration(seconds) {
    if (seconds === null)
        return 'no tracked event';
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}
function formatRatio(value) {
    return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}
export function formatIngestionOpsMessage(health, target) {
    const recovery = target === 'healthy';
    const heading = recovery
        ? 'SWAT INGESTION RECOVERY'
        : 'SWAT INGESTION OPS ALERT';
    const state = recovery
        ? 'HEALTHY'
        : health.status === 'empty'
            ? 'NO DATA'
            : 'STALE';
    return [
        `<b>${heading}</b>`,
        '',
        `<b>Chain:</b> ${health.chain}`,
        `<b>State:</b> ${state}`,
        `<b>Event lag:</b> ${formatDuration(health.lagSeconds)}`,
        `<b>Alert threshold:</b> ${formatDuration(health.staleAfterSeconds)}`,
        `<b>Last event:</b> ${health.lastEventAt ?? 'never'}`,
        `<b>Last batch:</b> ${health.lastBatchAt ?? 'never'}`,
        '',
        `<b>24h inserted:</b> ${health.inserted24h}`,
        `<b>24h skipped:</b> ${health.skipped24h}`,
        `<b>24h failed:</b> ${health.failed24h}`,
        `<b>Insert ratio:</b> ${formatRatio(health.insertRatio)}`
    ].join('\n');
}
export async function checkIngestionHealth(dependencies) {
    const now = dependencies.now?.() ?? new Date();
    const snapshots = buildIngestionHealthSnapshots(await dependencies.loadHealth(), now);
    const results = [];
    for (const health of snapshots) {
        const target = health.status === 'healthy' ? 'healthy' : 'stale';
        let reservation = null;
        let sent = false;
        try {
            reservation = await dependencies.reserve(health.chain, target);
            if (!reservation) {
                results.push({ chain: health.chain, target, action: 'none' });
                continue;
            }
            await dependencies.send(formatIngestionOpsMessage(health, target));
            sent = true;
            const completed = await dependencies.complete(health.chain, reservation, target);
            if (!completed) {
                throw new Error(`Lost ingestion alert reservation for ${health.chain}`);
            }
            results.push({ chain: health.chain, target, action: 'sent' });
        }
        catch (error) {
            if (reservation && !sent) {
                await dependencies.release(health.chain, reservation).catch(() => { });
            }
            dependencies.logError?.(`[alert-service] ingestion ${target} notification failed for ${health.chain}`, error);
            results.push({ chain: health.chain, target, action: 'failed' });
        }
    }
    return results;
}
//# sourceMappingURL=ingestion-health.js.map