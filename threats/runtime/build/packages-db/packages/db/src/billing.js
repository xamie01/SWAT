import { BILLING_GRACE_PERIOD_DAYS, BILLING_RENEWAL_ALERT_DAYS, calculateTierExtension, generateBillingMemo, resolveBillingPlan } from '@swat/shared';
import { query } from './client.js';
import { recordAuditEventStrict } from './audit-log.js';
import { withTransaction } from './transaction.js';
import { invalidateUserSessionCache } from './users.js';
export class DuplicatePaymentTransactionError extends Error {
    chain;
    txHash;
    constructor(chain, txHash) {
        super(`Transaction ${txHash} on chain ${chain} has already been credited`);
        this.chain = chain;
        this.txHash = txHash;
        this.name = 'DuplicatePaymentTransactionError';
    }
}
export class InvalidBillingPlanError extends Error {
    planId;
    constructor(planId) {
        super(`Invalid billing plan: ${planId}`);
        this.planId = planId;
        this.name = 'InvalidBillingPlanError';
    }
}
export class UnderpaidPaymentError extends Error {
    expectedUsdc;
    receivedUsdc;
    constructor(expectedUsdc, receivedUsdc) {
        super(`Payment of ${receivedUsdc} USDC is insufficient for plan price of ${expectedUsdc} USDC`);
        this.expectedUsdc = expectedUsdc;
        this.receivedUsdc = receivedUsdc;
        this.name = 'UnderpaidPaymentError';
    }
}
/**
 * Creates a pending payment intent with a unique reference memo for a user.
 */
export async function createPaymentIntent(scope, planId) {
    const plan = resolveBillingPlan(planId);
    if (!plan)
        throw new InvalidBillingPlanError(planId);
    const referenceMemo = generateBillingMemo(scope.userId);
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h validity
    const rows = await query(`INSERT INTO user_payment_intents
       (user_id, reference_memo, plan_id, tier, expected_amount_usdc, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, reference_memo, plan_id, tier, expected_amount_usdc, status, expires_at, created_at`, [scope.userId, referenceMemo, plan.id, plan.tier, plan.priceUsdc, expiresAt]);
    const row = rows[0];
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
export async function recordCryptoPaymentAndGrantTier(input) {
    const plan = resolveBillingPlan(input.planId);
    if (!plan)
        throw new InvalidBillingPlanError(input.planId);
    if (input.amountUsdc < plan.priceUsdc) {
        throw new UnderpaidPaymentError(plan.priceUsdc, input.amountUsdc);
    }
    const now = input.now ?? new Date();
    return await withTransaction(async (client) => {
        // 1. Fetch current user tier state FOR UPDATE to lock the row against concurrent race conditions
        const userRes = await client.query('SELECT tier, tier_expires_at FROM users WHERE id = $1 FOR UPDATE', [input.scope.userId]);
        if (userRes.rows.length === 0) {
            throw new Error(`User ${input.scope.userId} not found`);
        }
        const currentUser = userRes.rows[0];
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
            paymentRes = await client.query(`INSERT INTO crypto_payments
           (user_id, chain, tx_hash, amount_usdc, tier, plan_id, duration_days, payer_address, treasury_address, memo, status, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'confirmed', $11)
         RETURNING *`, [
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
            ]);
        }
        catch (err) {
            // 23505 = unique_violation on uq_crypto_payments_chain_tx
            if (err.code === '23505') {
                throw new DuplicatePaymentTransactionError(input.chain, input.txHash);
            }
            throw err;
        }
        // 3. Update user's tier and expiry
        await client.query('UPDATE users SET tier = $2, tier_expires_at = $3, updated_at = NOW() WHERE id = $1', [input.scope.userId, extension.tier, extension.expiresAt]);
        invalidateUserSessionCache(input.scope.userId);
        // 4. If there was a matching intent, mark it as completed
        if (input.memo) {
            await client.query("UPDATE user_payment_intents SET status = 'completed' WHERE reference_memo = $1 AND user_id = $2", [input.memo, input.scope.userId]);
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
        const row = paymentRes.rows[0];
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
}
/**
 * Returns a user's current billing and subscription state.
 */
export async function getUserBillingStatus(scope, now = new Date()) {
    const rows = await query('SELECT tier, tier_expires_at FROM users WHERE id = $1', [scope.userId]);
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
    const { tier, tier_expires_at } = rows[0];
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
export async function listUserCryptoPayments(scope) {
    const rows = await query(`SELECT * FROM crypto_payments
      WHERE user_id = $1
      ORDER BY confirmed_at DESC`, [scope.userId]);
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
export async function runTierDowngradeSweep(now = new Date()) {
    // Grace period cutoff: expired more than BILLING_GRACE_PERIOD_DAYS ago
    const graceCutoff = new Date(now.getTime() - BILLING_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
    const targetUsers = await query(`SELECT id, tier, tier_expires_at
       FROM users
      WHERE tier <> 'free'
        AND tier_expires_at IS NOT NULL
        AND tier_expires_at < $1`, [graceCutoff]);
    if (targetUsers.length === 0) {
        return { downgradedCount: 0, downgradedUserIds: [] };
    }
    const downgradedUserIds = [];
    for (const user of targetUsers) {
        await query("UPDATE users SET tier = 'free', updated_at = NOW() WHERE id = $1", [user.id]);
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
//# sourceMappingURL=billing.js.map