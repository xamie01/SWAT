import { createReducingService, type ReducingServicePorts } from '@swat/db/dist/reducing-service.js';
import {
  reducingRemainder, type ReducingIntent, type ReducingVenueMapping,
  type ReducingAccountingPort
} from '@swat/db/dist/reducing-contract.js';
import { applyPerpsReducingReceiptWithClient } from '@swat/db/dist/reducing-owned.js';
import { readFinancialAccountingAdmission, assertFinancialIdentity, type FinancialReceiptAdmissionPort } from '@swat/db/dist/withdrawal-owned.js';
import { financialHash, requireFinancial, type WithdrawalTransaction } from '@swat/db/dist/withdrawal-contract.js';
import { createDurableFinancialRunner, reducingAccountingAdapter } from '../../../apps/trade-executor/src/reducing-orchestration.js';
import { createReduceOnlyEffectPorts, type ReduceOnlyProvider } from '../../../apps/trade-executor/src/reducing-provider.js';
import { createOwnedFinancialObserver, assertOwnedFinancialConservation } from './withdrawal-owned-observer.js';
import { assertOwnedFinancialSettler } from './reducing-owned-journal.js';

export interface ReducingOwnedCompositionPorts {
  readonly application: Pick<ReducingServicePorts, 'transaction' | 'lockExposure' | 'lockFunding'>;
  readonly observer: WithdrawalTransaction;
  readonly provider: Omit<ReduceOnlyProvider, 'verifyReceipt' | 'admitReceipt'>;
  readonly receipts: FinancialReceiptAdmissionPort<ReducingIntent>;
  /** Protected selector for an already independently admitted mapping, never a public collateral label. */
  readonly mappingId?: (userId: string, positionId: string) => Promise<string>;
  /** Canonical lot-exit evidence + lot/ledger writer. SQL082 has no immutable execution binding; absent refuses. */
  readonly spotSettler?: ReducingAccountingPort;
}
export const reducingOwnedBoundary = Object.freeze({ sourceImplemented:true,runtimeAccepted:false,externalCapabilityAccepted:false,
  productionReady:false,publicExecution:'refused',package28Acceptance:'unchanged-and-not-inherited' } as const);

