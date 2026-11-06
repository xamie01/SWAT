import type { Chain, CopyExecutionMode } from '@swat/shared';
export declare function resolvePaperCopyTargetAccount(chain: Chain, env?: NodeJS.ProcessEnv): string;
export declare function executionModesForChainMode(mode: 'paper' | 'live' | 'live+shadow'): CopyExecutionMode[];
export declare function sourceSellFractionToBps(value: string): number;
export declare function decimalQuantityToBaseUnits(quantity: string, decimals: number): bigint;
//# sourceMappingURL=canonical-copy.d.ts.map