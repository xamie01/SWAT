import type { Chain } from '@swat/shared';
/**
 * Return chains with a reviewed, non-expired certification record.
 * Operator enablement is evaluated separately so neither control is sufficient alone.
 */
export declare function getActiveCertifiedChains(): Promise<Chain[]>;
export declare function clearChainCertificationCache(): void;
//# sourceMappingURL=chain-certifications.d.ts.map