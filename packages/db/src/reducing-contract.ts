import {
  type FinancialChain, type FinancialMode, type FinancialRecord, type FinancialReceipt, type WithdrawalSqlClient,
  exactRaw, financialHash, financialScale, financialText, financialTime, financialUser, requireFinancial,
  financialFee, financialBudgetKey, combineFinancialBudgets, type FinancialFee, type FinancialBudget
} from './withdrawal-contract.js';

export interface ReducingIntent extends FinancialFee {
  readonly version: 1; readonly kind: 'reducing'; readonly userId: string; readonly requestKey: string;
  readonly chain: FinancialChain; readonly network: string; readonly venue: 'spot' | 'polymarket-perps';
  readonly positionId: string; readonly accountId: string; readonly assetId: string; readonly assetScale: number;
  readonly mode: FinancialMode; readonly positionSide: 'LONG' | 'SHORT'; readonly side: 'SELL' | 'BUY';
  readonly quantityRaw: string; readonly maxFeeRaw: string; readonly limitPriceExact: string;
  readonly expectedRevision: string; readonly expiresAt: string;
}
export type ReducingRequest = Omit<ReducingIntent, 'version' | 'kind' | 'userId' | 'side' | 'expiresAt'>;
export function reducingIntent(userId: string, request: ReducingRequest, expiresAt: string): ReducingIntent {
  financialUser(userId);
  requireFinancial(['solana', 'polygon', 'robinhood-chain'].includes(request.chain), 'invalid-chain');
  requireFinancial(request.venue === 'spot' || request.venue === 'polymarket-perps', 'invalid-reducing-venue');
  requireFinancial(request.mode === 'paper' || request.mode === 'live', 'invalid-mode');
  requireFinancial(request.positionSide === 'LONG' || request.positionSide === 'SHORT', 'invalid-position-side');
  requireFinancial(request.venue !== 'spot' || request.positionSide === 'LONG', 'spot-short-unavailable');
  requireFinancial(request.venue !== 'polymarket-perps' || request.chain === 'polygon', 'perps-chain-mismatch');
  requireFinancial(typeof request.limitPriceExact === 'string' && request.limitPriceExact.length <= 78
    && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(request.limitPriceExact) && /[1-9]/.test(request.limitPriceExact), 'invalid-exact-price');
  return Object.freeze({ version: 1, kind: 'reducing', userId,
    requestKey: financialText(request.requestKey), chain: request.chain, network: financialText(request.network),
    venue: request.venue, positionId: financialText(request.positionId), accountId: financialText(request.accountId),
    assetId: financialText(request.assetId), assetScale: financialScale(request.assetScale), mode: request.mode,
    positionSide: request.positionSide, side: request.positionSide === 'LONG' ? 'SELL' : 'BUY',
    quantityRaw: exactRaw(request.quantityRaw, true), ...financialFee(request), limitPriceExact: request.limitPriceExact,
    expectedRevision: financialText(request.expectedRevision), expiresAt: financialTime(expiresAt) });
}
export interface ReducingVenueMapping {
  readonly mappingId: string; readonly revision: string; readonly userId: string; readonly positionId: string; readonly accountId: string;
  readonly venue: string; readonly chain: string; readonly network: string; readonly mode: string; readonly assetId: string; readonly assetScale: number;
  /** Independent deployed collateral denomination/account, NEVER inferred from public fee labels. */
  readonly collateralAssetId: string; readonly collateralAssetScale: number; readonly collateralAccountId: string;
  readonly observedAt: string; readonly validUntil: string; readonly proof: string;
}
export type ReducingVenueMappingPort = (client: WithdrawalSqlClient, record: FinancialRecord<ReducingIntent>) => Promise<ReducingVenueMapping>;
export function validateReducingVenueMapping(intent: ReducingIntent, mapping: ReducingVenueMapping, now: string, maxAgeMs: number) {
  requireFinancial(mapping.userId === intent.userId && mapping.positionId === intent.positionId && mapping.accountId === intent.accountId
    && mapping.venue === intent.venue && mapping.chain === intent.chain && mapping.network === intent.network && mapping.mode === intent.mode
    && mapping.assetId === intent.assetId && mapping.assetScale === intent.assetScale, 'reducing-venue-mapping-scope-mismatch');
  financialText(mapping.mappingId); financialText(mapping.revision); financialText(mapping.proof);
  financialText(mapping.collateralAssetId); financialScale(mapping.collateralAssetScale); financialText(mapping.collateralAccountId);
  const observed = Date.parse(financialTime(mapping.observedAt)), time = Date.parse(financialTime(now));
  requireFinancial(observed <= time && time - observed <= maxAgeMs && Date.parse(financialTime(mapping.validUntil)) > time,
    'reducing-venue-mapping-stale');
}
export interface ReducingExposure {
  readonly userId: string; readonly positionId: string; readonly accountId: string;
  readonly chain: string; readonly network: string; readonly assetId: string; readonly assetScale: number;
  readonly venue: string; readonly mode: string; readonly positionSide: 'LONG' | 'SHORT';
  readonly heldRaw: string; readonly revision: string; readonly observedAt: string; readonly validUntil: string;
  readonly proof: string;
}
export function reducingBudgets(intent: ReducingIntent): FinancialBudget[] {
  return combineFinancialBudgets([
    { purpose: 'exposure', chain: intent.chain, network: intent.network, mode: intent.mode, accountId: intent.accountId,
      assetId: intent.assetId, assetScale: intent.assetScale, amountRaw: intent.quantityRaw, feeRaw: '0' },
    { purpose: 'funding', chain: intent.chain, network: intent.network, mode: intent.mode, accountId: intent.feeFundingAccountId,
      assetId: intent.feeAssetId, assetScale: intent.feeAssetScale, amountRaw: '0', feeRaw: intent.maxFeeRaw }
  ]);
}
export function reducingBudgetKey(intent: ReducingIntent): string {
  return financialBudgetKey(reducingBudgets(intent).find(b => b.purpose === 'exposure')!);
}
export function rawToDecimal(value: string, scale: number): string {
  financialScale(scale); exactRaw(value);
  const digits = value.padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}
