import type { Chain } from '@swat/shared';
import type { FunderLabel } from './independence.js';
export interface WalletIndependenceWarning {
    readonly clustered: boolean;
    readonly clusterType: 'funding' | 'behavioral' | null;
    readonly clusterName: string | null;
    readonly warning: string | null;
}
export interface WalletHubStatus {
    readonly isHub: boolean;
    readonly label: FunderLabel | null;
    readonly hubName: string | null;
    readonly reason: string | null;
}
/**
 * Checks whether a candidate wallet belongs to a funding or behavioral cluster (S4-M10).
 *
 * This check is advisory: it produces a descriptive warning to surface to the user,
 * but never blocks a subscription outright (a user may knowingly copy a clustered wallet).
 */
export declare function checkWalletClusterIndependence(walletAddress: string): Promise<WalletIndependenceWarning>;
/**
 * Checks whether a candidate wallet is an exchange or infrastructure hub (S4-M11).
 *
 * Unlike cluster warnings, hub status blocks subscription: an exchange hot wallet
 * or bridge is infrastructure, not a trading strategy.
 */
export declare function checkWalletHubStatus(walletAddress: string, rawAddress: string, _chain: Chain): Promise<WalletHubStatus>;
//# sourceMappingURL=independence-queries.d.ts.map