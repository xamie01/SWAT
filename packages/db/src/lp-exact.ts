import { createHash } from 'node:crypto';
import type { LpChain, LpProtocol, LpPositionState } from '@swat/shared';

/** Public financial DTO: raw is never converted to Number, including at SQL/JSON boundaries. */
export interface LpRawAmount { readonly raw: string; readonly scale: number }
export type LpMicroUsd = string;
export type LpPaperAction = 'acquire' | 'rebalance' | 'close';
export interface LpExactStrategy {
  readonly distribution: 'spot' | 'curve' | 'bidask';
  readonly rangeLower: number;
  readonly rangeUpper: number;
  readonly rungCount: number;
}
export interface LpExactRung {
  readonly priceLower: number;
  readonly priceUpper: number;
  readonly allocation: LpRawAmount;
  readonly binLower?: number;
  readonly binUpper?: number;
  readonly tickLower?: number;
  readonly tickUpper?: number;
}
export interface LpExactPlan {
  readonly version: 2;
  readonly protocol: LpProtocol;
  readonly strategy: LpExactStrategy;
  readonly rungs: readonly LpExactRung[];
  readonly poolEvidenceId: string;
}
export interface LpPoolEvidence {
  readonly chain: LpChain;
  readonly networkId: string;
  readonly protocol: LpProtocol;
  readonly poolAddress: string;
  readonly depositAsset: string;
  readonly depositScale: number;
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly currentPrice: number;
  readonly binStep: number | null;
  readonly tickSpacing: number | null;
}
export interface LpPaperQuote {
  readonly version: 1;
  readonly providerId: string;
  readonly quoteId: string;
  readonly userId: string;
  readonly intentHash: string;
  readonly action: LpPaperAction;
  readonly mode: 'paper';
  readonly pool: LpPoolEvidence;
  readonly deposit: LpRawAmount;
  readonly unitPriceUsd: LpRawAmount;
  readonly valueMicroUsd: LpMicroUsd;
  readonly amountAfter: LpRawAmount;
  readonly proceedsMicroUsd: LpMicroUsd;
  readonly observedAt: string;
  readonly expiresAt: string;
  /** Projection is not realized accounting; a missing input is unknown, not zero. */
  readonly economics: LpEconomicEvidence | null;
}
export interface LpEconomicEvidence {
  readonly basis: 'incremental-rebalance';
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly extraFeesMicroUsd: LpMicroUsd;
  readonly inventoryChangeMicroUsd: string;
  readonly impermanentLossMicroUsd: LpMicroUsd;
  readonly gasMicroUsd: LpMicroUsd;
  readonly repositionMicroUsd: LpMicroUsd;
}
export type LpEconomicDecision =
  | { readonly assessed: false; readonly shouldRebalance: false; readonly netMicroUsd: null; readonly reason: 'economics-unassessed' }
  | { readonly assessed: true; readonly shouldRebalance: boolean; readonly netMicroUsd: string; readonly reason: 'positive' | 'not-positive' };
