import type { LpChain } from '@swat/shared';
import type { UserScope } from './tenancy.js';
/**
 * Per-user LP risk guardrails (`059`, Track A3 / Track G).
 *
 * These are the thresholds Track G1/G2 enforce. The defaults here are the build
 * plan's: no single pool may hold more than 50% of a user's deployed LP
 * capital, and 50% of realized profit is swept to the reserve sub-vault. A user
 * with no row gets exactly these defaults — the config is a preference, so its
 * absence must read as "defaults", not as "no guardrails".
 */
export declare const DEFAULT_LP_GUARDRAIL_CONFIG: {
    readonly maxPoolAllocationPct: 50;
    readonly profitBankPct: 50;
};
export interface LpGuardrailConfig {
    readonly userId: string;
    readonly maxPoolAllocationPct: number;
    readonly profitBankPct: number;
    /** User-owned reserve account; `null` until the user designates one. */
    readonly reserveSubVault: {
        readonly chain: LpChain;
        readonly address: string;
    } | null;
    readonly updatedAt: Date;
}
export declare function getLpGuardrailConfig(scope: UserScope): Promise<LpGuardrailConfig | null>;
/** Row or plan defaults — callers never branch on null. */
export declare function resolveLpGuardrailConfig(scope: UserScope): Promise<LpGuardrailConfig>;
export interface UpsertLpGuardrailInput {
    readonly maxPoolAllocationPct?: number;
    readonly profitBankPct?: number;
    readonly reserveSubVault?: {
        readonly chain: LpChain;
        readonly address: string;
    } | null;
}
/**
 * Writes the whole config. Partial inputs keep their previous value where a row
 * exists and fall back to plan defaults where one does not, so a caller that
 * only flips `profitBankPct` cannot accidentally wipe the reserve pointer.
 */
export declare function upsertLpGuardrailConfig(scope: UserScope, input: UpsertLpGuardrailInput): Promise<LpGuardrailConfig>;
//# sourceMappingURL=lp-guardrails.d.ts.map