import { beforeEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn(), state: {} as any, failAudit: false, failCommit: false, emptyConsume: false, linked: true }));
vi.mock('./client.js', () => ({ query: db.query, pool: { connect: db.connect } }));
vi.mock('@swat/shared', async () => await import('../../shared/src/billing.js'));
import { recordCryptoPaymentAndGrantTier, getUserBillingStatus, listUserCryptoPayments } from './billing.js';
const scope = { userId: '11111111-1111-4111-8111-111111111111' } as any;
const owner = '0x1111111111111111111111111111111111111111';
const input = { scope, chain: 'polygon' as const, txHash: '0x' + 'A'.repeat(64), amountUsdc: 35, planId: 'operator_monthly' as const, payerAddress: owner, treasuryAddress: '0x' + '3'.repeat(40), memo: '  OWNED  ', now: new Date('2026-11-08T00:00:00Z') };
beforeEach(() => {
  vi.clearAllMocks(); db.failAudit = false; db.failCommit = false; db.emptyConsume = false; db.linked = true;
  db.state = { user: { tier: 'operator', tier_expires_at: new Date('2026-11-20T00:00:00Z') }, intent: { id: 'intent', user_id: scope.userId, reference_memo: 'OWNED', status: 'pending', plan_id: 'operator_monthly', expected_amount_usdc: 35, expires_at: new Date('2099-01-01') }, payments: [], audits: [] };
  db.query.mockImplementation(async (sql: string) => { if (sql.includes('FROM users')) return [db.state.user]; if (sql.includes('FROM crypto_payments')) return db.state.payments; if (sql.includes('audit_log')) { db.state.audits.push('DETACHED'); return []; } throw new Error('Unexpected global query'); });
  db.connect.mockImplementation(async () => {
    let snapshot: any;
    return { on() {}, off() {}, release() {}, query: async (sql: string, p: any[] = []) => {
      if (sql === 'BEGIN') snapshot = structuredClone(db.state);
      if (sql === 'ROLLBACK') db.state = snapshot;
      if (sql === 'COMMIT' && db.failCommit) throw new Error('commit failed');
      if (sql === 'COMMIT') return { rows: [], command: 'COMMIT' };
      if (sql.includes('SELECT') && sql.includes('FROM users')) return { rows: [db.state.user] };
      if (sql.includes('SELECT') && sql.includes('FROM user_auth_wallets')) return { rows: db.linked ? [{ id: 'wallet', address: owner }] : [] };
      if (sql.includes('SELECT') && sql.includes('FROM user_payment_intents')) return { rows: [db.state.intent] };
      if (sql.includes('SELECT') && sql.includes('FROM crypto_payments')) return { rows: db.state.payments.filter((x: any) => x.tx_hash.toLowerCase() === p[1]?.toLowerCase()) };
      if (sql.includes('INSERT INTO crypto_payments')) {
        if (db.state.payments.some((x: any) => x.tx_hash === p[2])) throw Object.assign(new Error('duplicate'), { code: '23505' });
        const row = { id: 'payment', user_id: p[0], chain: p[1], tx_hash: p[2], amount_usdc: p[3], tier: p[4], plan_id: p[5], duration_days: p[6], payer_address: p[7], treasury_address: p[8], memo: p[9], status: 'confirmed', confirmed_at: p[10] }; db.state.payments.push(row); return { rows: [row] };
      }
      if (sql.includes('UPDATE users')) db.state.user = { tier: p[1], tier_expires_at: p[2] };
      if (sql.includes('UPDATE user_payment_intents')) { if (db.emptyConsume) return { rows: [] }; db.state.intent.status = 'completed'; return { rows: [{ id: 'intent' }] }; }
      if (sql.includes('INSERT INTO audit_log')) { if (db.failAudit) throw new Error('audit failed'); db.state.audits.push('atomic'); }
      return { rows: [] };
    } };
  });
});
it.each(['expired', 'completed', 'wrong-owner', 'wrong-plan', 'wrong-price', 'zero-consume', 'unlinked'])('rejects %s without a credit or tier change', async (kind) => {
  if (kind === 'expired') db.state.intent.expires_at = new Date('2000-01-01');
  if (kind === 'completed') db.state.intent.status = 'completed';
  if (kind === 'wrong-owner') db.state.intent.user_id = 'other';
  if (kind === 'wrong-plan') db.state.intent.plan_id = 'lifetime';
  if (kind === 'wrong-price') db.state.intent.expected_amount_usdc = 1999;
  if (kind === 'zero-consume') db.emptyConsume = true;
  if (kind === 'unlinked') db.linked = false;
  await expect(recordCryptoPaymentAndGrantTier(input)).rejects.toThrow();
  expect(await listUserCryptoPayments(scope)).toEqual([]);
  expect((await getUserBillingStatus(scope, input.now)).tierExpiresAt).toEqual(new Date('2026-11-20T00:00:00Z'));
});
it('canonicalizes the hash and memo, consumes once, and extends an existing renewal', async () => {
  const result = await recordCryptoPaymentAndGrantTier(input);
  expect(result.payment.txHash).toBe('0x' + 'a'.repeat(64));
  expect(result.payment.memo).toBe('OWNED');
  expect(result.updatedExpiresAt).toEqual(new Date('2026-12-20T00:00:00Z'));
  await expect(recordCryptoPaymentAndGrantTier({ ...input, txHash: '0x' + 'b'.repeat(64) })).rejects.toThrow();
  expect(await listUserCryptoPayments(scope)).toHaveLength(1);
  expect(db.state.audits).toEqual(['atomic']);
});
it.each(['audit', 'commit'])('rolls back payment, intent, tier and audit on %s failure', async (kind) => {
  db.failAudit = kind === 'audit'; db.failCommit = kind === 'commit';
  await expect(recordCryptoPaymentAndGrantTier(input)).rejects.toThrow();
  expect(await listUserCryptoPayments(scope)).toEqual([]);
  expect(db.state.intent.status).toBe('pending');
  expect(db.state.audits).toEqual([]);
});
it('rejects a historical case-variant payment hash without changing its receipt', async () => {
  db.state.payments = [{ id: 'old', tx_hash: '0x' + 'A'.repeat(64) }];
  await expect(recordCryptoPaymentAndGrantTier({ ...input, txHash: '0x' + 'a'.repeat(64) })).rejects.toThrow();
  expect(await listUserCryptoPayments(scope)).toHaveLength(1);
});

it('retains linked-wallet payments without an intent and preserves lifetime access', async () => {
  db.state.user = { tier: 'ultra', tier_expires_at: null };
  const result = await recordCryptoPaymentAndGrantTier({ ...input, memo: undefined });
  expect(result.updatedTier).toBe('ultra');
  expect(result.updatedExpiresAt).toBeNull();
  expect(db.state.intent.status).toBe('pending');
});
it.each([NaN, Infinity, -1])('rejects invalid payment amount %s before credit', async amountUsdc => {
  await expect(recordCryptoPaymentAndGrantTier({ ...input, amountUsdc })).rejects.toThrow();
  expect(await listUserCryptoPayments(scope)).toEqual([]);
});
