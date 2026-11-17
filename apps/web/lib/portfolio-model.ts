import { ApiError } from './api.js';
import { describeApiError } from './api-error-message.js';

export type Observation<T> =
  | { state: 'loading'; data: null; error: null }
  | { state: 'unavailable'; data: null; error: string }
  | { state: 'observed'; data: T; error: null };

export const loadingObservation = <T>(): Observation<T> => ({ state: 'loading', data: null, error: null });
export async function observe<T>(read: () => Promise<T>, fallback: string): Promise<Observation<T>> {
  try { return { state: 'observed', data: await read(), error: null }; }
  catch (error) { return { state: 'unavailable', data: null, error: describeApiError(error, fallback) }; }
}

/** Presentation only: missing, blank and nonfinite observations are never zero. */
export function observedNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
export function usd(value: unknown, digits = 2): string {
  const number = observedNumber(value);
  return number === null ? 'Unassessed' : `$${number.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export interface ExecutionCapability { supported: boolean; contractVersion?: number; admissionSupported?: boolean; injectedPortsConfigured?: boolean; state?: string; unavailableReasons?: string[] }
export const unsupportedExecution: ExecutionCapability = { supported: false, state: 'unavailable', unavailableReasons: ['authorized-reducing-execution-unavailable'] };

/** No authorized spot/perps handoff exists. A label or future server flag is not authority. */
export function reducingAction(): never {
  throw new ApiError(503, 'Financial reduction is unavailable. No order was submitted.', { code: 'REDUCING_EXECUTION_UNAVAILABLE' });
}
export async function submitReduction(post: () => Promise<unknown>): Promise<unknown> {
  reducingAction();
  return post();
}

export interface SpotPosition {
  id: string; chain: string; tokenMint: string; tokenSymbol: string | null;
  confirmedQuantityExact?: string; confirmedQuantity: number | null; costBasisUsd: number | null; currentPriceUsd: number | null;
  unrealizedPnlUsd: number | null; unrealizedPnlPct: number | null; masterWalletAddress?: string;
}
export interface SpotPortfolio { positions: SpotPosition[]; positionsAssessment?: string; reducingExecution?: ExecutionCapability; closeAllExecution?: ExecutionCapability }
export function spotTotals(positions: SpotPosition[] | null) {
  if (positions === null) return { value: null, cost: null, pnl: null };
  let value = 0, cost = 0, pnl = 0;
  let valued = true, costed = true, assessedPnl = true;
  for (const position of positions) {
    const quantity = observedNumber(position.confirmedQuantity), price = observedNumber(position.currentPriceUsd);
    const basis = observedNumber(position.costBasisUsd), gain = observedNumber(position.unrealizedPnlUsd);
    if (quantity === null || price === null || price < 0) valued = false;
    else value += quantity * price;
    if (basis === null) costed = false; else cost += basis;
    if (gain === null) assessedPnl = false; else pnl += gain;
  }
  return { value: valued && Number.isFinite(value) ? value : null, cost: costed && Number.isFinite(cost) ? cost : null, pnl: assessedPnl && Number.isFinite(pnl) ? pnl : null };
}
export interface PerpsAccount {
  total_account_value: string | null; available_order_margin: string | null;
  total_maintenance_margin: string | null; in_liquidation: boolean | null;
}
export interface PerpsPosition {
  id: string; symbol: string; side: string; leverage: string | number; size: string;
  entry_price: string | null; liquidation_price: string | null; initial_margin: string | null; unrealized_pnl: string | null;
}
export interface PerpsPortfolio { account: PerpsAccount | null; accountAssessment: string; positions: PerpsPosition[]; reducingExecution: ExecutionCapability }
export function perpsRisk(account: PerpsAccount | null) {
  const equity = observedNumber(account?.total_account_value), maintenance = observedNumber(account?.total_maintenance_margin);
  const available = observedNumber(account?.available_order_margin);
  const ratio = equity !== null && equity > 0 && maintenance !== null && maintenance >= 0 ? maintenance / equity * 100 : null;
  return { equity, maintenance, available, ratio: ratio !== null && Number.isFinite(ratio) ? ratio : null,
    liquidation: typeof account?.in_liquidation === 'boolean' ? account.in_liquidation : null };
}

export function legacyPaperAmount(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ApiError(400, 'Legacy paper contract supports positive safe whole units only; exact fractional/raw LP contract is unavailable.');
  return Number(value);
}

export interface LpPositionView {
  id: string; chain: string; protocol: string; poolAddress: string; strategyType: string;
  rangeLower: number; rangeUpper: number; depositAmount: number; depositAsset?: string;
  depositValueUsd?: number | null; acquisitionMode?: 'paper' | 'live' | 'unknown';
  onChainPositionAddress?: string | null; paperPlan?: unknown;
  state: string; autoRebalance: boolean; rebalanceRecommended?: boolean;
}
export function lpMode(position: LpPositionView): string {
  if (position.acquisitionMode === 'paper') return 'Paper acquisition';
  if (position.acquisitionMode === 'live') return 'Live acquisition — execution unavailable';
  return 'Acquisition mode unknown — execution unavailable';
}
export function lpActionAllowed(_position: LpPositionView, _kind: 'close' | 'rebalance' | 'auto-rebalance'): boolean {
  // This DTO is legacy numeric observation-only, even when it carries historical paper labels.
  // Exact mutation requires a separate current raw/scale read and immutable exact request.
  return false;
}
export async function submitLpAction(position: LpPositionView, kind: 'close' | 'rebalance' | 'auto-rebalance', post: () => Promise<unknown>): Promise<unknown> {
  if (!lpActionAllowed(position, kind)) throw new ApiError(503, 'This LP action is unavailable for this acquisition or state. No request was submitted.');
  return post();
}
export function lpOperationNotice(result: unknown, kind: 'close' | 'rebalance', positionId: string): string {
  const response = result as { broadcast?: unknown; queued?: unknown; operation?: { positionId?: unknown; kind?: unknown; status?: unknown } } | null;
  if (response?.broadcast !== false || response.operation?.positionId !== positionId || response.operation.kind !== kind) {
    return 'Operation outcome unverified. Refresh the recorded position; no financial completion is confirmed.';
  }
  if (response.operation.status === 'completed') return 'Paper operation completed locally. No live liquidity was moved.';
  if (response.operation.status === 'pending') return response.queued === true
    ? 'Paper operation recorded and queued. No live transaction was broadcast.'
    : 'Paper operation recorded; queue delivery is unconfirmed. No live transaction was broadcast.';
  return 'Paper operation is not completed. Refresh the recorded position.';
}
export function lpBuildNotice(result: unknown): string {
  const response = result as { mode?: unknown; positionId?: unknown; rejectionReasons?: unknown } | null;
  return response?.mode === 'paper' && typeof response.positionId === 'string' && response.positionId.length > 0
    && Array.isArray(response.rejectionReasons) && response.rejectionReasons.length === 0
    ? 'Paper ladder recorded locally. No live liquidity was deployed.'
    : 'Build outcome unverified. No live deployment is confirmed; refresh recorded positions.';
}
export interface PolymarketEnrollmentView { enrollmentSupported?: boolean }
// The current backend has no authorized enrollment service. A recorded signer
// or an unexpected response flag cannot enable a signature flow here.
const polymarketEnrollmentImplemented = false;
export function enrollmentAllowed(capability: PolymarketEnrollmentView | null | undefined): boolean {
  return capability?.enrollmentSupported === true && polymarketEnrollmentImplemented;
}
export async function submitPolymarketEnrollment(capability: PolymarketEnrollmentView | null | undefined, enroll: () => Promise<unknown>): Promise<unknown> {
  if (!enrollmentAllowed(capability)) throw new ApiError(503, 'Polymarket enrollment is unavailable. No wallet connection, challenge or signature was requested.');
  return enroll();
}

export function geoNotice(value: boolean | null | undefined): string {
  return value === true ? 'Eligibility recorded — not execution authority' : value === false ? 'Not eligible' : 'Unassessed';
}
