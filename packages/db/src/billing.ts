import type { PoolClient } from 'pg';
import {
  BILLING_GRACE_PERIOD_DAYS,
  BILLING_RENEWAL_ALERT_DAYS,
  calculateTierExtension,
  canonicalPaymentHash,
  generateBillingMemo,
  resolveBillingPlan,
  type BillingChain,
  type BillingPlanId,
  type UserTier
} from '@swat/shared';
import { query } from './client.js';
import { recordAuditEventStrict } from './audit-log.js';
import type { UserScope } from './tenancy.js';
import { withTransaction } from './transaction.js';
import { invalidateUserSessionCache } from './users.js';

export class DuplicatePaymentTransactionError extends Error {
  constructor(readonly chain: BillingChain, readonly txHash: string) {
    super(`Transaction ${txHash} on chain ${chain} has already been credited`);
    this.name = 'DuplicatePaymentTransactionError';
  }
}

export class PaymentClaimRejectedError extends Error {
  constructor() { super('Payment intent or verified payer is no longer eligible'); this.name = 'PaymentClaimRejectedError'; }
}

export class InvalidBillingPlanError extends Error {
  constructor(readonly planId: string) {
    super(`Invalid billing plan: ${planId}`);
    this.name = 'InvalidBillingPlanError';
  }
}

export class UnderpaidPaymentError extends Error {
  constructor(readonly expectedUsdc: number, readonly receivedUsdc: number) {
    super(`Payment of ${receivedUsdc} USDC is insufficient for plan price of ${expectedUsdc} USDC`);
    this.name = 'UnderpaidPaymentError';
  }
}

export interface CryptoPaymentRecord {
  readonly id: string;
  readonly userId: string;
  readonly chain: BillingChain;
  readonly txHash: string;
  readonly amountUsdc: number;
  readonly tier: UserTier;
  readonly planId: BillingPlanId;
  readonly durationDays: number | null;
  readonly payerAddress: string | null;
  readonly treasuryAddress: string;
  readonly memo: string | null;
  readonly status: 'confirmed' | 'underpaid' | 'refund_requested';
  readonly confirmedAt: Date;
}

