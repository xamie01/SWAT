import type { Chain } from '@swat/shared';
import { query } from './client.js';
import type { FunderLabel } from './independence.js';

export interface WalletClusterMembership {
  readonly clusterType: 'funding' | 'behavioral' | null;
  readonly clusterName: string | null;
}

export interface WalletIndependenceWarning {
  readonly assessment: 'suspected-coordination' | 'unassessed';
  readonly clustered: boolean;
  /** Compatibility summary only; the complete evidence is in memberships. */
  readonly clusterType: 'funding' | 'behavioral' | null;
  readonly clusterName: string | null;
  readonly memberships: readonly WalletClusterMembership[];
  readonly warning: string;
}

export interface WalletHubStatus {
  readonly assessment: 'hub' | 'unassessed';
  /** False means no observed hub evidence, not positively independent control. */
  readonly isHub: boolean;
  readonly label: FunderLabel | null;
  readonly hubName: string | null;
  readonly reason: string;
}

/** Advisory evidence from every cluster; absent membership is not independence. */
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
      ORDER BY c.cluster_type, c.name, c.id`,
    [walletAddress]
  );

  const memberships: WalletClusterMembership[] = rows.map((row) => ({
    clusterType: row.cluster_type === 'funding' || row.cluster_type === 'behavioral' ? row.cluster_type : null,
    clusterName: row.name
  }));
  const warnings = memberships.map((membership) => membership.clusterType === 'funding'
    ? `Wallet belongs to funding cluster "${membership.clusterName ?? 'unknown'}". Shared funding suggests common control or Sybil coordination.`
    : membership.clusterType === 'behavioral'
      ? `Wallet belongs to behavioral cluster "${membership.clusterName ?? 'unknown'}". Co-movement suggests shared strategy or bot ring.`
      : `Wallet belongs to cluster "${membership.clusterName ?? 'unknown'}".`);

  return {
    assessment: memberships.length > 0 ? 'suspected-coordination' : 'unassessed',
    clustered: memberships.length > 0,
    clusterType: memberships.length === 1 ? memberships[0]!.clusterType : null,
    clusterName: memberships.length === 1 ? memberships[0]!.clusterName : null,
    memberships,
    warning: warnings.length > 0 ? warnings.join(' ') : 'Control independence is unassessed. No cluster membership is not evidence of independent control.'
  };
}

/** Same-chain aliases are aggregated; a negative blacklist lookup cannot clear control. */
export async function checkWalletHubStatus(
  walletAddress: string,
  rawAddress: string,
  chain: Chain
): Promise<WalletHubStatus> {
  const rows = await query<{ status: string; nickname: string | null }>(
    `SELECT status, nickname FROM wallets
      WHERE (address = $1 OR address = $2) AND chain = $3
      ORDER BY address`,
    [walletAddress, rawAddress, chain]
  );
  const hub = rows.find((row) => row.status === 'blacklisted');

  if (hub) {
    const hubName = hub.nickname ?? 'Exchange Hub';
    return {
      assessment: 'hub',
      isHub: true,
      label: 'exchange',
      hubName,
      reason: `This is an exchange wallet (${hubName})`
    };
  }

  return {
    assessment: 'unassessed',
    isHub: false,
    label: null,
    hubName: null,
    reason: 'Control independence is unassessed. Not blacklisted is not evidence of independent control.'
  };
}
