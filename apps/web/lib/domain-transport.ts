import { api, lpApi, ApiError } from './api.js';
import type { LpExactAcquisitionRequest, LpExactCapabilities, LpExactPosition, LpExactOperation, LpRawAmount, LpEconomicDecision } from '../../../packages/db/dist/lp-exact.js';
export type { LpExactAcquisitionRequest, LpExactCapabilities, LpExactPosition, LpExactOperation } from '../../../packages/db/dist/lp-exact.js';

export interface DomainCapability {
  contractVersion?: number; admissionSupported?: boolean; localEnrollmentSupported?: boolean;
  sourceImplemented?: boolean; injectedPortsConfigured?: boolean; injectedVerified?: boolean;
  runtimeAccepted?: boolean; liveAccepted?: boolean; supported?: boolean; state?: string;
}
export interface WithdrawalRequest {
  requestKey: string; chain: 'solana' | 'polygon' | 'robinhood-chain'; network: string; assetId: string;
  assetScale: number; sourceWalletId: string; destination: string; amountRaw: string; maxFeeRaw: string; mode: 'paper' | 'live';
  feeAssetId: string; feeAssetScale: number; feeFundingAccountId: string;
}
export interface ReductionRequest extends Omit<WithdrawalRequest, 'sourceWalletId' | 'destination' | 'amountRaw'> {
  accountId: string; positionSide: 'LONG' | 'SHORT'; quantityRaw: string; limitPriceExact: string; expectedRevision: string;
}
export interface FinancialRecordView {
  id: string; intentHash: string; intent: { kind: string; requestKey: string; mode: string; amountRaw?: string;
    quantityRaw?: string; maxFeeRaw: string; feeAssetId: string; feeAssetScale: number; feeFundingAccountId: string;
    assetScale: number; network: string; [key: string]: unknown };
  status: 'awaiting-authorization' | 'queued' | 'prepared' | 'uncertain' | 'partial' | 'settled' | 'failed' | 'cancelled';
  completedRaw: string; terminal: boolean; cancellationReason?: string | null;
}
export interface FinancialResponse { record: FinancialRecordView; capability: DomainCapability }
export interface WithdrawalAuthorization extends FinancialResponse {
  authorizationId: string; authorizationExpiresAt: string; delivery: 'sent' | 'failed' | 'unknown'; replay: boolean;
}
export function admissionAllowed(capability: DomainCapability | null | undefined): boolean {
  // UI observation only; server independently revalidates each immutable intent.
  return capability?.contractVersion === 1 && capability.admissionSupported === true && capability.injectedPortsConfigured === true;
}
export function rawAmount(value: string, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 36 || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78) {
    throw new ApiError(400, 'Invalid exact units');
  }
  const digits = value.padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
}
export function decimalAmountRaw(value: string, scale: number): string {
  if (!Number.isInteger(scale) || scale < 0 || scale > 36 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)) throw new ApiError(400, 'Invalid exact amount');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new ApiError(400, 'Amount exceeds asset precision');
  const raw = BigInt(whole! + fraction.padEnd(scale, '0')).toString();
  rawAmount(raw, scale); return raw;
}
export function financialNotice(result: unknown): string {
  const record = (result as Partial<FinancialResponse> | null)?.record;
  if (!record || typeof record.id !== 'string' || typeof record.completedRaw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(record.completedRaw)) return 'Outcome unverified. No financial completion is confirmed.';
  const prefix = record.intent?.mode === 'paper' ? 'Paper request' : 'Recorded request';
  if (record.status === 'settled' && record.terminal === true && record.completedRaw === (record.intent?.kind === 'withdrawal' ? record.intent.amountRaw : record.intent?.quantityRaw)) return `${prefix} settled in the recorded ledger. This is not live provider acceptance.`;
  if (record.status === 'partial') return record.terminal
    ? `${prefix} ended with a terminal partial settlement (${record.completedRaw} raw units). Unfilled exposure is not closed; a new request needs fresh authorization.`
    : `${prefix} partially settled (${record.completedRaw} raw units). Remaining exposure is not closed; reconciliation is still required.`;
  if (record.status === 'cancelled' && record.terminal === true && record.completedRaw === '0' && typeof record.cancellationReason === 'string' && record.cancellationReason.trim()) return `Request resolved as cancelled in the audited ledger (${record.cancellationReason}). No transfer or position closure is inferred.`;
  if (record.status === 'uncertain') return `${prefix} outcome uncertain. Reconciliation is required; do not submit a new intent.`;
  if (record.status === 'queued' || record.status === 'prepared') return `${prefix} ${record.status}. Admission is not financial completion.`;
  if (record.status === 'awaiting-authorization') return 'Exact intent recorded; authorization is still required. No transfer completion is confirmed.';
  return 'Request not completed. Refresh its durable status; no closure is confirmed.';
}
export function createDomainTransport(client: Pick<typeof api, 'get' | 'post'> = api) {
  return {
    capabilities: () => client.get<{ withdrawal: DomainCapability; reducing: DomainCapability; closeAll: DomainCapability }>('/v1/me/financial-capabilities'),
    requestWithdrawal: (input: WithdrawalRequest) => client.post<WithdrawalAuthorization>('/v1/me/trading/withdraw/request-otp', input),
    confirmWithdrawal: (input: { intentId: string; authorizationId: string; otp: string }) => client.post<FinancialResponse>('/v1/me/trading/withdraw',
      { intentId: input.intentId, authorizationId: input.authorizationId, otp: input.otp }),
    withdrawalStatus: (id: string) => client.get<FinancialResponse>(`/v1/me/trading/withdraw/${encodeURIComponent(id)}`),
    reduce: (venue: 'spot' | 'polymarket-perps', positionId: string, input: ReductionRequest) => client.post<FinancialResponse>(venue === 'spot'
      ? `/v1/me/positions/${encodeURIComponent(positionId)}/exit` : `/v1/me/perps/positions/${encodeURIComponent(positionId)}/close`, input),
    reductionStatus: (id: string) => client.get<FinancialResponse>(`/v1/me/reducing/${encodeURIComponent(id)}`),
    enrollLocal: (input: { chain: string; grantKind: string; accountAddress: string; consentId: string; expectedRevision: string }) =>
      client.post('/v1/me/vault/enrollment', input)
  };
}
export const domainTransport = createDomainTransport();

