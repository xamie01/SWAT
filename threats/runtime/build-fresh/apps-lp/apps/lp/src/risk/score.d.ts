import { type TokenRiskFinding } from './types.js';
/** Pools scoring above the gate never reach the Discover feed. */
export declare const DEFAULT_RISK_GATE_MAX_SCORE = 40;
export interface CombinedTokenRisk {
    /** 0 (no findings) .. 100 (every known risk at full weight). */
    readonly score: number;
    readonly flags: readonly string[];
    readonly allowed: boolean;
    readonly rejectionReasons: readonly string[];
}
export declare function combineTokenRisk(findings: readonly TokenRiskFinding[], options?: {
    maxScore?: number;
}): CombinedTokenRisk;
//# sourceMappingURL=score.d.ts.map