export interface LpCopyOrigin {
  readonly subscriptionId: string;
  readonly subscriptionRevision: string;
  readonly eventId: string;
  readonly masterWalletAddress: string;
  readonly masterPositionId: string;
  readonly masterEvidenceHash: string;
  readonly masterDepositMicroUsd: LpMicroUsd;
  readonly budgetMicroUsd: LpMicroUsd;
}
export interface LpExactAcquisitionRequest {
  readonly operationKey: string;
  readonly chain: LpChain;
  readonly poolAddress: string;
  readonly depositAsset: string;
  readonly deposit: LpRawAmount;
  readonly strategy: LpExactStrategy;
  readonly autoRebalance?: boolean;
}
export interface LpExactPosition {
  readonly id: string;
  readonly userId: string;
  readonly chain: LpChain;
  readonly protocol: LpProtocol;
  readonly poolAddress: string;
  readonly depositAsset: string;
  readonly acquisitionKey: string;
  readonly acquisitionFingerprint: string;
  readonly mode: 'paper';
  readonly deposit: LpRawAmount;
  readonly depositMicroUsd: LpMicroUsd;
  readonly acquisitionQuote: LpPaperQuote;
  readonly copyOrigin: LpCopyOrigin | null;
  readonly currentAmount: LpRawAmount;
  readonly plan: LpExactPlan;
  readonly revision: string;
  readonly state: LpPositionState;
  readonly autoRebalance: boolean;
  readonly cumulativeFeesMicroUsd: LpMicroUsd;
  readonly cumulativeCostsMicroUsd: LpMicroUsd;
  readonly realizedMicroUsd: string | null;
  readonly lastReceiptKey: string | null;
}
export interface LpExactOperation {
  readonly id: string;
  readonly userId: string;
  readonly positionId: string;
  readonly operationKey: string;
  readonly fingerprint: string;
  readonly action: 'rebalance' | 'close';
  readonly positionRevision: string;
  readonly amountBefore: LpRawAmount;
  readonly quote: LpPaperQuote;
  readonly plan: LpExactPlan | null;
  readonly receiptKey: string;
  readonly status: 'pending' | 'completed';
  readonly receipt: LpPaperReceipt | null;
}
export interface LpPaperReceipt {
  readonly version: 1;
  readonly providerId: string;
  readonly receiptId: string;
  readonly receiptKey: string;
  readonly userId: string;
  readonly positionId: string;
  readonly positionRevision: string;
  readonly mode: 'paper';
  readonly action: 'rebalance' | 'close';
  readonly networkId: string;
  readonly chain: LpChain;
  readonly protocol: LpProtocol;
  readonly poolAddress: string;
  readonly depositAsset: string;
  readonly quoteId: string;
  readonly quoteHash: string;
  readonly amountBefore: LpRawAmount;
  readonly amountAfter: LpRawAmount;
  readonly proceedsMicroUsd: LpMicroUsd;
  readonly collectedFeesMicroUsd: LpMicroUsd;
  readonly executionCostsMicroUsd: LpMicroUsd;
  readonly settledAt: string;
  readonly finality: 'paper-settled';
}
export interface LpExactSubscription {
  readonly id: string;
  readonly userId: string;
  readonly masterWalletAddress: string;
  readonly chain: LpChain;
  readonly venue: LpProtocol;
  readonly budgetMicroUsd: LpMicroUsd;
  readonly capMicroUsd: LpMicroUsd;
  readonly status: 'active' | 'paused' | 'closed';
  readonly createdAt: string;
  readonly revision: string;
}
export interface LpMasterMintEvidence {
  readonly providerId: string;
  readonly eventId: string;
  readonly chain: LpChain;
  readonly networkId: string;
  readonly protocol: LpProtocol;
  readonly masterWalletAddress: string;
  readonly masterPositionId: string;
  readonly poolAddress: string;
  readonly depositAsset: string;
  readonly action: 'mint';
  readonly finality: 'finalized';
  readonly provenance: 'injected-mint-event';
  readonly openedAt: string;
  readonly observedAt: string;
  readonly masterDepositMicroUsd: LpMicroUsd;
  readonly strategy: LpExactStrategy;
}
export interface LpExactCapabilities {
  readonly sourceImplemented: true;
  readonly injectedPortsConfigured: boolean;
  readonly runtimeAccepted: false;
  readonly liveCapabilityAccepted: false;
  readonly fractionalRawscaleDto: true;
  readonly legacyNumericDtoFractionalCapability: false;
  readonly reason: string;
}

