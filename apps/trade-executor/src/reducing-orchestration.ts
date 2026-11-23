import {
  type WithdrawalIntent, type WithdrawalSqlClient, type WithdrawalTransaction, type FinancialRecord,
  type FinancialAttempt, type FinancialEffectPorts, type FinancialReceipt,
  financialText, financialTime, financialUser, exactRaw, requireFinancial,
  type FinancialAuthorization, validateFinancialAuthorization, validateNoFutureAcceptance
} from '@swat/db/dist/withdrawal-contract.js';
import { withdrawalSqlStore, type WithdrawalSqlStore, type StoredFinancialIntent } from '@swat/db/dist/withdrawal-store.js';
import { reducingBudgets, reducingRemainder, type ReducingIntent, type ReducingAccountingPort } from '@swat/db/dist/reducing-contract.js';
import { withdrawalBudgets } from '@swat/db/dist/withdrawal-service.js';

type Intent = WithdrawalIntent | ReducingIntent;
export interface DurableFinancialRunnerPorts<I extends Intent> {
  transaction: WithdrawalTransaction;
  store?: WithdrawalSqlStore;
  effects: FinancialEffectPorts<I>;
  /** Required same-client authoritative ownership/cooling/exposure/balance/mode revalidation. */
  revalidate(client: WithdrawalSqlClient, record: FinancialRecord<I>, now: string, reserve: boolean): Promise<void>;
  /** Mandatory canonical ledger accounting; called only for authenticated monotonically increasing receipt deltas. */
  account(client: WithdrawalSqlClient, record: FinancialRecord<I>, receipt: FinancialReceipt, deltaRaw: string, deltaFeeRaw: string): Promise<string>;
}
export interface FinancialRunResult<I> {
  readonly kind: 'settled' | 'partial' | 'failed' | 'cancelled' | 'uncertain' | 'waiting';
  readonly record: FinancialRecord<I>;
  readonly submitted: boolean;
}
function desired(intent: Intent): string { return intent.kind === 'withdrawal' ? intent.amountRaw : intent.quantityRaw; }
function budgets(intent: Intent) { return intent.kind === 'withdrawal' ? withdrawalBudgets(intent) : reducingBudgets(intent); }
function validateReceipt(record: FinancialRecord<Intent>, current: FinancialAttempt, receipt: FinancialReceipt): void {
  requireFinancial(receipt.intentId === record.id && receipt.intentHash === record.intentHash && receipt.attemptId === current.id
    && receipt.clientOrderId === current.clientOrderId, 'financial-receipt-scope-mismatch');
  financialText(receipt.receiptId); financialText(receipt.providerIdentity); financialText(receipt.proof); financialTime(receipt.observedAt);
  const filled = BigInt(exactRaw(receipt.cumulativeRaw)), previous = BigInt(exactRaw(current.completedRaw));
  requireFinancial(filled >= previous && filled <= BigInt(desired(record.intent)), 'financial-receipt-overfill-or-regression');
  requireFinancial(BigInt(exactRaw(receipt.feeRaw)) >= BigInt(exactRaw(current.completedFeeRaw))
    && BigInt(receipt.feeRaw) <= BigInt(record.intent.maxFeeRaw), 'financial-receipt-fee-exceeds-intent');
  requireFinancial(receipt.feeAssetId === record.intent.feeAssetId && receipt.feeAssetScale === record.intent.feeAssetScale
    && receipt.feeFundingAccountId === record.intent.feeFundingAccountId, 'financial-receipt-fee-denomination-mismatch');
  requireFinancial(typeof receipt.terminal === 'boolean' && ['fill', 'rejected', 'absent-final'].includes(receipt.outcome), 'financial-receipt-invalid');
  requireFinancial(receipt.outcome === 'fill' || (receipt.terminal && receipt.cumulativeRaw === '0'), 'financial-receipt-invalid-terminal');
  if (receipt.terminal && receipt.cumulativeRaw === '0') validateNoFutureAcceptance(record, current, receipt);
}
function resultKind(record: FinancialRecord<StoredFinancialIntent>): FinancialRunResult<Intent>['kind'] {
  return record.status === 'cancelled' ? 'cancelled' : record.status === 'settled' ? 'settled' : record.status === 'failed' ? 'failed'
    : record.status === 'partial' ? 'partial' : record.status === 'awaiting-authorization' || record.status === 'queued' ? 'waiting' : 'uncertain';
}
/** One durable attempt per exact intent, one write-ahead submit fence; no timer/lease ever authorizes a duplicate effect. */
export function createDurableFinancialRunner<I extends Intent>(ports: DurableFinancialRunnerPorts<I>) {
  const store = ports.store ?? withdrawalSqlStore;
  async function snapshot(userId: string, id: string) {
    return ports.transaction(userId, async client => {
      const record = await store.byId<I>(client, userId, id);
      requireFinancial(record, 'financial-intent-not-found');
      return record;
    });
  }
  async function accept(userId: string, id: string, original: FinancialAttempt, receipt: FinancialReceipt | null) {
    if (!receipt) return snapshot(userId, id);
    return ports.transaction(userId, async client => {
      const record = await store.byId<I>(client, userId, id);
      requireFinancial(record, 'financial-intent-not-found');
      const current = await store.getAttempt(client, record);
      requireFinancial(current && current.id === original.id, 'financial-attempt-fence-mismatch');
      await store.lockBudgets(client, userId, budgets(record.intent));
      // Exact already-applied receipt replay is harmless even if a newer receipt progressed accounting.
      await store.admittedReceipt(client, record, current, receipt);
      requireFinancial(Date.parse(receipt.observedAt) <= Date.parse(await store.now(client)), 'financial-receipt-future-observation');
      if (await store.appliedReceipt(client, record, receipt.receiptId)) return record;
      requireFinancial(!current.terminal, 'financial-terminal-receipt-conflict');
      validateReceipt(record, current, receipt);
      const delta = (BigInt(receipt.cumulativeRaw) - BigInt(current.completedRaw)).toString();
      const deltaFee = (BigInt(receipt.feeRaw) - BigInt(current.completedFeeRaw)).toString();
      let reference = 'zero-fill:' + receipt.receiptId;
      if (delta !== '0' || deltaFee !== '0') {
        // Provider receipts settle actual facts even when authority is now expired/revoked; no new effect is allowed here.
        // Accounting port locks/validates canonical inventory without demanding the original (now legitimately stale) revision.
        reference = await ports.account(client, record, receipt, delta, deltaFee);
        financialText(reference, 'canonical-accounting-reference-unavailable');
      }
      await store.progress(client, record, current, receipt, delta, reference);
      const updated = await store.byId<I>(client, userId, id);
      requireFinancial(updated, 'financial-progress-unavailable'); return updated;
    });
  }
  async function observe(record: FinancialRecord<I>, current: FinancialAttempt) {
    try {
      const observation = await ports.effects.reconcile(record, current);
      return await ports.effects.verify(record, current, observation);
    } catch { return null; }
  }
  return {
    async cancelExpired(userId: string, intentId: string): Promise<FinancialRecord<I>> {
      financialUser(userId); financialText(intentId);
      return ports.transaction(userId, async client => {
        const record = await store.byId<I>(client, userId, intentId);
        requireFinancial(record, 'financial-intent-not-found');
        return store.cancelExpired(client, record, budgets(record.intent));
      });
    },
    async run(userId: string, intentId: string): Promise<FinancialRunResult<I>> {
      financialUser(userId); financialText(intentId);
      const prepared = await ports.transaction(userId, async client => {
        const record = await store.byId<I>(client, userId, intentId);
        requireFinancial(record, 'financial-intent-not-found');
        const existing = await store.getAttempt(client, record);
        if (existing || record.terminal || record.status !== 'queued') return { record, current: existing, fresh: false };
        const now = await store.now(client);
        if (Date.parse(record.intent.expiresAt) <= Date.parse(now)) {
          const cancelled = await store.cancelExpired(client, record, budgets(record.intent));
          return { record: cancelled, current: null, fresh: false };
        }
        await ports.revalidate(client, record, now, false);
        const current = await store.prepare(client, record);
        return { record: { ...record, status: 'prepared' as const }, current, fresh: true };
      });
      if (!prepared.current || prepared.record.terminal) {
        return { kind: resultKind(prepared.record), record: prepared.record, submitted: false };
      }
      // Any existing attempt, including a crash-left PREPARED one, is reconcile-only. No lease expiry may resubmit.
      if (!prepared.fresh) {
        const receipt = await observe(prepared.record, prepared.current);
        const record = await accept(userId, intentId, prepared.current, receipt);
        return { kind: resultKind(record), record, submitted: false };
      }
      let authorization: FinancialAuthorization;
      try { authorization = await ports.effects.authorize(prepared.record, prepared.current); }
      catch { return { kind: 'uncertain', record: await snapshot(userId, intentId), submitted: false }; }
      requireFinancial(authorization !== null && authorization !== undefined, 'financial-execution-authority-unavailable');
      const fenced = await ports.transaction(userId, async client => {
        const record = await store.byId<I>(client, userId, intentId);
        requireFinancial(record, 'financial-intent-not-found');
        const current = await store.getAttempt(client, record);
        requireFinancial(current && current.id === prepared.current!.id, 'financial-attempt-fence-mismatch');
        // Ownership, cooling-off, mode, balance and outstanding reservations are re-read immediately before effect.
        await ports.revalidate(client, record, await store.now(client), false);
        validateFinancialAuthorization(record, current, authorization, await store.now(client));
        return await store.dispatchFence(client, record, current);
      });
      if (!fenced) {
        const record = await snapshot(userId, intentId);
        return { kind: resultKind(record), record, submitted: false };
      }
      let verified: FinancialReceipt | null = null;
      try {
        const observation = await ports.effects.submit(prepared.record, prepared.current, authorization);
        verified = await ports.effects.verify(prepared.record, prepared.current, observation);
      } catch {
        // Timeout, unknown provider result, verifier failure or crash remains durable UNCERTAIN.
      }
      const record = await accept(userId, intentId, prepared.current, verified);
      return { kind: resultKind(record), record, submitted: true };
    }
  };
}
export function reducingAccountingAdapter(account: ReducingAccountingPort) {
  return async (client: WithdrawalSqlClient, record: FinancialRecord<ReducingIntent>, receipt: FinancialReceipt,
    deltaRaw: string, deltaFeeRaw: string): Promise<string> => {
    const applied = await account(client, record, receipt, deltaRaw, deltaFeeRaw);
    requireFinancial(applied.positionId === record.intent.positionId && applied.positionSide === record.intent.positionSide, 'reducing-accounting-scope-mismatch');
    const after = reducingRemainder(applied.positionSide, record.intent.side, applied.beforeRaw, deltaRaw);
    requireFinancial(applied.afterRaw === after, 'reducing-accounting-increases-exposure');
    financialText(applied.economicsReference, 'reducing-economics-journal-unavailable');
    return financialText(applied.accountingReference);
  };
}