export interface LpAcquisitionResponse { position: LpExactPosition; positionId?: string; mode: 'paper'; broadcast: false; capabilities: LpExactCapabilities }
export interface LpPositionResponse { position: LpExactPosition; capabilities: LpExactCapabilities }
export interface LpOperationResponse { operation: LpExactOperation; broadcast: false; queued?: boolean; economics?: LpEconomicDecision }
export interface LpCopyMintRequest { subscriptionId: string; eventId: string; assetScale: number }
export function lpExactAdmissionAllowed(capability?: LpExactCapabilities | null): boolean {
  // Protocol presence is NOT master/risk availability or runtime/provider acceptance.
  return capability?.fractionalRawscaleDto === true && capability.injectedPortsConfigured === true;
}
export function lpExactAmount(amount: LpRawAmount): string {
  if (!amount || !Number.isInteger(amount.scale) || amount.scale < 0 || amount.scale > 30) throw new ApiError(400, 'Invalid LP scale');
  return rawAmount(amount.raw, amount.scale);
}
export function lpMicroUsd(value: string | null): string {
  if (value === null) return 'Unknown';
  if (!/^(0|[1-9][0-9]{0,77}|-[1-9][0-9]{0,77})$/.test(value)) throw new ApiError(400, 'Invalid exact microdollars');
  return `${value.startsWith('-') ? '-' : ''}$${rawAmount(value.replace(/^-/, ''), 6)}`;
}
const exactKeys = (value: object, allowed: readonly string[]) => {
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, 'Unexpected public LP input');
};
export function createLpDomainTransport(client: Pick<typeof lpApi, 'get' | 'post'> = lpApi) {
  return {
    capabilities: () => client.get<LpExactCapabilities>('/v1/lp/capabilities'),
    acquire: (input: LpExactAcquisitionRequest) => {
      exactKeys(input, ['operationKey', 'chain', 'poolAddress', 'depositAsset', 'deposit', 'strategy', 'autoRebalance']);
      exactKeys(input.deposit, ['raw', 'scale']); exactKeys(input.strategy, ['distribution', 'rangeLower', 'rangeUpper', 'rungCount']);
      lpExactAmount(input.deposit);
      return client.post<LpAcquisitionResponse>('/v1/lp/positions/deploy-exact', input);
    },
    position: (id: string) => client.get<LpPositionResponse>(`/v1/lp/positions/${encodeURIComponent(id)}/exact`),
    requestOperation: (id: string, action: 'rebalance' | 'close', input: { operationKey: string }) => {
      exactKeys(input, ['operationKey']);
      return client.post<LpOperationResponse>(`/v1/lp/positions/${encodeURIComponent(id)}/${action}`, { operationKey: input.operationKey });
    },
    operation: (id: string) => client.get<LpOperationResponse>(`/v1/lp/operations/${encodeURIComponent(id)}`),
    copyMint: (input: LpCopyMintRequest) => {
      exactKeys(input, ['subscriptionId', 'eventId', 'assetScale']);
      return client.post<LpAcquisitionResponse>('/v1/lp/copy/mint-exact', input);
    }
  };
}
export const lpDomainTransport = createLpDomainTransport();
