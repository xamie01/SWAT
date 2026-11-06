import type { ExpectancyReport } from '@swat/db';
export type AttributionReportingDependencies = {
    rebuildOutcomes: () => Promise<void>;
    persistReport: () => Promise<ExpectancyReport>;
    publishDigest: (message: string) => Promise<unknown>;
};
export declare function formatExpectancyDigest(report: ExpectancyReport): string | null;
/** Rebuild first so a failed attribution query can never publish a stale report. */
export declare function runAttributionReporting(dependencies: AttributionReportingDependencies): Promise<ExpectancyReport>;
//# sourceMappingURL=expectancy.d.ts.map