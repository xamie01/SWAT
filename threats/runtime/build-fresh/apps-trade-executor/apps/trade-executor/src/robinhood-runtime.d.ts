import type { Hex } from 'viem';
import { type RobinhoodPendingStore, type RobinhoodQuoteAdapter, type RobinhoodSafetyAssessment, type RobinhoodOrder, type RobinhoodRouteResult } from './robinhood.js';
import { type RedisHashClient } from './runtime-codec.js';
export declare function createRedisRobinhoodPendingStore(redis: RedisHashClient, key?: string): RobinhoodPendingStore;
type SafetyContext = {
    order: RobinhoodOrder;
    route: Extract<RobinhoodRouteResult, {
        status: 'route';
    }>;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
};
export declare function createRobinhoodSafetyAssessment(options: {
    quote: RobinhoodQuoteAdapter;
    minimumLiquidityUsd: number;
    liquidityLookup?: (token: string) => Promise<number | null>;
    readOwner?: (token: `0x${string}`) => Promise<`0x${string}` | null>;
    /**
     * Reports whether the token's contract source is verified on a reviewed
     * Robinhood Chain explorer. Absent by default: there is no such provider
     * configured, and an unverified assumption either way would be worse than
     * declaring the check unreliable.
     */
    verifySource?: (token: `0x${string}`) => Promise<boolean | null>;
    /**
     * Returns the share of supply held by the largest non-pool holder, as a
     * fraction in [0,1]. Absent by default for the same reason.
     */
    readHolderConcentration?: (token: `0x${string}`) => Promise<number | null>;
    /**
     * Returns the token's transfer tax in basis points, or 0 for a plain ERC-20.
     * Uniswap V3 has no fee-on-transfer swap variant, so a taxed token cannot be
     * exited through this router at all and is refused rather than attempted.
     */
    probeFeeOnTransfer?: (token: `0x${string}`) => Promise<number | null>;
    /** Maximum tolerated transfer tax in bps. Defaults to 0 — any tax is refused. */
    maxTransferFeeBps?: number;
}): (context: SafetyContext) => Promise<RobinhoodSafetyAssessment>;
export type RobinhoodTerminalPersistence = {
    clientOrderId: string;
    transactionHash?: Hex;
    status: 'filled' | 'failed';
    reason?: string;
};
export {};
//# sourceMappingURL=robinhood-runtime.d.ts.map