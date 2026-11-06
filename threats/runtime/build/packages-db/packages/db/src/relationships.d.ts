import type { Chain } from '@swat/shared';
/**
 * Record (or reinforce) a funding relationship: `funder` sent SOL to `funded`.
 *
 * Confidence scales with transfer size (a one-off dust transfer is weak
 * evidence; a multi-SOL transfer is strong). Repeated transfers accumulate
 * total lamports and transfer count in `evidence`.
 */
export declare function recordFundingEdge(funder: string, funded: string, lamports: number, chain?: Chain): Promise<void>;
//# sourceMappingURL=relationships.d.ts.map