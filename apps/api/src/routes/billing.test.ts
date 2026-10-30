import Fastify, { type FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://swat:swat@127.0.0.1:5432/swat_route_tests';
});

import {
  DEFAULT_TREASURY_ADDRESSES,
  registerBillingRoutes,
  type BillingDependencies
} from './billing.js';
import { DuplicatePaymentTransactionError, UnderpaidPaymentError, type UserBillingStatus } from '@swat/db';

const USER_A = '11111111-1111-4111-8111-111111111111';

interface Harness {
  readonly app: FastifyInstance;
  readonly deps: {
    [K in keyof BillingDependencies]: ReturnType<typeof vi.fn>;
  } & BillingDependencies;
}

function billingStatus(overrides: Partial<UserBillingStatus> = {}): UserBillingStatus {
  return {
    tier: 'operator',
    effectiveTier: 'operator',
    tierExpiresAt: new Date('2026-11-29T12:00:00Z'),
    isLifetime: false,
    daysRemaining: 30,
    inGracePeriod: false,
    renewalAlert: false,
    ...overrides
  };
}

async function harness(overrides: Partial<BillingDependencies> = {}): Promise<Harness> {
  const deps = {
    createPaymentIntent: vi.fn(async (_scope, planId) => ({
      id: 'intent_1',
      userId: USER_A,
      referenceMemo: 'SWAT-1111ABCD',
      planId,
      tier: planId === 'operator_monthly' ? 'operator' : 'ultra',
      expectedAmountUsdc: planId === 'operator_monthly' ? 35 : planId === 'ultra_monthly' ? 150 : 1999,
      status: 'pending' as const,
      expiresAt: new Date('2026-11-02T00:00:00Z'),
      createdAt: new Date('2026-10-31T00:00:00Z')
    })),
    recordCryptoPaymentAndGrantTier: vi.fn(async (input) => ({
      payment: {
        id: 'payment_1',
        userId: USER_A,
        chain: input.chain,
        txHash: input.txHash,
        amountUsdc: input.amountUsdc,
        tier: input.planId === 'operator_monthly' ? 'operator' : 'ultra',
        planId: input.planId,
        durationDays: input.planId === 'lifetime' ? null : 30,
        payerAddress: input.payerAddress ?? null,
        treasuryAddress: input.treasuryAddress,
        memo: input.memo ?? null,
        status: 'confirmed' as const,
        confirmedAt: new Date()
      },
      updatedTier: input.planId === 'operator_monthly' ? 'operator' : 'ultra',
      updatedExpiresAt: input.planId === 'lifetime' ? null : new Date('2026-11-29T12:00:00Z')
    })),
    getUserBillingStatus: vi.fn(async () => billingStatus()),
    listUserCryptoPayments: vi.fn(async () => []),
    runTierDowngradeSweep: vi.fn(async () => ({ downgradedCount: 0, downgradedUserIds: [] })),
    verifyOnChainPayment: vi.fn(async () => ({
      verified: true,
      payerAddress: '0xPayerWallet',
      amountUsdc: 35
    })),
    ...overrides
  } as unknown as Harness['deps'];

  const app = Fastify();
  app.decorateRequest('principal', undefined);
  app.addHook('onRequest', async (request) => {
    const userHeader = request.headers['x-test-user'];
    const userId = Array.isArray(userHeader) ? userHeader[0] : userHeader;
    const roleHeader = request.headers['x-test-role'];
    const role = (Array.isArray(roleHeader) ? roleHeader[0] : roleHeader) ?? 'user';

    if (userId) {
      request.principal = {
        kind: 'user',
        sessionId: 'session-test',
        user: {
          id: userId,
          role,
          tier: 'free',
          tierExpiresAt: null,
          status: 'active'
        }
      } as never;
    }
  });

  await registerBillingRoutes(app, deps);
  return { app, deps };
}