export function decimalToRaw(value: string, scale: number): string {
  financialScale(scale);
  requireFinancial(typeof value === 'string' && value.length <= 128 && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value), 'invalid-position-quantity');
  const [whole, fraction = ''] = value.split('.');
  requireFinancial(fraction.slice(scale).replace(/0/g, '') === '', 'position-scale-loss');
  return exactRaw(BigInt(whole! + fraction.slice(0, scale).padEnd(scale, '0')).toString());
}
/** No Number economics, no absolute-value shortcut that allows a long to become a short. */
export function reducingRemainder(side: 'LONG' | 'SHORT', orderSide: 'BUY' | 'SELL', heldRaw: string, reductionRaw: string): string {
  requireFinancial((side === 'LONG' && orderSide === 'SELL') || (side === 'SHORT' && orderSide === 'BUY'), 'reducing-direction-increases-exposure');
  const held = BigInt(exactRaw(heldRaw)), reduction = BigInt(exactRaw(reductionRaw));
  requireFinancial(reduction <= held, 'reducing-would-cross-zero');
  return (held - reduction).toString();
}
export function validateReducingExposure(intent: ReducingIntent, exposure: ReducingExposure, now: string, maxAgeMs: number,
  enforceRevision: boolean): void {
  requireFinancial(exposure.userId === intent.userId && exposure.positionId === intent.positionId
    && exposure.accountId === intent.accountId && exposure.chain === intent.chain && exposure.network === intent.network
    && exposure.assetId === intent.assetId && exposure.assetScale === intent.assetScale && exposure.venue === intent.venue
    && exposure.mode === intent.mode && exposure.positionSide === intent.positionSide, 'reducing-ownership-or-mode-changed');
  requireFinancial(!enforceRevision || exposure.revision === intent.expectedRevision, 'reducing-stale-revision');
  financialText(exposure.proof);
  const time = Date.parse(now), observed = Date.parse(financialTime(exposure.observedAt));
  requireFinancial(observed <= time && time - observed <= maxAgeMs && Date.parse(financialTime(exposure.validUntil)) > time, 'reducing-exposure-stale');
  requireFinancial(Date.parse(intent.expiresAt) > time, 'reducing-intent-expired');
  reducingRemainder(intent.positionSide, intent.side, exposure.heldRaw, intent.quantityRaw);
}
export interface ReducingAccountingResult {
  readonly accountingReference: string;
  readonly positionId: string;
  readonly positionSide: 'LONG' | 'SHORT';
  readonly beforeRaw: string;
  readonly afterRaw: string;
  /** Perps EVERY fill needs a canonical realized-PnL/collateral/margin journal, even zero fee. */
  readonly economicsReference: string;
}
/** Required canonical join. For spot it MUST account lots/evidence, not just decrement an aggregate position. */
export type ReducingAccountingPort = (client: WithdrawalSqlClient, record: FinancialRecord<ReducingIntent>, receipt: FinancialReceipt,
  deltaRaw: string, deltaFeeRaw: string) => Promise<ReducingAccountingResult>;
export const REDUCING_UNAVAILABLE = Object.freeze({
  state: 'blocked-on-external-capability' as const, supported: false as const,
  sourceImplemented: true, injectedVerified: false, runtimeAccepted: false, liveAccepted: false,
  unavailableReasons: ['durable-schema-runtime-unaccepted', 'authorized-reduce-only-provider-unavailable',
    'independent-receipt-admission-unavailable', 'canonical-spot-settlement-adapter-unavailable']
});
export function reducingReceiptHash(receipt: FinancialReceipt) { return financialHash(receipt); }
