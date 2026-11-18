import { requireCheck } from './core.js';
import { lpExactHash } from '../../../packages/db/src/lp-exact.js';

export const lpQueueName = 'swat-lp-exec-solana';
export const lpJobName = 'lp-paper-operation';
export interface QueueIdentity { runId: string; userId: string; operationId: string }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function queueIdentity(input: QueueIdentity) {
  requireCheck(input && [input.runId,input.userId,input.operationId].every(id => typeof id === 'string' && uuid.test(id)), 'Canonical owned queue identity required');
  return { ...input, prefix:`swat:integration:${input.runId}:wave4-lp-stall`, queue:lpQueueName,
    jobId:`lp-op-${input.operationId}`, acquisitionKey:`bullmq-acquire-${input.runId}`,
    data:{userId:input.userId,operationId:input.operationId,chain:'solana' as const} };
}
export function requireQueueJob(job: any, input: QueueIdentity) {
  const identity = queueIdentity(input);
  requireCheck(job?.id === identity.jobId && job.name === lpJobName && job.data?.userId === input.userId
    && job.data?.operationId === input.operationId && job.data?.chain === 'solana'
    && Object.keys(job.data).sort().join(',') === 'chain,operationId,userId', 'Owned queue job scope mismatch');
  return identity;
}
export interface QueueJournal {
  operationId: string; userId: string; positionId: string; acquisitionKey: string; status: string;
  raw: string; revision: string; receipts: string; fees: string; costs: string; realized: string | null;
  operation: any; position: any; receipt: any; acquisition: any; receiptRow: any;
  legacyState: string; legacy: any; history: any;
}
export function requirePendingJournal(journal:QueueJournal,input:QueueIdentity) {
  requireFinancialIdentity(journal,input);
  requireCheck(journal.status === 'pending' && journal.operation.status === 'pending' && journal.receipts === '0'
    && journal.receipt === null && journal.receiptRow === null && journal.raw === '900719925474099312345'
    && journal.revision === '0' && journal.position.currentAmount.scale === 18 && journal.legacyState === 'active',
    'Queue admission lacks exact pending financial identity');
}
function requireFinancialIdentity(journal:QueueJournal,input:QueueIdentity) {
  const identity = queueIdentity(input), a=journal.acquisition, op=journal.operation;
  const amount={raw:'900719925474099312345',scale:18}, zero={raw:'0',scale:18};
  const same=(x:unknown,y:unknown)=>lpExactHash(x)===lpExactHash(y);
  const fingerprint=lpExactHash({positionId:journal.positionId,action:'close',revision:'0',amountBefore:amount,
    chain:'solana',poolAddress:'solana:wave4-pool',depositAsset:'solana:wave4-mint'});
  const basis=(BigInt(amount.raw)*1234567n/10n**18n).toString();
  const acquisitionFingerprint=lpExactHash({chain:'solana',poolAddress:'solana:wave4-pool',depositAsset:'solana:wave4-mint',
    deposit:amount,strategy:{distribution:'spot',rangeLower:90,rangeUpper:110,rungCount:1},autoRebalance:true,origin:null});
  requireCheck(a && op && a.id === journal.positionId && a.userId === input.userId
    && a.acquisitionKey === identity.acquisitionKey && a.mode === 'paper' && a.chain === 'solana'
    && a.protocol === 'meteora-dlmm' && a.poolAddress === 'solana:wave4-pool' && a.depositAsset === 'solana:wave4-mint'
    && same(a.deposit,amount) && same(a.currentAmount,amount) && a.revision === '0' && a.state === 'active'
    && a.cumulativeFeesMicroUsd === '0' && a.cumulativeCostsMicroUsd === '0' && a.realizedMicroUsd === null
    && a.acquisitionFingerprint === acquisitionFingerprint && a.autoRebalance === true && a.copyOrigin === null
    && a.acquisitionQuote?.version === 1 && a.acquisitionQuote.action === 'acquire' && a.acquisitionQuote.mode === 'paper'
    && a.acquisitionQuote.userId === input.userId && a.acquisitionQuote.providerId === `wave4-${input.runId}`
    && a.acquisitionQuote.intentHash === acquisitionFingerprint && typeof a.acquisitionQuote.quoteId === 'string'
    && a.acquisitionQuote.quoteId.length > 0 && a.acquisitionQuote.pool?.chain === 'solana'
    && a.acquisitionQuote.pool.networkId === `solana:wave4-${input.runId}` && a.acquisitionQuote.pool.protocol === 'meteora-dlmm'
    && a.acquisitionQuote.pool.poolAddress === 'solana:wave4-pool' && a.acquisitionQuote.pool.depositAsset === 'solana:wave4-mint'
    && a.acquisitionQuote.pool.depositScale === 18 && same(a.acquisitionQuote.amountAfter,amount)
    && a.acquisitionQuote.proceedsMicroUsd === '0'
    && a.depositMicroUsd === basis && same(a.acquisitionQuote?.deposit,amount)
    && a.acquisitionQuote.valueMicroUsd === basis && same(a.acquisitionQuote.unitPriceUsd,{raw:'1234567',scale:6})
    && journal.position?.depositMicroUsd === basis && same(journal.position.deposit,amount)
    && same(journal.position.acquisitionQuote,a.acquisitionQuote)
    && journal.operationId === input.operationId && journal.userId === input.userId
    && op.id === input.operationId && op.userId === input.userId && op.positionId === journal.positionId
    && op.operationKey === `bullmq-close-${input.runId}` && op.action === 'close' && op.positionRevision === '0'
    && same(op.amountBefore,amount) && op.fingerprint === fingerprint && op.quote?.intentHash === fingerprint
    && op.quote.userId === input.userId && op.quote.action === 'close' && op.quote.mode === 'paper'
    && op.quote.providerId === `wave4-${input.runId}` && op.quote.pool?.networkId === `solana:wave4-${input.runId}`
    && same(op.quote.deposit,amount) && same(op.quote.amountAfter,zero) && op.quote.proceedsMicroUsd === basis
    && op.quote.valueMicroUsd === basis && same(op.quote.unitPriceUsd,{raw:'1234567',scale:6})
    && op.receiptKey === `lp-receipt-${lpExactHash([input.userId,op.operationKey,fingerprint])}`,
    'Queue journal financial acquisition or close identity mismatch');
}
export function requireCompletedJournal(journal: QueueJournal, input: QueueIdentity) {
  requireFinancialIdentity(journal,input);
  const identity = queueIdentity(input), receipt=journal.receipt, op=journal.operation;
  const same=(x:unknown,y:unknown)=>lpExactHash(x)===lpExactHash(y);
  requireCheck(receipt && receipt.version === 1 && receipt.providerId === `wave4-${input.runId}`
    && receipt.receiptId === `receipt-${input.operationId}` && receipt.mode === 'paper' && receipt.action === 'close'
    && receipt.positionRevision === '0' && receipt.networkId === `solana:wave4-${input.runId}`
    && receipt.chain === 'solana' && receipt.protocol === 'meteora-dlmm'
    && receipt.poolAddress === 'solana:wave4-pool' && receipt.depositAsset === 'solana:wave4-mint'
    && receipt.quoteId === op.quote.quoteId && receipt.quoteHash === lpExactHash(op.quote)
    && same(receipt.amountBefore,op.amountBefore) && same(receipt.amountAfter,{raw:'0',scale:18})
    && receipt.proceedsMicroUsd === journal.acquisition.depositMicroUsd
    && receipt.collectedFeesMicroUsd === '100000' && receipt.executionCostsMicroUsd === '50000'
    && receipt.settledAt === op.quote.observedAt && same(op.receipt,receipt)
    && journal.receiptRow?.receipt_hash === lpExactHash(receipt) && same(journal.receiptRow.data,receipt)
    && journal.receiptRow.operation_id === input.operationId && journal.receiptRow.position_id === journal.positionId
    && journal.receiptRow.user_id === input.userId && journal.receiptRow.receipt_key === op.receiptKey
    && journal.receiptRow.provider_id === receipt.providerId && journal.receiptRow.receipt_id === receipt.receiptId
    && (BigInt(receipt.proceedsMicroUsd)+BigInt(receipt.collectedFeesMicroUsd)-BigInt(receipt.executionCostsMicroUsd)
      -BigInt(journal.acquisition.depositMicroUsd)).toString() === journal.realized
    && journal.position.revision === '1' && journal.position.state === 'closed'
    && journal.position.cumulativeFeesMicroUsd === receipt.collectedFeesMicroUsd
    && journal.position.cumulativeCostsMicroUsd === receipt.executionCostsMicroUsd
    && journal.position.realizedMicroUsd === journal.realized
    && same(journal.position.currentAmount,receipt.amountAfter) && journal.position.lastReceiptKey === receipt.receiptKey
    && Array.isArray(journal.history) && journal.history.length === 3
    && journal.history.map((h:any)=>`${h.from_state ?? 'null'}:${h.to_state}`).join(',') === 'null:building,building:active,active:closed'
    && journal.history.every((h:any)=>h.position_id === journal.positionId)
    && journal.legacy?.id === journal.positionId && journal.legacy.user_id === input.userId && journal.legacy.state === 'closed',
    'Queue completion receipt body, hash, exact economics or history mismatch');
  requireCheck(journal.operationId === input.operationId && journal.userId === input.userId
    && journal.acquisitionKey === identity.acquisitionKey && journal.status === 'completed' && journal.raw === '0'
    && journal.revision === '1' && journal.receipts === '1' && journal.fees === '100000'
    && journal.costs === '50000' && journal.realized === '50000' && journal.legacyState === 'closed'
    && uuid.test(journal.positionId) && journal.operation?.id === input.operationId
    && journal.operation.userId === input.userId && journal.operation.positionId === journal.positionId
    && journal.operation.status === 'completed' && journal.operation.action === 'close'
    && journal.position?.id === journal.positionId && journal.position.userId === input.userId
    && journal.position.acquisitionKey === identity.acquisitionKey
    && journal.receipt?.userId === input.userId && journal.receipt.positionId === journal.positionId
    && journal.receipt.receiptKey === journal.operation.receiptKey && journal.receipt.finality === 'paper-settled',
    'Queue completion lacks exact durable receipt-backed economics');
}
export function requireRedelivery(job: any, state: string, stream: readonly {event:string;jobId:string}[], input: QueueIdentity) {
  const identity = requireQueueJob(job,input);
  const events = stream.filter(event => event.jobId === identity.jobId);
  const lifecycle = events.filter(event => ['active','stalled','completed','failed'].includes(event.event)).map(event=>event.event);
  requireCheck(state === 'completed' && lifecycle.join(',') === 'active,stalled,active,completed'
    && job.attemptsStarted === 2 && job.stalledCounter === 1
    && events.filter(event => event.event === 'active').length === 2
    && events.filter(event => event.event === 'stalled').length === 1
    && events.filter(event => event.event === 'completed').length === 1
    && events.filter(event => event.event === 'failed').length === 0,
    'Retained BullMQ job and Redis event stream do not prove one stall/redelivery/completion');
}
