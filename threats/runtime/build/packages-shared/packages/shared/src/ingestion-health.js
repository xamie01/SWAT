export const INGESTION_CHAINS = [
    'solana',
    'polygon',
    'robinhood-chain',
    'base',
    'ethereum',
    'bsc'
];
export const INGESTION_HEALTH_POLICY = {
    solana: { staleAfterSeconds: 5 * 60, targetLagSeconds: 5 * 60 },
    polygon: { staleAfterSeconds: 10 * 60, targetLagSeconds: 5 * 60 },
    'robinhood-chain': { staleAfterSeconds: 15 * 60, targetLagSeconds: 15 * 60 },
    base: { staleAfterSeconds: 15 * 60, targetLagSeconds: 15 * 60 },
    ethereum: { staleAfterSeconds: 15 * 60, targetLagSeconds: 15 * 60 },
    bsc: { staleAfterSeconds: 15 * 60, targetLagSeconds: 15 * 60 }
};
function parseDate(value) {
    if (value === null)
        return null;
    const parsed = value instanceof Date ? value : new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
}
function secondsSince(value, now) {
    if (!value)
        return null;
    return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 1000));
}
function normalizeCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}
export function buildIngestionHealthSnapshots(rows, now = new Date()) {
    const byChain = new Map(rows.map((row) => [row.chain, row]));
    return INGESTION_CHAINS.map((chain) => {
        const row = byChain.get(chain);
        const lastEventAt = parseDate(row?.lastEventAt ?? null);
        const lastBatchAt = parseDate(row?.lastBatchAt ?? null);
        const lastSuccessAt = parseDate(row?.lastSuccessAt ?? null);
        const inserted24h = normalizeCount(row?.inserted24h ?? 0);
        const skipped24h = normalizeCount(row?.skipped24h ?? 0);
        const failed24h = normalizeCount(row?.failed24h ?? 0);
        const lagSeconds = secondsSince(lastEventAt, now);
        const policy = INGESTION_HEALTH_POLICY[chain];
        const attempted = inserted24h + skipped24h;
        return {
            chain,
            status: lagSeconds === null
                ? 'empty'
                : lagSeconds > policy.staleAfterSeconds
                    ? 'stale'
                    : 'healthy',
            lastEventAt: lastEventAt?.toISOString() ?? null,
            lastBatchAt: lastBatchAt?.toISOString() ?? null,
            lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
            lagSeconds,
            batchLagSeconds: secondsSince(lastBatchAt, now),
            staleAfterSeconds: policy.staleAfterSeconds,
            targetLagSeconds: policy.targetLagSeconds,
            inserted24h,
            skipped24h,
            failed24h,
            insertRatio: attempted > 0 ? inserted24h / attempted : null
        };
    });
}
//# sourceMappingURL=ingestion-health.js.map