import {
  financialHash, financialText, financialUser, requireFinancial,
  type FinancialRecord, type WithdrawalSqlClient, type WithdrawalTransaction,
  type FinancialFundingPort, financialBudgetKey, validateFinancialFunding
} from './withdrawal-contract.js';
import { withdrawalSqlStore, type WithdrawalSqlStore } from './withdrawal-store.js';
import {
  reducingBudgets, reducingIntent, validateReducingExposure, REDUCING_UNAVAILABLE,
  type ReducingExposure, type ReducingIntent, type ReducingRequest,
  type ReducingVenueMappingPort, validateReducingVenueMapping
} from './reducing-contract.js';

export interface ReducingServicePorts {
  transaction: WithdrawalTransaction;
  /** Locks authoritative inventory+current trusted venue exposure/settings on same client; no body snapshot authority. */
  lockExposure(client: WithdrawalSqlClient, intent: ReducingIntent): Promise<ReducingExposure>;
  lockFunding: FinancialFundingPort;
  /** Perps-only required independent deployed mapping; missing mapping refuses admission/effect, never caller collateral. */
  lockVenueMapping?: ReducingVenueMappingPort;
  store?: WithdrawalSqlStore;
  intentTtlMs?: number;
  exposureMaxAgeMs?: number;
}
export function createReducingService(ports: ReducingServicePorts) {
  const store = ports.store ?? withdrawalSqlStore;
  const ttl = ports.intentTtlMs ?? 300_000, maxAge = ports.exposureMaxAgeMs ?? 30_000;
  requireFinancial(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 900_000
    && Number.isSafeInteger(maxAge) && maxAge > 0 && maxAge <= 60_000, 'reducing-expiry-policy-invalid');
  async function revalidate(client: WithdrawalSqlClient, record: FinancialRecord<ReducingIntent>, now: string, reserve: boolean) {
    const budgets = reducingBudgets(record.intent);
    await store.lockBudgets(client, record.userId, budgets);
    const exposure = await ports.lockExposure(client, record.intent);
    const feeBudget = budgets.find(b => b.purpose === 'funding')!;
    const funding = await ports.lockFunding(client, record.userId, feeBudget);
    let mapping = null;
    if (record.intent.venue === 'polymarket-perps') {
      requireFinancial(ports.lockVenueMapping, 'reducing-independent-collateral-mapping-unavailable');
      mapping = await ports.lockVenueMapping(client, record);
    }
    now = await store.now(client);
    if (mapping) {
      validateReducingVenueMapping(record.intent, mapping, now, maxAge);
      // Independent restricted writer must persist immutable mapping before runtime can use it; labels alone never grant authority.
      const admitted = await client.query<{ mapping_id: string }>(`SELECT mapping_id FROM public.reducing_perps_venue_mappings
        WHERE position_id=$1 AND user_id=$2 AND mapping_id=$3 AND mapping_hash=$4
        /* reducing:venue-mapping */`, [record.intent.positionId, record.userId, mapping.mappingId, financialHash(mapping)]);
      requireFinancial(admitted.rows[0], 'reducing-independent-collateral-mapping-unavailable');
    }
    validateReducingExposure(record.intent, exposure, now, maxAge, true);
    validateFinancialFunding(record.userId, feeBudget, funding, now, maxAge);
    for (const budget of budgets) {
      const reserved = await store.reserved(client, record.userId, financialBudgetKey(budget), record.id);
      const available = budget.purpose === 'exposure' ? exposure.heldRaw : funding.availableRaw;
      requireFinancial(BigInt(available) >= BigInt(reserved) + BigInt(budget.amountRaw) + BigInt(budget.feeRaw), 'reducing-exposure-or-fee-reserved');
      if (reserve) await store.reserve(client, record, budget);
    }
  }
  return {
    capability: REDUCING_UNAVAILABLE,
    async request(userId: string, request: ReducingRequest): Promise<FinancialRecord<ReducingIntent>> {
      financialUser(userId);
      return ports.transaction(userId, async client => {
        const now = await store.now(client);
        const intent = reducingIntent(userId, request, new Date(Date.parse(now) + ttl).toISOString());
        await store.lockRequest(client, userId, 'reducing', intent.requestKey);
        const existing = await store.byKey<ReducingIntent>(client, userId, 'reducing', intent.requestKey);
        if (existing) {
          requireFinancial(financialHash(reducingIntent(userId, request, existing.intent.expiresAt)) === existing.intentHash, 'reducing-request-key-conflict');
          return existing;
        }
        const record = await store.create(client, intent);
        await revalidate(client, record, now, true);
        await store.queue(client, record);
        return { ...record, status: 'queued' };
      });
    },
    async status(userId: string, intentId: string): Promise<FinancialRecord<ReducingIntent> | null> {
      financialUser(userId); financialText(intentId);
      return ports.transaction(userId, async client => {
        const record = await store.byId<ReducingIntent>(client, userId, intentId);
        return record?.intent.kind === 'reducing' ? record : null;
      });
    },
    revalidate
  };
}
export type ReducingService = ReturnType<typeof createReducingService>;
