import type { PoolClient } from 'pg';
import {
  BILLING_GRACE_PERIOD_DAYS,
  BILLING_RENEWAL_ALERT_DAYS,
  calculateTierExtension,
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

  if (input.amountUsdc < plan.priceUsdc) {
    throw new UnderpaidPaymentError(plan.priceUsdc, input.amountUsdc);
  }

  const now = input.now ?? new Date();

  const result = await withTransaction(async (client: PoolClient) => {
    // 1. Fetch current user tier state FOR UPDATE to lock the row against concurrent race conditions
    const userRes = await client.query<{ tier: UserTier; tier_expires_at: Date | null }>(
      'SELECT tier, tier_expires_at FROM users WHERE id = $1 FOR UPDATE',
      [input.scope.userId]
    );

    if (userRes.rows.length === 0) {
      throw new Error(`User ${input.scope.userId} not found`);
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
          input.txHash,
          input.amountUsdc,
          plan.tier,
          plan.id,
          plan.durationDays,
          input.payerAddress ?? null,
          input.treasuryAddress,
          input.memo ?? null,
          now
        ]
      );
    } catch (err: unknown) {
      // 23505 = unique_violation on uq_crypto_payments_chain_tx
      if ((err as { code?: string }).code === '23505') {
        throw new DuplicatePaymentTransactionError(input.chain, input.txHash);
      }
      throw err;
    }

    // 3. Update user's tier and expiry
    await client.query(
      'UPDATE users SET tier = $2, tier_expires_at = $3, updated_at = NOW() WHERE id = $1',
      [input.scope.userId, extension.tier, extension.expiresAt]
    );

    // 4. If there was a matching intent, mark it as completed
    if (input.memo) {
      await client.query(
        "UPDATE user_payment_intents SET status = 'completed' WHERE reference_memo = $1 AND user_id = $2",
        [input.memo, input.scope.userId]
      );
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
        txHash: input.txHash,
        amountUsdc: input.amountUsdc,
        planId: plan.id,
        newTier: extension.tier,
        expiresAt: extension.expiresAt?.toISOString() ?? null
      }
    });

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
    // API-04: Atomic conditional update prevents overwriting a newly renewed tier
    const updated = await query<{ id: string }>(
      "UPDATE users SET tier = 'free', updated_at = NOW() WHERE id = $1 AND tier <> 'free' AND tier_expires_at IS NOT NULL AND tier_expires_at < $2 RETURNING id",
      [user.id, graceCutoff]
    );
    if (updated.length === 0) {
      continue;
    }
    invalidateUserSessionCache(user.id);

    downgradedUserIds.push(user.id);

    await recordAuditEventStrict({
      actorType: 'service',
      actorId: 'billing-sweeper',
      event: 'billing.tier_downgraded',
      targetType: 'user',
      targetId: user.id,
      metadata: {
        previousTier: user.tier,
        expiredAt: user.tier_expires_at.toISOString(),
        downgradedAt: now.toISOString()
      }
    });
  }

  return {
    downgradedCount: downgradedUserIds.length,
    downgradedUserIds
  };
}
