import type { PoolClient } from 'pg';
import type { Chain, CopyExecutionMode } from '@swat/shared';
import { exactDecimal, compareExactDecimal, multiplyDecimalText, divideDecimalText, minimumExactDecimal,
  subtractExactDecimal, floorExactDecimal } from './runtime-exact-decimal.js';

export interface ExactFollowerIdentity {
  readonly userId: string | null;
  readonly chain: Chain;
  readonly targetAccount: string;
  readonly tokenMint: string;
  readonly executionMode: CopyExecutionMode;
}
export interface TrustedFollowerBalance {
  readonly providerId: string;
  readonly providerIdentity: string;
  readonly evidenceId: string;
  readonly userId: string;
  readonly chain: Chain;
  readonly network: string;
  readonly targetAccount: string;
  readonly executionMode: CopyExecutionMode;
  readonly availableUsd: string;
  readonly observedAt: Date;
  readonly expiresAt: Date;
}
export interface ReviewedFollowerSizingProvider {
  readonly providerId: string;
  readonly providerIdentity: string;
  readonly networkForChain: (chain: Chain) => string | null;
  readonly readBalance: (client: PoolClient, identity: ExactFollowerIdentity) => Promise<TrustedFollowerBalance | null>;
}
/** Bound directly by signal-engine to its existing canonical preparation seam.
 * Follower budget = min(exact available USD * persisted max_position_pct/100,
 * durable risk cap remaining). No master fill sizing or Number balance cache.
 * Provider registry/provision/receipt trust remains external, not inferred here. */
export function createExactFollowerEntryRequest(input: {
  readonly provider: ReviewedFollowerSizingProvider | null;
  readonly now: () => Date;
  readonly maximumAgeMs: number;
}) {
  return async (client: PoolClient, descriptor: { chain: Chain; data: {
    userId?: unknown; targetAccount?: string; tokenMint?: string | null;
    executionMode?: unknown; direction?: unknown;
  } }): Promise<{ requestedBaseQuantity: null; requestedQuoteQuantity: string } | null> => {
    const data = descriptor.data, provider = input.provider;
    if (!provider || data.direction !== 'buy' || typeof data.userId !== 'string' || !data.targetAccount || !data.tokenMint
      || !['paper','live','shadow'].includes(String(data.executionMode))
      || !Number.isSafeInteger(input.maximumAgeMs) || input.maximumAgeMs <= 0 || input.maximumAgeMs > 60_000) return null;
    const identity: ExactFollowerIdentity = { userId: data.userId, chain: descriptor.chain, targetAccount: data.targetAccount,
      tokenMint: data.tokenMint, executionMode: data.executionMode as CopyExecutionMode };
    const balance = await provider.readBalance(client, identity), now = input.now();
    if (!balance || !Number.isFinite(now.getTime()) || balance.providerId !== provider.providerId
      || balance.providerIdentity !== provider.providerIdentity || !balance.evidenceId
      || balance.userId !== identity.userId || balance.chain !== identity.chain || balance.targetAccount !== identity.targetAccount
      || balance.executionMode !== identity.executionMode || !balance.network || balance.network !== provider.networkForChain(identity.chain)
      || !(balance.observedAt instanceof Date) || !(balance.expiresAt instanceof Date)
      || !Number.isFinite(balance.observedAt.getTime()) || !Number.isFinite(balance.expiresAt.getTime())
      || balance.observedAt > now || balance.expiresAt <= now || now.getTime() - balance.observedAt.getTime() > input.maximumAgeMs) return null;
    exactDecimal(balance.availableUsd);
    const settings = await client.query<{ max_position_pct: string; auto_execute: boolean; killed: boolean }>(
      `SELECT max_position_pct::text,auto_execute,killed FROM user_execution_settings WHERE user_id = $1 FOR SHARE`, [identity.userId]);
    const setting = settings.rows[0];
    if (!setting || !setting.auto_execute || setting.killed) return null;
    exactDecimal(setting.max_position_pct, true);
    if (compareExactDecimal(setting.max_position_pct, '100') > 0) throw new Error('Exact follower persisted percentage invalid');
    const controls = await client.query<{ cap_usd: string; enabled: boolean; accounting_ready: boolean; spent: string; unknown: boolean }>(
      `SELECT control.cap_usd::text,control.enabled,control.accounting_ready,
        COALESCE((SELECT SUM(reservation.liability_usd)
          FROM risk_spend_reservations reservation WHERE reservation.account = control.account AND reservation.chain = control.chain
            AND reservation.execution_mode = control.execution_mode AND reservation.state <> 'released'
            AND (reservation.state <> 'confirmed' OR reservation.settled_at >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0)::text AS spent,
        EXISTS (SELECT 1 FROM risk_spend_reservations reservation WHERE reservation.account = control.account
          AND reservation.chain = control.chain AND reservation.execution_mode = control.execution_mode AND reservation.state = 'unknown') AS unknown
        FROM risk_policy_control control WHERE account = $1 AND chain = $2 AND execution_mode = $3 FOR SHARE OF control`,
    [identity.userId, identity.chain, identity.executionMode]);
    const control = controls.rows[0];
    if (!control || !control.enabled || !control.accounting_ready || control.unknown) return null;
    exactDecimal(control.cap_usd); exactDecimal(control.spent);
    if (compareExactDecimal(control.cap_usd, control.spent) <= 0) return null;
    const quantity = floorExactDecimal(minimumExactDecimal(balance.availableUsd,
      divideDecimalText(multiplyDecimalText(balance.availableUsd, setting.max_position_pct), '100', 36)!,
      subtractExactDecimal(control.cap_usd, control.spent)), 18);
    if (compareExactDecimal(quantity, '0') <= 0) return null;
    return { requestedBaseQuantity: null, requestedQuoteQuantity: quantity };
  };
}
