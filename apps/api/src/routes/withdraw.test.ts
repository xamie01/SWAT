import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerMeRoutes, type StoredWithdrawalOtp } from './me.js';

// The sequential harness blocks all unmocked database/network access.
// A withdrawal refusal must not touch either, including for a legacy valid OTP.
describe('unsupported trading withdrawal routes', () => {
  it.each(['/v1/me/trading/withdraw/request-otp', '/v1/me/trading/withdraw'])(
    'requires authentication and refuses %s without side effects', async url => {
      const app = Fastify({ logger: false });
      app.addHook('onRequest', async request => {
        if (request.headers['x-fixture-auth']) (request as any).principal = { kind: 'user', user: {
          id: '11111111-1111-4111-8111-111111111111', role: 'user', status: 'active', tier: 'free'
        } };
      });
      const otpStore = new Map<string, StoredWithdrawalOtp>();
      const add = vi.fn(); const sendEmail = vi.fn();
      await registerMeRoutes(app, { backfillQueue: { add } as any, tokenDiscoveryQueue: { add } as any,
        otpStore, sendWithdrawalOtpEmail: sendEmail });
      try {
        expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
        const response = await app.inject({ method: 'POST', url, payload: {}, headers: { 'x-fixture-auth': 'yes' } });
        expect(response.statusCode).toBe(501);
        expect(response.json()).toMatchObject({ error: 'withdrawal-unsupported', supported: false });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(otpStore.size).toBe(0);
        expect(sendEmail).not.toHaveBeenCalled();
        expect(add).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }
  );
});
