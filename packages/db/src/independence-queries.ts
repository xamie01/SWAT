import type { Chain } from '@swat/shared';
import { query } from './client.js';
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
export async function checkWalletClusterIndependence(
  walletAddress: string
): Promise<WalletIndependenceWarning> {
  const rows = await query<{
    cluster_type: string | null;
    name: string | null;
  }>(
    `SELECT c.cluster_type, c.name
       FROM cluster_memberships cm
       JOIN wallet_clusters c ON c.id = cm.cluster_id
      WHERE cm.wallet_address = $1
      LIMIT 1`,
    [walletAddress]
  );

  if (rows.length === 0) {
    return {
      clustered: false,
      clusterType: null,
      clusterName: null,
      warning: null
    };
  }

  const row = rows[0]!;
  const clusterType = (row.cluster_type === 'funding' || row.cluster_type === 'behavioral')
    ? row.cluster_type
    : null;

  const warning = clusterType === 'funding'
    ? `Wallet belongs to funding cluster "${row.name ?? 'unknown'}". Shared funding suggests common control or Sybil coordination.`
    : clusterType === 'behavioral'
      ? `Wallet belongs to behavioral cluster "${row.name ?? 'unknown'}". Co-movement suggests shared strategy or bot ring.`
      : `Wallet belongs to cluster "${row.name ?? 'unknown'}".`;

  return {
    clustered: true,
    clusterType,
    clusterName: row.name ?? null,
    warning
  };
}

/**
 * Checks whether a candidate wallet is an exchange or infrastructure hub (S4-M11).
 *
 * Unlike cluster warnings, hub status blocks subscription: an exchange hot wallet
 * or bridge is infrastructure, not a trading strategy.
 */
export async function checkWalletHubStatus(
  walletAddress: string,
  rawAddress: string,
  _chain: Chain
): Promise<WalletHubStatus> {
  const rows = await query<{ status: string; nickname: string | null }>(
    `SELECT status, nickname FROM wallets WHERE address = $1 OR address = $2 LIMIT 1`,
    [walletAddress, rawAddress]
  );

  if (rows.length > 0 && rows[0]!.status === 'blacklisted') {
    const hubName = rows[0]!.nickname ?? 'Exchange Hub';
    return {
      isHub: true,
      label: 'exchange',
      hubName,
      reason: `This is an exchange wallet (${hubName})`
    };
  }

  return {
    isHub: false,
    label: null,
    hubName: null,
    reason: null
  };
}
