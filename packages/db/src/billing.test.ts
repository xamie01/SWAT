import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn();
  return {
    clientQuery,
    query: vi.fn(),
    connect: vi.fn(async () => ({
      query: clientQuery,
      release: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn()
    }))
  };
});

vi.mock('./client.js', () => ({
  query: mocks.query,
  pool: { connect: mocks.connect },
  readPool: { connect: mocks.connect },
  writePool: { connect: mocks.connect }
}));

vi.mock('./audit-log.js', () => ({
  recordAuditEventStrict: vi.fn().mockResolvedValue(undefined)
}));

import {
  createPaymentIntent,
  DuplicatePaymentTransactionError,
  getUserBillingStatus,
  recordCryptoPaymentAndGrantTier,
  runTierDowngradeSweep,
  UnderpaidPaymentError
} from './billing.js';
import { forUser } from './tenancy.js';

describe('db billing module', () => {
  const scope = forUser('44444444-5555-6666-7777-888888888888');
  const treasurySol = 'TreasurySolanaAddress1111111111111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createPaymentIntent', () => {
    it('creates and returns a pending intent with a unique memo', async () => {
      mocks.query.mockResolvedValueOnce([
        {
          id: 'int_1',
          user_id: scope.userId,
          reference_memo: 'SWAT-4444ABCD',
          plan_id: 'operator_monthly',
          tier: 'operator',
          expected_amount_usdc: '35.000000',
          status: 'pending',
          expires_at: new Date('2026-11-02T00:00:00Z'),
          created_at: new Date('2026-10-31T00:00:00Z')
        }
      ]);

      const intent = await createPaymentIntent(scope, 'operator_monthly');
      expect(intent.planId).toBe('operator_monthly');
      expect(intent.expectedAmountUsdc).toBe(35);
      expect(intent.referenceMemo).toBe('SWAT-4444ABCD');
      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_payment_intents'),
        expect.arrayContaining([scope.userId, expect.stringMatching(/^SWAT-/), 'operator_monthly', 'operator', 35])
      );
    });
  });

  describe('recordCryptoPaymentAndGrantTier', () => {
    it('rejects underpayment before hitting database transaction', async () => {
      await expect(
        recordCryptoPaymentAndGrantTier({
          scope,
          chain: 'solana',
          txHash: 'tx_underpaid',
          amountUsdc: 20, // Plan is 35 USDC
          planId: 'operator_monthly',
          treasuryAddress: treasurySol
        })
      ).rejects.toThrow(UnderpaidPaymentError);

      expect(mocks.connect).not.toHaveBeenCalled();
    });

    it('rejects duplicate transaction hash with DuplicatePaymentTransactionError', async () => {
      mocks.clientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ tier: 'free', tier_expires_at: null }] }) // SELECT user FOR UPDATE
        .mockRejectedValueOnce({ code: '23505' }) // INSERT crypto_payments unique violation
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      await expect(
        recordCryptoPaymentAndGrantTier({
          scope,
          chain: 'solana',
          txHash: 'tx_duplicate',
          amountUsdc: 35,
          planId: 'operator_monthly',
          treasuryAddress: treasurySol
        })
      ).rejects.toThrow(DuplicatePaymentTransactionError);
    });

    it('successfully processes payment, grants tier, and returns record', async () => {
      const fixedNow = new Date('2026-10-30T12:00:00.000Z');

      mocks.clientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ tier: 'free', tier_expires_at: null }] }) // SELECT user
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'pay_1',
              user_id: scope.userId,
              chain: 'solana',
              tx_hash: 'tx_valid_123',
              amount_usdc: '35.000000',
              tier: 'operator',
              plan_id: 'operator_monthly',
              duration_days: 30,
              payer_address: 'PayerSol111',
              treasury_address: treasurySol,
              memo: 'SWAT-MEMO1',
              status: 'confirmed',
              confirmed_at: fixedNow
            }
          ]
        }) // INSERT crypto_payments
        .mockResolvedValueOnce({ rows: [] }) // UPDATE users
        .mockResolvedValueOnce({ rows: [] }) // UPDATE user_payment_intents
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const res = await recordCryptoPaymentAndGrantTier({
        scope,
        chain: 'solana',
        txHash: 'tx_valid_123',
        amountUsdc: 35,
        planId: 'operator_monthly',
        payerAddress: 'PayerSol111',
        treasuryAddress: treasurySol,
        memo: 'SWAT-MEMO1',
        now: fixedNow
      });

      expect(res.updatedTier).toBe('operator');
      expect(res.updatedExpiresAt).toEqual(new Date('2026-11-29T12:00:00.000Z'));
      expect(res.payment.amountUsdc).toBe(35);
      expect(res.payment.txHash).toBe('tx_valid_123');
    });

    it('grants lifetime pass with null expiration and ultra tier', async () => {
      const fixedNow = new Date('2026-10-30T12:00:00.000Z');

      mocks.clientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ tier: 'operator', tier_expires_at: new Date('2026-11-15T00:00:00Z') }] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'pay_lifetime',
              user_id: scope.userId,
              chain: 'polygon',
              tx_hash: '0xabc123',
              amount_usdc: '1999.000000',
              tier: 'ultra',
              plan_id: 'lifetime',
              duration_days: null,
              payer_address: '0xpayer',
              treasury_address: '0xtreasury',
              memo: null,
              status: 'confirmed',
              confirmed_at: fixedNow
            }
          ]
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await recordCryptoPaymentAndGrantTier({
        scope,
        chain: 'polygon',
        txHash: '0xabc123',
        amountUsdc: 1999,
        planId: 'lifetime',
        treasuryAddress: '0xtreasury',
        now: fixedNow
      });

      expect(res.updatedTier).toBe('ultra');
      expect(res.updatedExpiresAt).toBeNull();
    });
  });

  describe('getUserBillingStatus', () => {
    const fixedNow = new Date('2026-10-30T12:00:00.000Z');

    it('identifies lifetime tier accurately', async () => {
      mocks.query.mockResolvedValueOnce([{ tier: 'ultra', tier_expires_at: null }]);

      const status = await getUserBillingStatus(scope, fixedNow);
      expect(status.isLifetime).toBe(true);
      expect(status.tier).toBe('ultra');
      expect(status.effectiveTier).toBe('ultra');
      expect(status.inGracePeriod).toBe(false);
      expect(status.daysRemaining).toBeNull();
    });

    it('calculates days remaining and renewal alert when close to expiry', async () => {
      // 5 days remaining -> triggers renewal alert (<= 7 days)
      const expiry = new Date('2026-11-04T12:00:00.000Z');
      mocks.query.mockResolvedValueOnce([{ tier: 'operator', tier_expires_at: expiry }]);

      const status = await getUserBillingStatus(scope, fixedNow);
      expect(status.isLifetime).toBe(false);
      expect(status.tier).toBe('operator');
      expect(status.effectiveTier).toBe('operator');
      expect(status.daysRemaining).toBe(5);
      expect(status.renewalAlert).toBe(true);
      expect(status.inGracePeriod).toBe(false);
    });

    it('identifies grace period when 1 day past expiration', async () => {
      // Expired yesterday (1 day ago < 3 days grace period)
      const expiry = new Date('2026-10-29T12:00:00.000Z');
      mocks.query.mockResolvedValueOnce([{ tier: 'operator', tier_expires_at: expiry }]);

      const status = await getUserBillingStatus(scope, fixedNow);
      expect(status.tier).toBe('operator');
      expect(status.effectiveTier).toBe('operator'); // Still active due to grace period!
      expect(status.inGracePeriod).toBe(true);
      expect(status.daysRemaining).toBe(0);
    });

    it('downgrades effective tier to free when past grace period', async () => {
      // Expired 5 days ago (> 3 days grace period)
      const expiry = new Date('2026-10-25T12:00:00.000Z');
      mocks.query.mockResolvedValueOnce([{ tier: 'operator', tier_expires_at: expiry }]);

      const status = await getUserBillingStatus(scope, fixedNow);
      expect(status.tier).toBe('operator');
      expect(status.effectiveTier).toBe('free'); // Grace period exhausted
      expect(status.inGracePeriod).toBe(false);
    });
  });

  describe('runTierDowngradeSweep', () => {
    it('downgrades users past the 3-day grace period to free', async () => {
      const fixedNow = new Date('2026-10-30T12:00:00.000Z');

      mocks.query
        .mockResolvedValueOnce([
          { id: 'user_expired_1', tier: 'operator', tier_expires_at: new Date('2026-10-25T00:00:00Z') }
        ]) // SELECT expired users
        .mockResolvedValueOnce([{ id: 'user_expired_1' }]); // UPDATE users returning id

      const result = await runTierDowngradeSweep(fixedNow);
      expect(result.downgradedCount).toBe(1);
      expect(result.downgradedUserIds).toEqual(['user_expired_1']);
      expect(mocks.query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE users SET tier = 'free'"),
        ['user_expired_1', expect.any(Date)]
      );
    });

    it('does nothing when no users are past grace period', async () => {
      mocks.query.mockResolvedValueOnce([]); // No expired users
      const result = await runTierDowngradeSweep();
      expect(result.downgradedCount).toBe(0);
      expect(result.downgradedUserIds).toEqual([]);
    });
  });
});