describe('Billing Routes', () => {
  describe('GET /v1/billing/plans', () => {
    it('returns plans and treasury addresses publicly without authentication', async () => {
      const { app } = await harness();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/billing/plans'
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.plans).toBeInstanceOf(Array);
      expect(body.plans.length).toBe(3);
      expect(body.plans.find((p: { id: string }) => p.id === 'operator_monthly')?.priceUsdc).toBe(35);
      expect(body.plans.find((p: { id: string }) => p.id === 'ultra_monthly')?.priceUsdc).toBe(150);
      expect(body.plans.find((p: { id: string }) => p.id === 'lifetime')?.priceUsdc).toBe(1999);
      expect(body.treasuryAddresses).toEqual(DEFAULT_TREASURY_ADDRESSES);
    });
  });

  describe('GET /v1/billing/status', () => {
    it('refuses unauthenticated caller with 401', async () => {
      const { app } = await harness();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/billing/status'
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns user billing status for authenticated caller', async () => {
      const { app, deps } = await harness();
      const res = await app.inject({
        method: 'GET',
        url: '/v1/billing/status',
        headers: { 'x-test-user': USER_A }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tier).toBe('operator');
      expect(body.effectiveTier).toBe('operator');
      expect(deps.getUserBillingStatus).toHaveBeenCalled();
    });
  });

  describe('POST /v1/billing/crypto/intent', () => {
    it('refuses unauthenticated caller with 401', async () => {
      const { app } = await harness();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/crypto/intent',
        payload: { planId: 'operator_monthly' }
      });
      expect(res.statusCode).toBe(401);
    });

    it('creates an intent with memo for valid plan', async () => {
      const { app, deps } = await harness();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/crypto/intent',
        headers: { 'x-test-user': USER_A },
        payload: { planId: 'operator_monthly' }
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.intent.referenceMemo).toBe('SWAT-1111ABCD');
      expect(body.intent.expectedAmountUsdc).toBe(35);
      expect(deps.createPaymentIntent).toHaveBeenCalled();
    });

    it('rejects invalid planId with 400', async () => {
      const { app } = await harness();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/crypto/intent',
        headers: { 'x-test-user': USER_A },
        payload: { planId: 'super_fake_plan' }
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /v1/billing/crypto/verify', () => {
    it('returns 422 if on-chain verification fails', async () => {
      const { app, deps } = await harness({
        verifyOnChainPayment: vi.fn().mockResolvedValue({
          verified: false,
          payerAddress: null,
          amountUsdc: 0
        })
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/crypto/verify',
        headers: { 'x-test-user': USER_A },
        payload: {
          chain: 'polygon',
          txHash: '0x1234567890abcdef1234567890abcdef',
          planId: 'operator_monthly'
        }
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('Unprocessable Entity');
      expect(deps.recordCryptoPaymentAndGrantTier).not.toHaveBeenCalled();
    });

    it('verifies on-chain payment and upgrades account tier', async () => {
      const { app, deps } = await harness();

      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/crypto/verify',
        headers: { 'x-test-user': USER_A },
        payload: {
          chain: 'solana',
          txHash: '5NfD9fH2X87qABCDEF1234567890abcdef',
          planId: 'operator_monthly',
          memo: 'SWAT-1111ABCD'
        }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.tier).toBe('operator');
      expect(body.amountUsdc).toBe(35);
      expect(deps.recordCryptoPaymentAndGrantTier).toHaveBeenCalled();
    });

    it('returns 409 Conflict on duplicate transaction replay', async () => {
      const { app } = await harness({
        recordCryptoPaymentAndGrantTier: vi.fn().mockRejectedValue(
          new DuplicatePaymentTransactionError('solana', '5NfD9fH2X87qABCDEF1234567890abcdef')
        )
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/billing/crypto/verify',
        headers: { 'x-test-user': USER_A },
        payload: {
          chain: 'solana',
          txHash: '5NfD9fH2X87qABCDEF1234567890abcdef',
          planId: 'operator_monthly'
        }
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Conflict');
    });
  });

  describe('POST /v1/admin/billing/sweep', () => {
    it('refuses non-admin user with 403', async () => {
      const { app } = await harness();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/billing/sweep',
        headers: { 'x-test-user': USER_A, 'x-test-role': 'user' }
      });
      expect(res.statusCode).toBe(403);
    });

    it('admits admin and runs downgrade sweep', async () => {
      const { app, deps } = await harness({
        runTierDowngradeSweep: vi.fn().mockResolvedValue({
          downgradedCount: 2,
          downgradedUserIds: ['u1', 'u2']
        })
      });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/billing/sweep',
        headers: { 'x-test-user': USER_A, 'x-test-role': 'admin' }
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.downgradedCount).toBe(2);
      expect(deps.runTierDowngradeSweep).toHaveBeenCalled();
    });
  });
});
