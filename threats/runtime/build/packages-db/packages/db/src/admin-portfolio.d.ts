import type { Pool, PoolClient } from 'pg';
export interface AdminPortfolioOverview {
    totalFleetAumUsd: number;
    netRealizedPnlUsd: number;
    netRealizedPnl24hUsd: number;
    unrealizedPnlUsd: number;
    fleetWinRatePct: number;
    cumulativeGasTipBurnUsd: number;
    totalCopiersActive: number;
    openPositionsCount: number;
}
export interface AdminPortfolioUserSummary {
    id: string;
    email: string;
    role: string;
    tier: string;
    createdAt: string;
    tierExpiresAt: string | null;
    gracePeriodEndsAt: string | null;
    custodyStatus: Record<string, string>;
    totalCashFloatUsd: number;
    copiedMasters: Array<{
        masterAddress: string;
        label: string | null;
        chain: string;
        state: string;
        membershipSlot: number | null;
    }>;
    openPositionsCount: number;
    openPositionsValueUsd: number;
    unrealizedPnlUsd: number;
    realizedPnlUsd: number;
    trades24hCount: number;
    killSwitchActive: boolean;
}
export interface AdminPortfolioUserDetail {
    user: {
        id: string;
        email: string;
        role: string;
        tier: string;
        createdAt: string;
        tierExpiresAt: string | null;
        gracePeriodEndsAt: string | null;
        killSwitchActive: boolean;
        maxSlippageBps: number;
    };
    balances: Array<{
        chain: string;
        asset: string;
        balanceUsd: number;
        balanceNative: number;
        updatedAt: string;
    }>;
    openPositions: Array<{
        id: string;
        chain: string;
        tokenMint: string;
        tokenSymbol: string | null;
        confirmedQuantity: number;
        costBasisUsd: number;
        currentPriceUsd: number;
        unrealizedPnlUsd: number;
        masterWalletAddress: string | null;
    }>;
    subscriptions: Array<{
        walletAddress: string;
        chain: string;
        label: string | null;
        source: string;
        state: string;
        membershipSlot: number | null;
        createdAt: string;
        realizedPnlUsd: number;
    }>;
    executionLedger: Array<{
        id: string;
        chain: string;
        tokenMint: string;
        direction: string;
        executionMode: string;
        confirmedBaseQuantity: number;
        confirmedQuoteQuantity: number;
        fillPriceUsd: number;
        sourcePriceUsd: number;
        slippageBps: number;
        feeUsd: number;
        txHash: string | null;
        confirmedAt: string | null;
    }>;
}
export interface AdminPortfolioMasterSummary {
    masterWalletAddress: string;
    chain: string;
    label: string | null;
    followerCount: number;
    followerCap: number;
    totalFollowerCapitalUsd: number;
    copierRealizedPnlUsd: number;
    avgCopierSlippageBps: number;
    copierWinRatePct: number;
}
export interface AdminPortfolioTokenSummary {
    tokenMint: string;
    tokenSymbol: string | null;
    chain: string;
    totalHolders: number;
    totalQuantity: number;
    totalExposureUsd: number;
    concentrationPct: number;
}
export declare function getAdminPortfolioOverview(poolOrClient?: Pool | PoolClient): Promise<AdminPortfolioOverview>;
export declare function getAdminPortfolioUsers(poolOrOptions?: Pool | PoolClient | {
    page?: number;
    limit?: number;
    search?: string;
    tier?: string;
}, maybeOptions?: {
    page?: number;
    limit?: number;
    search?: string;
    tier?: string;
}): Promise<{
    users: AdminPortfolioUserSummary[];
    total: number;
}>;
export declare function getAdminPortfolioUserDetail(userIdOrPool: string | Pool | PoolClient | undefined, maybeUserId?: string): Promise<AdminPortfolioUserDetail | null>;
export declare function getAdminPortfolioMasters(poolOrClient?: Pool | PoolClient): Promise<AdminPortfolioMasterSummary[]>;
export declare function getAdminPortfolioTokens(poolOrClient?: Pool | PoolClient): Promise<AdminPortfolioTokenSummary[]>;
export declare function getAdminPortfolioExportData(typeOrPool: 'users' | 'positions' | 'executions' | 'masters' | Pool | PoolClient | undefined, maybeType?: 'users' | 'positions' | 'executions' | 'masters'): Promise<Array<Record<string, unknown>>>;
//# sourceMappingURL=admin-portfolio.d.ts.map