export function lpRaw(value: LpRawAmount, positive = false): bigint {
  if (!value || typeof value.raw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value.raw)
      || !Number.isInteger(value.scale) || value.scale < 0 || value.scale > 30) throw new Error('LP canonical rawscale required');
  const raw = BigInt(value.raw);
  if (positive && raw === 0n) throw new Error('LP positive raw amount required');
  return raw;
}
export function lpMicro(value: string, signed = false): bigint {
  if (typeof value !== 'string' || !(signed ? /^(0|-?[1-9][0-9]{0,77})$/ : /^(0|[1-9][0-9]{0,77})$/).test(value)) throw new Error('LP canonical microdollars required');
  return BigInt(value);
}
export function lpDecimal(value: LpRawAmount): string {
  lpRaw(value);
  if (value.scale === 0) return value.raw;
  const padded = value.raw.padStart(value.scale + 1, '0');
  return `${padded.slice(0, -value.scale)}.${padded.slice(-value.scale)}`;
}
/** Stored NUMERIC is parsed from its text, never from the global float64 parser. */
export function lpStoredMicro(text: string): string {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text)) throw new Error('LP stored exact USD unavailable');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) throw new Error('LP stored USD scale exceeds microdollars');
  const raw = (BigInt(whole!) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'))).toString();
  lpMicro(raw);
  return raw;
}
export function lpValueMicro(deposit: LpRawAmount, price: LpRawAmount): string {
  const numerator = lpRaw(deposit, true) * lpRaw(price, true) * 1_000_000n;
  const value = numerator / (10n ** BigInt(deposit.scale + price.scale));
  const text = value.toString(); lpMicro(text);
  if (value <= 0n) throw new Error('LP valuation below one microdollar');
  return text;
}
export function lpAmountForBudget(budgetMicro: string, unitPriceUsd: LpRawAmount, assetScale: number): LpRawAmount {
  const budget = lpMicro(budgetMicro);
  const price = lpRaw(unitPriceUsd, true);
  lpRaw({ raw: '0', scale: assetScale });
  const raw = budget * 10n ** BigInt(assetScale + unitPriceUsd.scale) / (price * 1_000_000n);
  const amount = { raw: raw.toString(), scale: assetScale }; lpRaw(amount, true);
  return amount;
}
export function lpSameAmount(a: LpRawAmount, b: LpRawAmount): boolean {
  lpRaw(a); lpRaw(b); return a.raw === b.raw && a.scale === b.scale;
}
export function lpKey(key: string): void {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error('LP operation key required');
}
export function lpIdentity(chain: LpChain, value: string): void {
  if (typeof value !== 'string' || !value.startsWith(`${chain}:`) || value.length <= chain.length + 1 || value.length > 128) throw new Error('LP chain-prefixed identity required');
}
export function lpProtocol(chain: LpChain, protocol: LpProtocol): void {
  if ((chain === 'solana' && protocol === 'meteora-dlmm')
      || (['robinhood-chain', 'base', 'ethereum', 'bsc'].includes(chain) && protocol === 'uniswap-v3')
      || (chain === 'bsc' && protocol === 'pancakeswap-v3')) return;
  // Raydium pool layout and Uniswap v4 hooks are distinct protocol capabilities, not aliases of v3/DLMM.
  throw new Error('LP protocol capability unavailable');
}
export function lpStrategy(strategy: LpExactStrategy): void {
  if (!strategy || !['spot', 'curve', 'bidask'].includes(strategy.distribution)
      || !Number.isFinite(strategy.rangeLower) || strategy.rangeLower <= 0
      || !Number.isFinite(strategy.rangeUpper) || strategy.rangeUpper <= strategy.rangeLower
      || !Number.isInteger(strategy.rungCount) || strategy.rungCount < 1 || strategy.rungCount > 64) throw new Error('LP valid strategy required');
}
export function lpRecenterStrategy(strategy: LpExactStrategy, currentPrice: number): LpExactStrategy {
  lpStrategy(strategy);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error('LP current geometric price required');
  const factor = currentPrice / Math.sqrt(strategy.rangeLower * strategy.rangeUpper);
  const next = { ...strategy, rangeLower: strategy.rangeLower * factor, rangeUpper: strategy.rangeUpper * factor };
  lpStrategy(next); return next;
}
export function lpTime(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error('LP UTC timestamp required');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error('LP valid UTC timestamp required');
  return time;
}
export function lpFresh(value: string, now: Date, maxAge = 60_000): void {
  const age = now.getTime() - lpTime(value);
  if (!Number.isFinite(age) || age < 0 || age > maxAge) throw new Error('LP fresh evidence unavailable');
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('LP canonical plain JSON required');
}
export function lpExactHash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function lpSnapshot<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
export function lpAcquisitionHash(request: LpExactAcquisitionRequest, origin: LpCopyOrigin | null = null): string {
  return lpExactHash({ chain: request.chain, poolAddress: request.poolAddress, depositAsset: request.depositAsset,
    deposit: request.deposit, strategy: request.strategy, autoRebalance: request.autoRebalance === true, origin });
}
export function lpEconomics(evidence: LpEconomicEvidence | null): LpEconomicDecision {
  if (evidence === null) return { assessed: false, shouldRebalance: false, netMicroUsd: null, reason: 'economics-unassessed' };
  if (!evidence || evidence.basis !== 'incremental-rebalance' || lpTime(evidence.windowEnd) <= lpTime(evidence.windowStart)) throw new Error('LP aligned incremental economics required');
  const fees = lpMicro(evidence.extraFeesMicroUsd);
  const net = fees + lpMicro(evidence.inventoryChangeMicroUsd, true) - lpMicro(evidence.impermanentLossMicroUsd)
    - lpMicro(evidence.gasMicroUsd) - lpMicro(evidence.repositionMicroUsd);
  const text = net.toString(); lpMicro(text, true);
  const positive = net > 0n && fees > 0n;
  return { assessed: true, shouldRebalance: positive, netMicroUsd: text, reason: positive ? 'positive' : 'not-positive' };
}
export function lpAssertPlan(plan: LpExactPlan, amount: LpRawAmount, protocol: LpProtocol, poolEvidenceId: string): void {
  lpRaw(amount, true); lpStrategy(plan?.strategy);
  if (plan.version !== 2 || plan.protocol !== protocol || plan.poolEvidenceId !== poolEvidenceId
      || !Array.isArray(plan.rungs) || plan.rungs.length !== plan.strategy.rungCount) throw new Error('LP asset-bound exact plan required');
  let total = 0n;
  for (const rung of plan.rungs) {
    if (!Number.isFinite(rung.priceLower) || rung.priceLower <= 0 || !Number.isFinite(rung.priceUpper) || rung.priceUpper <= rung.priceLower
        || rung.allocation.scale !== amount.scale) throw new Error('LP invalid exact rung');
    total += lpRaw(rung.allocation, true);
    if (protocol === 'meteora-dlmm') {
      if (!Number.isSafeInteger(rung.binLower) || !Number.isSafeInteger(rung.binUpper) || rung.binUpper! < rung.binLower!
          || rung.tickLower !== undefined || rung.tickUpper !== undefined) throw new Error('LP DLMM bin shape required');
    } else if (!Number.isSafeInteger(rung.tickLower) || !Number.isSafeInteger(rung.tickUpper) || rung.tickUpper! <= rung.tickLower!
        || rung.binLower !== undefined || rung.binUpper !== undefined) throw new Error('LP CLMM tick shape required');
  }
  if (total !== lpRaw(amount)) throw new Error('LP rung raw allocations must conserve deposit');
}