export function createReducingOwnedComposition(ports: ReducingOwnedCompositionPorts) {
  requireFinancial(ports?.application && typeof ports.observer === 'function' && ports.observer !== ports.application.transaction
    && ports.provider && ports.receipts && typeof ports.receipts.verify === 'function' && typeof ports.receipts.admit === 'function',
  'reducing-distinct-protected-composition-unavailable');
  const appTransaction: WithdrawalTransaction = (userId,operation) => ports.application.transaction(userId,async client => {
    await assertFinancialIdentity(client,'swat_app');
    return operation(client);
  });
  const observerTransaction: WithdrawalTransaction = (userId,operation) => ports.observer(userId,async client => {
    await assertFinancialIdentity(client,'swat_app');
    return operation(client);
  });
  const service = createReducingService({ ...ports.application, transaction:appTransaction,
    async lockVenueMapping(client,record) {
      requireFinancial(ports.mappingId, 'reducing-independent-collateral-mapping-unavailable');
      const id = await ports.mappingId(record.userId,record.intent.positionId);
      const rows = (await client.query<{ mapping: ReducingVenueMapping; mapping_hash: string }>(`SELECT mapping,mapping_hash
        FROM public.reducing_perps_venue_mappings WHERE user_id=$1 AND position_id=$2 AND mapping_id=$3
          AND admitted_at<=statement_timestamp() /* reducing-owned:mapping */`, [record.userId,record.intent.positionId,id])).rows;
      const row = rows[0];
      requireFinancial(rows.length === 1 && row && row.mapping.mappingId === id && financialHash(row.mapping) === row.mapping_hash,
        'reducing-independent-collateral-mapping-unavailable');
      // Canonical service validates the entire scope/freshness again at DB-clock dispatch fence.
      return row.mapping;
    }
  });
  const observe = createOwnedFinancialObserver<ReducingIntent>(observerTransaction);
  const verified = new WeakMap<object, {
    record: Parameters<FinancialReceiptAdmissionPort<ReducingIntent>['verify']>[0];
    attempt: Parameters<FinancialReceiptAdmissionPort<ReducingIntent>['verify']>[1]
  }>();
  // Do not use provider labels as admission authority, and do not expose independent writer to application methods.
  const originalVerify = ports.receipts.verify;
  const joinedEffects = createReduceOnlyEffectPorts({ ...ports.provider,
    async verifyReceipt(record,attempt,observation) {
      const receipt = await originalVerify(record,attempt,observation);
      if (receipt) verified.set(receipt,{record,attempt});
      return receipt;
    },
    async admitReceipt(receipt) {
      const binding = verified.get(receipt);
      requireFinancial(binding, 'reducing-independent-receipt-verification-unavailable');
      await ports.receipts.admit(binding.record,binding.attempt,receipt);
    }
  });
  const account = reducingAccountingAdapter(async (client,record,receipt,deltaRaw,deltaFeeRaw) => {
    if (record.intent.venue === 'polymarket-perps') {
      await assertOwnedFinancialSettler(client);
      return applyPerpsReducingReceiptWithClient(client,record,receipt,deltaRaw,deltaFeeRaw);
    }
    requireFinancial(ports.spotSettler, 'reducing-canonical-spot-lot-execution-binding-unavailable');
    const reference = await readFinancialAccountingAdmission(client,record,receipt,deltaRaw,deltaFeeRaw);
    const settled = await ports.spotSettler(client,record,receipt,deltaRaw,deltaFeeRaw);
    requireFinancial(settled.accountingReference === reference, 'reducing-canonical-spot-accounting-binding-mismatch');
    return settled;
  });
  const runner = createDurableFinancialRunner<ReducingIntent>({ transaction:appTransaction,
    revalidate:service.revalidate,effects:joinedEffects,account });
  return Object.freeze({ boundary:reducingOwnedBoundary,
    application:Object.freeze({request:service.request,status:service.status}),
    async process(userId: string, intentId: string) {
      await runner.run(userId,intentId);
      const journal = await observe(userId,intentId);
      assertOwnedFinancialConservation(journal);
      return {record:journal.record,boundary:reducingOwnedBoundary};
    },
    observe, cancelExpired:runner.cancelExpired
  });
}

/** Independent economic arithmetic is an observer check, never a settlement writer or approval. */
export function assertReducingEconomicConservation(input: {
  readonly side: 'LONG' | 'SHORT'; readonly beforeRaw: string; readonly deltaRaw: string; readonly afterRaw: string;
  readonly collateralBeforeRaw: string; readonly realizedPnlRaw: string; readonly collateralAfterRaw: string;
  readonly marginBeforeRaw: string; readonly marginAfterRaw: string;
}) {
  requireFinancial(input.afterRaw === reducingRemainder(input.side,input.side === 'LONG' ? 'SELL' : 'BUY',input.beforeRaw,input.deltaRaw),
    'reducing-observer-exposure-not-conserved');
  requireFinancial(/^-?(0|[1-9][0-9]*)$/.test(input.realizedPnlRaw)
    && [input.collateralBeforeRaw,input.collateralAfterRaw,input.marginBeforeRaw,input.marginAfterRaw]
      .every(raw => /^(0|[1-9][0-9]*)$/.test(raw)), 'reducing-observer-invalid-economics');
  requireFinancial(BigInt(input.collateralAfterRaw) === BigInt(input.collateralBeforeRaw) + BigInt(input.realizedPnlRaw)
    && BigInt(input.marginAfterRaw) <= BigInt(input.marginBeforeRaw), 'reducing-observer-collateral-margin-not-conserved');
}
