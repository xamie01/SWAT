import type { LpExactAcquisitionRequest, LpExactPosition, LpExactOperation, LpCopyMintRequest, LpAcquisitionResponse, LpOperationResponse } from './domain-transport.js';
import { lpExactAmount, lpMicroUsd } from './domain-transport.js';

export type LpCommand =
  | { kind: 'acquire'; request: LpExactAcquisitionRequest }
  | { kind: 'operation'; positionId: string; action: 'rebalance' | 'close'; request: { operationKey: string } }
  | { kind: 'copy-mint'; request: LpCopyMintRequest };
export interface LpRequestState {
  phase: 'editable' | 'dispatching' | 'unknown' | 'pending' | 'resolved';
  command: LpCommand | null;
  positionId: string | null;
  operationId: string | null;
}
export const emptyLpRequest = (): LpRequestState => ({ phase: 'editable', command: null, positionId: null, operationId: null });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export function validateLpPosition(position: LpExactPosition, userId: string, id?: string): void {
  if (!position || position.userId !== userId || !position.id || (id && position.id !== id) || position.mode !== 'paper'
    || !/^(0|[1-9][0-9]{0,77})$/.test(position.revision) || !['active', 'near_edge', 'out_of_range', 'rebalancing', 'closed'].includes(position.state)) throw new Error('Unverified exact position');
  lpExactAmount(position.deposit); lpExactAmount(position.currentAmount);
  if (position.state === 'closed' && position.currentAmount.raw !== '0') throw new Error('Contradictory closed inventory');
  lpMicroUsd(position.depositMicroUsd); lpMicroUsd(position.cumulativeFeesMicroUsd); lpMicroUsd(position.cumulativeCostsMicroUsd); lpMicroUsd(position.realizedMicroUsd);
}
const keyText = (value: string) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function validateDraft(command: LpCommand): void {
  if (command.kind === 'acquire') {
    const input = command.request, strategy = input.strategy;
    lpExactAmount(input.deposit);
    if (!keyText(input.operationKey) || input.deposit.raw === '0' || !['solana', 'robinhood-chain', 'base', 'ethereum', 'bsc'].includes(input.chain)
      || !input.poolAddress.startsWith(`${input.chain}:`) || !input.depositAsset.startsWith(`${input.chain}:`)
      || !['spot', 'curve', 'bidask'].includes(strategy.distribution) || !Number.isFinite(strategy.rangeLower) || strategy.rangeLower <= 0
      || !Number.isFinite(strategy.rangeUpper) || strategy.rangeUpper <= strategy.rangeLower || !Number.isInteger(strategy.rungCount)
      || strategy.rungCount < 1 || strategy.rungCount > 64) throw new Error('Invalid exact LP draft');
  } else if (command.kind === 'operation') {
    if (!command.positionId || !keyText(command.request.operationKey) || !['close', 'rebalance'].includes(command.action)) throw new Error('Invalid exact operation draft');
  } else if (!command.request.subscriptionId || !keyText(command.request.eventId) || !Number.isInteger(command.request.assetScale)
    || command.request.assetScale < 0 || command.request.assetScale > 30) throw new Error('Invalid exact copy draft');
}
/** Write before dispatch; errors/denials never prove no effect. Reload retries identical JSON/key only. */
export function createLpRequestMachine(userId: string, persist: (state: LpRequestState) => void, initial = emptyLpRequest()) {
  let state = copy(initial);
  if (!['editable', 'dispatching', 'unknown', 'pending', 'resolved'].includes(state.phase)
    || (state.phase !== 'editable' && !state.command) || (state.phase === 'editable' && state.command)) throw new Error('Invalid persisted LP fence');
  if (state.phase === 'dispatching') state.phase = 'unknown';
  function save(next: LpRequestState) { persist(copy(next)); state = next; return copy(state); }
  return {
    state: () => copy(state),
    begin(command: LpCommand) {
      if (state.phase !== 'editable') throw new Error('Unresolved LP request cannot be replaced');
      validateDraft(command);
      return save({ ...emptyLpRequest(), phase: 'dispatching', command: copy(command) });
    },
    retry() {
      if (!state.command || !['unknown', 'pending'].includes(state.phase)) throw new Error('No unresolved LP request');
      save({ ...state, phase: 'dispatching' }); return copy(state.command!);
    },
    unknown() { return save({ ...state, phase: 'unknown' }); },
    observe(response: LpAcquisitionResponse | LpOperationResponse) {
      try {
        const command = state.command;
        if (!command || response.broadcast !== false) throw new Error('Missing exact response binding');
        if (command.kind === 'operation') {
          const operation = (response as LpOperationResponse).operation;
          if (!operation || operation.userId !== userId || operation.positionId !== command.positionId || operation.action !== command.action
            || operation.operationKey !== command.request.operationKey || !operation.id || (state.operationId && state.operationId !== operation.id)
            || !['pending', 'completed'].includes(operation.status)) throw new Error('Unverified immutable LP operation');
          lpExactAmount(operation.amountBefore);
          if (operation.status === 'completed') {
            const receipt = operation.receipt;
            if (!receipt || receipt.userId !== userId || receipt.positionId !== operation.positionId || receipt.action !== operation.action
              || receipt.receiptKey !== operation.receiptKey || receipt.positionRevision !== operation.positionRevision
              || receipt.mode !== 'paper' || receipt.finality !== 'paper-settled'
              || receipt.amountBefore.raw !== operation.amountBefore.raw || receipt.amountBefore.scale !== operation.amountBefore.scale
              || receipt.chain !== operation.quote.pool.chain || receipt.networkId !== operation.quote.pool.networkId
              || receipt.protocol !== operation.quote.pool.protocol || receipt.poolAddress !== operation.quote.pool.poolAddress
              || receipt.depositAsset !== operation.quote.pool.depositAsset || receipt.quoteId !== operation.quote.quoteId
              || receipt.amountAfter.raw !== operation.quote.amountAfter.raw || receipt.amountAfter.scale !== operation.quote.amountAfter.scale
              || (operation.action === 'close' && receipt.amountAfter.raw !== '0')) throw new Error('Unverified LP receipt observation');
            lpExactAmount(receipt.amountAfter); lpMicroUsd(receipt.proceedsMicroUsd); lpMicroUsd(receipt.collectedFeesMicroUsd); lpMicroUsd(receipt.executionCostsMicroUsd);
          } else if (operation.receipt !== null) throw new Error('Contradictory pending operation');
          return save({ ...state, positionId: operation.positionId, operationId: operation.id, phase: operation.status === 'completed' ? 'resolved' : 'pending' });
        }
        const result = response as LpAcquisitionResponse, position = result.position;
        if (result.mode !== 'paper') throw new Error('Not a paper acquisition');
        validateLpPosition(position, userId);
        if (command.kind === 'acquire') {
          const input = command.request;
          if (position.acquisitionKey !== input.operationKey || position.chain !== input.chain || position.poolAddress !== input.poolAddress
            || position.depositAsset !== input.depositAsset || position.deposit.raw !== input.deposit.raw || position.deposit.scale !== input.deposit.scale
            || !position.acquisitionQuote || Object.entries(input.strategy).some(([key, value]) => position.plan.strategy[key as keyof typeof input.strategy] !== value)
            || position.autoRebalance !== (input.autoRebalance ?? false) || position.state !== 'active'
            || position.currentAmount.raw !== position.deposit.raw || position.currentAmount.scale !== position.deposit.scale) throw new Error('Substituted acquisition snapshot');
        } else if (!position.copyOrigin || position.copyOrigin.subscriptionId !== command.request.subscriptionId
          || position.copyOrigin.eventId !== command.request.eventId || position.deposit.scale !== command.request.assetScale) throw new Error('Substituted copy snapshot');
        if (state.positionId && state.positionId !== position.id) throw new Error('Substituted position');
        return save({ ...state, positionId: position.id, phase: 'resolved' });
      } catch (error) { save({ ...state, phase: 'unknown' }); throw error; }
    },
    fresh() {
      if (state.phase !== 'resolved') throw new Error('No verified resolution; retain original payload/key');
      return save(emptyLpRequest());
    }
  };
}
export type LpRequestMachine = ReturnType<typeof createLpRequestMachine>;