export interface PaymentIntentRecord {
  readonly id: string;
  readonly userId: string;
  readonly referenceMemo: string;
  readonly planId: BillingPlanId;
  readonly tier: UserTier;
  readonly expectedAmountUsdc: number;
  readonly status: 'pending' | 'completed' | 'expired';
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface UserBillingStatus {
  readonly tier: UserTier;
  readonly effectiveTier: UserTier;
  readonly tierExpiresAt: Date | null;
  readonly isLifetime: boolean;
  readonly daysRemaining: number | null;
  readonly inGracePeriod: boolean;
  readonly renewalAlert: boolean;
}

/**
 * Creates a pending payment intent with a unique reference memo for a user.
 */
export async function createPaymentIntent(
  scope: UserScope,
  planId: BillingPlanId
): Promise<PaymentIntentRecord> {
  const plan = resolveBillingPlan(planId);
  if (!plan) throw new InvalidBillingPlanError(planId);

  const referenceMemo = generateBillingMemo(scope.userId);
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h validity

  const rows = await query<{
    id: string;
    user_id: string;
    reference_memo: string;
    plan_id: BillingPlanId;
    tier: UserTier;
    expected_amount_usdc: string | number;
    status: 'pending' | 'completed' | 'expired';
    expires_at: Date;
    created_at: Date;
  }>(
    `INSERT INTO user_payment_intents
       (user_id, reference_memo, plan_id, tier, expected_amount_usdc, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, reference_memo, plan_id, tier, expected_amount_usdc, status, expires_at, created_at`,
    [scope.userId, referenceMemo, plan.id, plan.tier, plan.priceUsdc, expiresAt]
  );

  const row = rows[0]!;
  return {
    id: row.id,
    userId: row.user_id,
    referenceMemo: row.reference_memo,
    planId: row.plan_id,
    tier: row.tier,
    expectedAmountUsdc: Number(row.expected_amount_usdc),
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

/**
 * Confirms an on-chain crypto payment, records the payment receipt, and upgrades
 * or extends the user's tier inside an atomic database transaction.
 */
export async function recordCryptoPaymentAndGrantTier(input: {
  scope: UserScope;
  chain: BillingChain;
  txHash: string;
  amountUsdc: number;
  planId: BillingPlanId;
  payerAddress?: string | null;
  treasuryAddress: string;
  memo?: string | null;
  now?: Date;
}): Promise<{
  payment: CryptoPaymentRecord;
  updatedTier: UserTier;
  updatedExpiresAt: Date | null;
}> {
  const plan = resolveBillingPlan(input.planId);
  if (!plan) throw new InvalidBillingPlanError(input.planId);

  if (!Number.isFinite(input.amountUsdc) || input.amountUsdc < plan.priceUsdc) {
    throw new UnderpaidPaymentError(plan.priceUsdc, input.amountUsdc);
  }

  const now = input.now ?? new Date();
  const txHash = canonicalPaymentHash(input.chain, input.txHash);
  const memo = input.memo?.trim() || null;
  const payerAddress = input.chain === 'polygon' ? input.payerAddress?.trim().toLowerCase() : input.payerAddress?.trim();
  if (!payerAddress) throw new PaymentClaimRejectedError();

  const result = await withTransaction(async (client: PoolClient) => {
    // 1. Fetch current user tier state FOR UPDATE to lock the row against concurrent race conditions
    const userRes = await client.query<{ tier: UserTier; tier_expires_at: Date | null }>(
      'SELECT tier, tier_expires_at FROM users WHERE id = $1 FOR UPDATE',
      [input.scope.userId]
    );

    if (userRes.rows.length === 0) {
      throw new Error(`User ${input.scope.userId} not found`);
    }

    // Serialize the canonical transaction identity, including pre-fix mixed-case
    // receipts. Historical rows are checked, never rewritten or silently merged.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`billing:${input.chain}:${txHash}`]);
    const duplicate = await client.query(`SELECT id FROM crypto_payments WHERE chain = $1 AND
      (CASE WHEN chain = 'polygon' THEN lower(btrim(tx_hash)) ELSE btrim(tx_hash) END) = $2`, [input.chain, txHash]);
    if (duplicate.rows.length) throw new DuplicatePaymentTransactionError(input.chain, txHash);

    const payer = await client.query(`SELECT id FROM user_auth_wallets
      WHERE user_id = $1 AND chain_kind = $2 AND address = $3
        AND EXISTS (SELECT 1 FROM audit_log a WHERE a.event = 'auth.wallet_linked'
          AND a.actor_type = 'user' AND a.actor_id = user_auth_wallets.user_id
          AND a.target_id = user_auth_wallets.address AND a.occurred_at >= user_auth_wallets.verified_at)
      FOR SHARE`, [input.scope.userId, input.chain === 'solana' ? 'solana' : 'evm', payerAddress]);
    if (payer.rows.length !== 1) throw new PaymentClaimRejectedError();

    let intentId: string | null = null;
    if (memo) {
      const { rows } = await client.query(`SELECT id, user_id, status, plan_id, expected_amount_usdc, expires_at
        FROM user_payment_intents WHERE reference_memo = $1 FOR UPDATE`, [memo]);
      const intent = rows[0];
      if (rows.length !== 1 || intent.user_id !== input.scope.userId || intent.status !== 'pending'
          || intent.plan_id !== plan.id || Number(intent.expected_amount_usdc) !== plan.priceUsdc
          || !(new Date(intent.expires_at).getTime() > Date.now())) throw new PaymentClaimRejectedError();
      intentId = intent.id;
    }

    const currentUser = userRes.rows[0]!;
    const extension = calculateTierExtension({
      currentTier: currentUser.tier,
      currentExpiry: currentUser.tier_expires_at,
      targetTier: plan.tier,
      durationDays: plan.durationDays,
      now
    });

    // 2. Insert into crypto_payments (enforces UNIQUE(chain, tx_hash))
    let paymentRes;
    try {
      paymentRes = await client.query<{
        id: string;
        user_id: string;
        chain: BillingChain;
        tx_hash: string;
        amount_usdc: string | number;
        tier: UserTier;
        plan_id: BillingPlanId;
        duration_days: number | null;
        payer_address: string | null;
        treasury_address: string;
        memo: string | null;
        status: 'confirmed' | 'underpaid' | 'refund_requested';
        confirmed_at: Date;
      }>(
        `INSERT INTO crypto_payments
           (user_id, chain, tx_hash, amount_usdc, tier, plan_id, duration_days, payer_address, treasury_address, memo, status, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', $11)
         RETURNING *`,
        [
          input.scope.userId,
          input.chain,
          txHash,
          input.amountUsdc,
          plan.tier,
          plan.id,
          plan.durationDays,
          payerAddress,
          input.treasuryAddress,
          memo,
          now
        ]
      );
    } catch (err: unknown) {
      // 23505 = unique_violation on uq_crypto_payments_chain_tx
      if ((err as { code?: string }).code === '23505') {
        throw new DuplicatePaymentTransactionError(input.chain, txHash);
      }
      throw err;
    }

    // 3. Update user's tier and expiry
    await client.query(
      'UPDATE users SET tier = $2, tier_expires_at = $3, updated_at = NOW() WHERE id = $1',
      [input.scope.userId, extension.tier, extension.expiresAt]
    );

    // Recheck expiry at consumption, after any lock/verification delay.
    if (intentId) {
      const consumed = await client.query(`UPDATE user_payment_intents SET status = 'completed'
        WHERE id = $1 AND user_id = $2 AND status = 'pending' AND plan_id = $3
          AND expires_at > clock_timestamp() RETURNING id`, [intentId, input.scope.userId, plan.id]);
      if (consumed.rows.length !== 1) throw new PaymentClaimRejectedError();
    }

    // 5. Strict audit log entry
    await recordAuditEventStrict({
      actorType: 'user',
      actorId: input.scope.userId,
      event: 'billing.crypto_payment_confirmed',
      targetType: 'user',
      targetId: input.scope.userId,
      metadata: {
        chain: input.chain,
        txHash,
        amountUsdc: input.amountUsdc,
        planId: plan.id,
        newTier: extension.tier,
        expiresAt: extension.expiresAt?.toISOString() ?? null
      }
    }, client);

    const row = paymentRes.rows[0]!;
    return {
      payment: {
        id: row.id,
        userId: row.user_id,
        chain: row.chain,
        txHash: row.tx_hash,
        amountUsdc: Number(row.amount_usdc),
        tier: row.tier,
        planId: row.plan_id,
        durationDays: row.duration_days,
        payerAddress: row.payer_address,
        treasuryAddress: row.treasury_address,
        memo: row.memo,
        status: row.status,
        confirmedAt: row.confirmed_at
      },
      updatedTier: extension.tier,
      updatedExpiresAt: extension.expiresAt
    };
  });
  invalidateUserSessionCache(input.scope.userId);
  return result;
}

/**
 * Returns a user's current billing and subscription state.
 */
export async function getUserBillingStatus(scope: UserScope, now = new Date()): Promise<UserBillingStatus> {
  const rows = await query<{ tier: UserTier; tier_expires_at: Date | null }>(
    'SELECT tier, tier_expires_at FROM users WHERE id = $1',
    [scope.userId]
  );

  if (rows.length === 0) {
    return {
      tier: 'free',
      effectiveTier: 'free',
      tierExpiresAt: null,
      isLifetime: false,
      daysRemaining: null,
      inGracePeriod: false,
      renewalAlert: false
    };
  }

  const { tier, tier_expires_at } = rows[0]!;
  const isLifetime = tier_expires_at === null && tier !== 'free';

  if (isLifetime) {
    return {
      tier,
      effectiveTier: tier,
      tierExpiresAt: null,
      isLifetime: true,
      daysRemaining: null,
      inGracePeriod: false,
      renewalAlert: false
    };
  }

  if (tier_expires_at === null) {
    return {
      tier: 'free',
      effectiveTier: 'free',
      tierExpiresAt: null,
      isLifetime: false,
      daysRemaining: null,
      inGracePeriod: false,
      renewalAlert: false
    };
  }

  const msRemaining = tier_expires_at.getTime() - now.getTime();
  const daysRemaining = Math.ceil(msRemaining / (24 * 60 * 60 * 1000));
  const isExpired = msRemaining <= 0;
  const inGracePeriod = isExpired && msRemaining >= -(BILLING_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const effectiveTier = isExpired && !inGracePeriod ? 'free' : tier;
  const renewalAlert = !isExpired && daysRemaining <= BILLING_RENEWAL_ALERT_DAYS;

  return {
    tier,
    effectiveTier,
    tierExpiresAt: tier_expires_at,
    isLifetime: false,
    daysRemaining: isExpired ? 0 : daysRemaining,
    inGracePeriod,
    renewalAlert
  };
}

/**
 * Lists past payments for a user.
 */
export async function listUserCryptoPayments(scope: UserScope): Promise<CryptoPaymentRecord[]> {
  const rows = await query<{
    id: string;
    user_id: string;
    chain: BillingChain;
    tx_hash: string;
    amount_usdc: string | number;
    tier: UserTier;
    plan_id: BillingPlanId;
    duration_days: number | null;
    payer_address: string | null;
    treasury_address: string;
    memo: string | null;
    status: 'confirmed' | 'underpaid' | 'refund_requested';
    confirmed_at: Date;
  }>(
    `SELECT * FROM crypto_payments
      WHERE user_id = $1
      ORDER BY confirmed_at DESC`,
    [scope.userId]
  );

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    chain: r.chain,
    txHash: r.tx_hash,
    amountUsdc: Number(r.amount_usdc),
    tier: r.tier,
    planId: r.plan_id,
    durationDays: r.duration_days,
    payerAddress: r.payer_address,
    treasuryAddress: r.treasury_address,
    memo: r.memo,
    status: r.status,
    confirmedAt: r.confirmed_at
  }));
}

/**
 * Nightly downgrade sweep.
 *
 * Scans users whose subscriptions have expired beyond the 3-day grace period,
 * downgrades their tier back to 'free', and writes strict audit logs.
 */
export async function runTierDowngradeSweep(now = new Date()): Promise<{
  downgradedCount: number;
  downgradedUserIds: string[];
}> {
  // Grace period cutoff: expired more than BILLING_GRACE_PERIOD_DAYS ago
  const graceCutoff = new Date(now.getTime() - BILLING_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  const targetUsers = await query<{ id: string; tier: UserTier; tier_expires_at: Date }>(
    `SELECT id, tier, tier_expires_at
       FROM users
      WHERE tier <> 'free'
        AND tier_expires_at IS NOT NULL
        AND tier_expires_at < $1`,
    [graceCutoff]
  );

  if (targetUsers.length === 0) {
    return { downgradedCount: 0, downgradedUserIds: [] };
  }

  const downgradedUserIds: string[] = [];

  for (const user of targetUsers) {
    const changed = await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        "UPDATE users SET tier = 'free', updated_at = NOW() WHERE id = $1 AND tier <> 'free' AND tier_expires_at IS NOT NULL AND tier_expires_at < $2 RETURNING id",
        [user.id, graceCutoff]
      );
      if (rows.length === 0) return false;
      await recordAuditEventStrict({
        actorType: 'service', actorId: null, event: 'billing.tier_downgraded', targetType: 'user', targetId: user.id,
        metadata: { previousTier: user.tier, expiredAt: user.tier_expires_at.toISOString(), downgradedAt: now.toISOString() }
      }, client);
      return true;
    });
    if (changed) { invalidateUserSessionCache(user.id); downgradedUserIds.push(user.id); }
  }

  return {
    downgradedCount: downgradedUserIds.length,
    downgradedUserIds
  };
}
