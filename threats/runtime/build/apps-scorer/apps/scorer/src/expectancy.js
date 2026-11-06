export function formatExpectancyDigest(report) {
    if (report.rows.length === 0)
        return null;
    return report.rows.slice(0, 10).map((row) => `${row.pattern_type} | ${row.tier ?? 'all'} | ${row.chain} | ${row.execution_mode}\n` +
        `Count: ${row.eligible_outcomes} | HR: ${Number(row.hit_rate_pct).toFixed(1)}% | ` +
        `Exp: $${Number(row.expectancy_usd).toFixed(2)}`).join('\n\n');
}
/** Rebuild first so a failed attribution query can never publish a stale report. */
export async function runAttributionReporting(dependencies) {
    await dependencies.rebuildOutcomes();
    const report = await dependencies.persistReport();
    const digest = formatExpectancyDigest(report);
    if (digest)
        await dependencies.publishDigest(digest);
    return report;
}
//# sourceMappingURL=expectancy.js.map