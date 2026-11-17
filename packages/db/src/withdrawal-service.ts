import {
  financialHash, financialText, financialTime, financialUser, exactRaw, requireFinancial, sameDigest,
  withdrawalIntent, WithdrawalProtocolError, WITHDRAWAL_UNAVAILABLE,
  type WithdrawalIntent, type WithdrawalRequest, type FinancialRecord, type WithdrawalSqlClient,
  type WithdrawalTransaction, type FinancialBudget, type FinancialFundingPort,
  financialBudgetKey, combineFinancialBudgets, validateFinancialFunding
} from './withdrawal-contract.js';
import { withdrawalSqlStore, type WithdrawalSqlStore } from './withdrawal-store.js';

export interface WithdrawalEligibility {
  readonly userId: string; readonly chain: string; readonly network: string; readonly mode: string;
  readonly assetId: string; readonly assetScale: number; readonly sourceWalletId: string;
  readonly destination: string; readonly destinationVerifiedAt: string;
  readonly availableRaw: string; readonly observedAt: string; readonly validUntil: string;
  readonly custodyRevision: string; readonly balanceProof: string;
}
export interface WithdrawalOtpPorts {
  /** CSPRNG code and keyed digest scoped to exact intentHash. No secret persisted in this domain. */
  issue(intentHash: string): Promise<{ code: string; digest: string }>;
  digest(intentHash: string, code: string): Promise<string>;
  /** Principal destination email must be resolved server-side. Never receive a public email/address here. */
  deliver(userId: string, code: string, intent: WithdrawalIntent): Promise<boolean>;
}
export interface WithdrawalServicePorts {
  transaction: WithdrawalTransaction;
  /** Under budget lock, lock actual custody ownership/settings/balance rows on this same client. Cached user_balances alone is NOT authority. */
  lockEligibility(client: WithdrawalSqlClient, intent: WithdrawalIntent): Promise<WithdrawalEligibility>;
  /** Required fee denomination/account authority, including zero fee ceilings. */
  lockFunding: FinancialFundingPort;
  otp: WithdrawalOtpPorts;
  store?: WithdrawalSqlStore;
  /** Server policy, not body fields. Bounds prevent a disabled cooling-off gate. */
  coolingOffMs?: number;
  intentTtlMs?: number;
  authorizationTtlMs?: number;
  balanceMaxAgeMs?: number;
}
export interface WithdrawalAuthorizationProjection {
  readonly intent: FinancialRecord<WithdrawalIntent>;
  readonly authorizationId: string;
  readonly authorizationExpiresAt: string;
  readonly delivery: 'sent' | 'failed' | 'unknown';
  readonly replay: boolean;
}
export interface SubmitWithdrawal {
  readonly intentId: string; readonly authorizationId: string; readonly otp: string;
}
export function withdrawalBudgets(intent: WithdrawalIntent): FinancialBudget[] {
  return combineFinancialBudgets([
    { purpose: 'funding', chain: intent.chain, network: intent.network, mode: intent.mode, accountId: intent.sourceWalletId,
      assetId: intent.assetId, assetScale: intent.assetScale, amountRaw: intent.amountRaw, feeRaw: '0' },
    { purpose: 'funding', chain: intent.chain, network: intent.network, mode: intent.mode, accountId: intent.feeFundingAccountId,
      assetId: intent.feeAssetId, assetScale: intent.feeAssetScale, amountRaw: '0', feeRaw: intent.maxFeeRaw }
  ]);
}
export function withdrawalBudgetKey(intent: WithdrawalIntent): string {
  return financialBudgetKey(withdrawalBudgets(intent).find(b => b.amountRaw !== '0')!);
}
/** Retained helper only returns the source-asset budget; never add an unrelated fee denomination. */
export function withdrawalReservedRaw(intent: WithdrawalIntent): string {
  const budget = withdrawalBudgets(intent).find(b => b.amountRaw !== '0')!;
  return (BigInt(budget.amountRaw) + BigInt(budget.feeRaw)).toString();
}
export function validateWithdrawalEligibility(intent: WithdrawalIntent, evidence: WithdrawalEligibility, now: string,
  coolingOffMs: number, maxAgeMs: number): void {
  requireFinancial(evidence.userId === intent.userId && evidence.chain === intent.chain && evidence.network === intent.network
    && evidence.mode === intent.mode && evidence.assetId === intent.assetId && evidence.assetScale === intent.assetScale
    && evidence.sourceWalletId === intent.sourceWalletId && evidence.destination === intent.destination, 'withdrawal-ownership-or-mode-changed');
  financialText(evidence.custodyRevision); financialText(evidence.balanceProof);
  const time = Date.parse(now), verified = Date.parse(financialTime(evidence.destinationVerifiedAt));
  requireFinancial(time - verified >= coolingOffMs, 'withdrawal-cooling-off');
  const observed = Date.parse(financialTime(evidence.observedAt)), validUntil = Date.parse(financialTime(evidence.validUntil));
  requireFinancial(observed <= time && time - observed <= maxAgeMs && validUntil > time, 'withdrawal-balance-stale');
  exactRaw(evidence.availableRaw);
  requireFinancial(Date.parse(intent.expiresAt) > time, 'withdrawal-intent-expired');
}
/** Public methods take a principal-derived userId; no submit request can substitute immutable intent fields. */
export function createWithdrawalService(ports: WithdrawalServicePorts) {
  const store = ports.store ?? withdrawalSqlStore;
  const coolingOffMs = ports.coolingOffMs ?? 86_400_000;
  const ttl = ports.intentTtlMs ?? 600_000;
  const otpTtl = ports.authorizationTtlMs ?? 300_000;
  const maxAge = ports.balanceMaxAgeMs ?? 30_000;
  requireFinancial(Number.isSafeInteger(coolingOffMs) && coolingOffMs >= 86_400_000, 'withdrawal-cooling-policy-invalid');
  requireFinancial(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 900_000
    && Number.isSafeInteger(otpTtl) && otpTtl > 0 && otpTtl <= ttl
    && Number.isSafeInteger(maxAge) && maxAge > 0 && maxAge <= 60_000, 'withdrawal-expiry-policy-invalid');
  async function eligible(client: WithdrawalSqlClient, record: FinancialRecord<WithdrawalIntent>, now: string, reserve: boolean) {
    const budgets = withdrawalBudgets(record.intent);
    await store.lockBudgets(client, record.userId, budgets);
    const proof = await ports.lockEligibility(client, record.intent);
    const funding = [];
    for (const budget of budgets) funding.push(await ports.lockFunding(client, record.userId, budget));
    now = await store.now(client);
    validateWithdrawalEligibility(record.intent, proof, now, coolingOffMs, maxAge);
    for (let i = 0; i < budgets.length; i++) {
      const budget = budgets[i]!, evidence = funding[i]!;
      validateFinancialFunding(record.userId, budget, evidence, now, maxAge);
      if (budget.amountRaw !== '0') requireFinancial(evidence.availableRaw === proof.availableRaw, 'withdrawal-balance-authority-inconsistent');
      const reserved = await store.reserved(client, record.userId, financialBudgetKey(budget), record.id);
      requireFinancial(BigInt(evidence.availableRaw) >= BigInt(reserved) + BigInt(budget.amountRaw) + BigInt(budget.feeRaw), 'withdrawal-balance-insufficient');
      if (reserve) await store.reserve(client, record, budget);
    }
  }
  return {
    capability: WITHDRAWAL_UNAVAILABLE,
    async requestOtp(userId: string, request: WithdrawalRequest): Promise<WithdrawalAuthorizationProjection> {
      financialUser(userId);
      const result = await ports.transaction(userId, async client => {
        const now = await store.now(client);
        const intent = withdrawalIntent(userId, request, new Date(Date.parse(now) + ttl).toISOString());
        await store.lockRequest(client, userId, intent.kind, intent.requestKey);
        const existing = await store.byKey<WithdrawalIntent>(client, userId, intent.kind, intent.requestKey);
        if (existing) {
          const repeated = withdrawalIntent(userId, request, existing.intent.expiresAt);
          requireFinancial(financialHash(repeated) === existing.intentHash, 'withdrawal-request-key-conflict');
          const auth = await store.authorization(client, existing);
          requireFinancial(auth, 'withdrawal-authorization-unavailable');
          return { record: existing, authId: auth.id, expires: new Date(auth.expires_at).toISOString(),
            delivery: auth.delivery_state === 'sent' ? 'sent' as const : auth.delivery_state === 'failed' ? 'failed' as const : 'unknown' as const,
            code: null, replay: true };
        }
        const record = await store.create(client, intent);
        await eligible(client, record, now, false);
        const issued = await ports.otp.issue(record.intentHash);
        requireFinancial(/^[0-9]{6,10}$/.test(issued.code) && /^[a-f0-9]{64}$/.test(issued.digest), 'withdrawal-otp-service-invalid');
        const expires = new Date(Date.parse(now) + otpTtl).toISOString();
        const inserted = await client.query<{ id: string }>(`INSERT INTO public.withdrawal_authorizations
          (user_id,intent_id,intent_hash,digest,expires_at) VALUES($1,$2,$3,$4,$5)
          RETURNING id /* withdrawal:issue */`, [userId, record.id, record.intentHash, issued.digest, expires]);
        requireFinancial(inserted.rows[0], 'withdrawal-authorization-persistence-unavailable');
        return { record, authId: inserted.rows[0].id, expires, code: issued.code, delivery: 'unknown' as const, replay: false };
      });
      // No code leaves before COMMIT. Never reissue/resend a pending code on retry.
      let delivery: WithdrawalAuthorizationProjection['delivery'] = result.delivery;
      if (result.code !== null) {
        try { delivery = await ports.otp.deliver(userId, result.code, result.record.intent) ? 'sent' : 'failed'; }
        catch { delivery = 'unknown'; }
        if (delivery !== 'unknown') {
          try {
            await ports.transaction(userId, async client => {
              await client.query(`UPDATE public.withdrawal_authorizations SET delivery_state=$3
                WHERE user_id=$1 AND id=$2 AND delivery_state='pending' AND consumed_at IS NULL
                /* withdrawal:delivery */`, [userId, result.authId, delivery]);
            });
          } catch { delivery = 'unknown'; }
        }
      }
      return { intent: result.record, authorizationId: result.authId, authorizationExpiresAt: result.expires, delivery, replay: result.replay };
    },
    async submit(userId: string, input: SubmitWithdrawal): Promise<FinancialRecord<WithdrawalIntent>> {
      financialUser(userId); financialText(input.intentId); financialText(input.authorizationId);
      requireFinancial(typeof input.otp === 'string' && /^[0-9]{6,10}$/.test(input.otp), 'withdrawal-otp-invalid');
      const result = await ports.transaction(userId, async client => {
        const record = await store.byId<WithdrawalIntent>(client, userId, input.intentId);
        requireFinancial(record?.intent.kind === 'withdrawal', 'withdrawal-intent-not-found');
        const auth = await store.authorization(client, record);
        requireFinancial(auth && auth.id === input.authorizationId, 'withdrawal-authorization-mismatch');
        const digest = await ports.otp.digest(record.intentHash, input.otp);
        if (auth.consumed_at) {
          requireFinancial(sameDigest(auth.digest, digest), 'withdrawal-otp-invalid');
          requireFinancial(record.status !== 'awaiting-authorization', 'withdrawal-consumption-inconsistent');
          return { record, error: null };
        }
        const now = await store.now(client);
        requireFinancial(auth.delivery_state === 'sent', 'withdrawal-otp-delivery-unconfirmed');
        requireFinancial(Date.parse(auth.expires_at.toString()) > Date.parse(now) && Date.parse(record.intent.expiresAt) > Date.parse(now), 'withdrawal-authorization-expired');
        requireFinancial(auth.failures < 5, 'withdrawal-otp-locked');
        if (!sameDigest(auth.digest, digest)) {
          await client.query(`UPDATE public.withdrawal_authorizations SET failures=failures+1
            WHERE user_id=$1 AND id=$2 AND consumed_at IS NULL /* withdrawal:failure */`, [userId, auth.id]);
          // Returning an error marker lets the failed-attempt increment COMMIT.
          return { record, error: 'withdrawal-otp-invalid' };
        }
        await eligible(client, record, now, true);
        const consumed = await client.query<{ id: string }>(`UPDATE public.withdrawal_authorizations
          SET consumed_at=statement_timestamp() WHERE user_id=$1 AND id=$2 AND intent_id=$3 AND intent_hash=$4
          AND digest=$5 AND consumed_at IS NULL AND failures<5 AND delivery_state='sent'
          AND expires_at>statement_timestamp() RETURNING id /* withdrawal:consume */`,
        [userId, auth.id, record.id, record.intentHash, digest]);
        requireFinancial(consumed.rows[0], 'withdrawal-authorization-consume-conflict');
        await store.queue(client, record);
        return { record: { ...record, status: 'queued' as const }, error: null };
      });
      if (result.error) throw new WithdrawalProtocolError(result.error);
      return result.record;
    },
    async status(userId: string, intentId: string): Promise<FinancialRecord<WithdrawalIntent> | null> {
      financialUser(userId); financialText(intentId);
      return ports.transaction(userId, async client => {
        const record = await store.byId<WithdrawalIntent>(client, userId, intentId);
        return record?.intent.kind === 'withdrawal' ? record : null;
      });
    },
    /** Effect runner calls twice: before attempt persistence and immediately before durable submit fence. */
    revalidate: eligible
  };
}
export type WithdrawalService = ReturnType<typeof createWithdrawalService>;
