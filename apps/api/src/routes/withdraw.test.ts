import Fastify, { type FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://swat:swat@127.0.0.1:5432/swat_route_tests';
});

import { registerMeRoutes, type StoredWithdrawalOtp } from './me.js';
import * as dbModule from '@swat/db';

const USER_ALICE = '11111111-1111-4111-8111-111111111111';

function buildApp(options: {
  userId?: string;
  email?: string;
  now?: Date;
  coolingOffMs?: number;
  otpStore?: Map<string, StoredWithdrawalOtp>;
  sendWithdrawalOtpEmail?: (email: string, code: string) => Promise<boolean>;
}): FastifyInstance {
  const app = Fastify();

  app.addHook('onRequest', async (req) => {
    if (options.userId) {
      (req as any).principal = {
        kind: 'user',
        user: {
          id: options.userId,
          email: options.email ?? 'alice@example.com',
          role: 'user',
          tier: 'free',
          tierExpiresAt: null
        }
      };
    }
  });

  const fakeQueue = {
    add: vi.fn().mockResolvedValue({ id: 'job-1' })
  } as any;

  registerMeRoutes(app, {
    backfillQueue: fakeQueue,
    tokenDiscoveryQueue: fakeQueue,
    now: options.now ? () => options.now! : undefined,
    coolingOffMs: options.coolingOffMs,
    otpStore: options.otpStore,
    sendWithdrawalOtpEmail: options.sendWithdrawalOtpEmail
  });

  return app;
}

describe('Trading Withdrawal Routes (S4-12)', () => {
  const destinationAddress = '0x1111111111111111111111111111111111111111';
  const now = new Date('2026-10-29T12:00:00Z');

  it('rejects unauthenticated requests with 401', async () => {
    const app = buildApp({ userId: undefined });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/trading/withdraw/request-otp',
      payload: { destinationAddress, chainKind: 'evm' }
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses destination wallet not linked via SIWE/SIWS with 400', async () => {
    vi.spyOn(dbModule, 'listAuthWallets').mockResolvedValue([]);

    const app = buildApp({ userId: USER_ALICE, now });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/trading/withdraw/request-otp',
      payload: { destinationAddress, chainKind: 'evm' }
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('destination-not-linked-auth-wallet');
  });

  it('refuses newly linked wallet within the 24h cooling-off period with 403 (S4-12 anti-theft)', async () => {
    // Linked 2 hours ago
    const linkedTwoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    vi.spyOn(dbModule, 'listAuthWallets').mockResolvedValue([
      {
        id: 'wallet-1',
        userId: USER_ALICE,
        chainKind: 'evm',
        address: destinationAddress,
        verifiedAt: linkedTwoHoursAgo
      }
    ]);

    const app = buildApp({ userId: USER_ALICE, now });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/trading/withdraw/request-otp',
      payload: { destinationAddress, chainKind: 'evm' }
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe('wallet-cooling-off-active');
    expect(body.hoursRemaining).toBe(22);
  });

  it('generates OTP and sends confirmation email when destination wallet passed cooling-off', async () => {
    // Linked 3 days ago (well past 24h)
    const linkedThreeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    vi.spyOn(dbModule, 'listAuthWallets').mockResolvedValue([
      {
        id: 'wallet-1',
        userId: USER_ALICE,
        chainKind: 'evm',
        address: destinationAddress,
        verifiedAt: linkedThreeDaysAgo
      }
    ]);

    const sendEmailMock = vi.fn().mockResolvedValue(true);
    const otpStore = new Map<string, StoredWithdrawalOtp>();

    const app = buildApp({
      userId: USER_ALICE,
      email: 'alice@example.com',
      now,
      otpStore,
      sendWithdrawalOtpEmail: sendEmailMock
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/trading/withdraw/request-otp',
      payload: { destinationAddress, chainKind: 'evm' }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledWith('alice@example.com', expect.stringMatching(/^\d{6}$/));
    expect(otpStore.has(USER_ALICE)).toBe(true);
  });

  it('confirms withdrawal with valid OTP and burns the OTP immediately (single-use)', async () => {
    const linkedThreeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    vi.spyOn(dbModule, 'listAuthWallets').mockResolvedValue([
      {
        id: 'wallet-1',
        userId: USER_ALICE,
        chainKind: 'evm',
        address: destinationAddress,
        verifiedAt: linkedThreeDaysAgo
      }
    ]);

    const otpStore = new Map<string, StoredWithdrawalOtp>([
      [
        USER_ALICE,
        {
          code: '123456',
          expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
          destinationAddress,
          chainKind: 'evm',
          attempts: 0
        }
      ]
    ]);

    const app = buildApp({ userId: USER_ALICE, now, otpStore });

    // Invalid OTP
    const badOtpRes = await app.inject({
      method: 'POST',
      url: '/v1/me/trading/withdraw',
      payload: {
        destinationAddress,
        chainKind: 'evm',
        amountUsd: 500,
        otpCode: '000000'
      }
    });
    expect(badOtpRes.statusCode).toBe(400);
    expect(badOtpRes.json().error).toBe('invalid-or-expired-otp');

    // Valid OTP
    const goodRes = await app.inject({
      method: 'POST',
      url: '/v1/me/trading/withdraw',
      payload: {
        destinationAddress,
        chainKind: 'evm',
        amountUsd: 500,
        otpCode: '123456'
      }
    });
    expect(goodRes.statusCode).toBe(200);
    const body = goodRes.json();
    expect(body.status).toBe('confirmed');
    expect(body.withdrawal.amountUsd).toBe(500);
    expect(body.withdrawal.destinationAddress).toBe(destinationAddress);

    // Replay of the same OTP fails (burnt)
    const replayRes = await app.inject({
      method: 'POST',
      url: '/v1/me/trading/withdraw',
      payload: {
        destinationAddress,
        chainKind: 'evm',
        amountUsd: 500,
        otpCode: '123456'
      }
    });
    expect(replayRes.statusCode).toBe(400);
    expect(replayRes.json().error).toBe('invalid-or-expired-otp');
  });
});
