import type { Chain } from '@swat/shared';
import { resolveChainAddress, tradeQueueForChain } from '@swat/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Durable source descriptors are comparison terms, not execution authority.
 * Historical descriptors missing a canonical claim must never be upgraded from
 * current recipients/policy. Reject them and retain the repair obligation. */
export function assertCanonicalFanoutDescriptor(descriptor: Readonly<Record<string, unknown>>, scope: {
  signalId: string; sourceTradeId: string; userId: string | null;
  executionMode: string; targetAccount: string; chain: Chain; jobId: string;
}): string {
  const data = descriptor.data as Record<string, unknown> | undefined;
  const options = descriptor.options as Record<string, unknown> | undefined;
  if (!data || Array.isArray(data) || !options || descriptor.name !== 'signal-trade'
    || descriptor.chain !== scope.chain || descriptor.queue !== tradeQueueForChain(scope.chain)
    || data.chain !== scope.chain || data.signalId !== scope.signalId || data.sourceTradeId !== scope.sourceTradeId
    || !Object.hasOwn(data, 'userId') || data.userId !== scope.userId
    || data.executionMode !== scope.executionMode || data.targetAccount !== scope.targetAccount
    || options.jobId !== scope.jobId || typeof data.copyExecutionId !== 'string' || !UUID.test(data.copyExecutionId)
    || !['buy', 'sell'].includes(String(data.direction))) {
    throw new Error('Canonical fanout descriptor does not match immutable identity');
  }
  for (const field of ['targetAccount', 'tokenMint', 'masterWalletAddress']) {
    if (typeof data[field] !== 'string' || resolveChainAddress(data[field] as string).chain !== scope.chain
      || resolveChainAddress(data[field] as string).prefixed !== data[field]) {
      throw new Error('Canonical fanout descriptor address scope mismatch');
    }
  }
  for (const field of ['requestedBaseQuantity', 'requestedQuoteQuantity']) {
    const value = data[field];
    if (value !== null && (typeof value !== 'string' || value.length > 256 || !DECIMAL.test(value)
      || !/[1-9]/.test(value))) throw new Error('Canonical fanout exact quantity unavailable');
  }
  if (data.requestedBaseQuantity === null && data.requestedQuoteQuantity === null) {
    throw new Error('Canonical fanout exact request unavailable');
  }
  if (!Object.hasOwn(data, 'exitLotId') || (data.exitLotId !== null
    && (typeof data.exitLotId !== 'string' || !UUID.test(data.exitLotId)))) {
    throw new Error('Canonical fanout exit identity unavailable');
  }
  if (Object.hasOwn(data, 'acquisitionExecutionMode') && data.acquisitionExecutionMode !== data.executionMode) {
    throw new Error('Canonical fanout acquisition mode mismatch');
  }
  return data.copyExecutionId;
}
