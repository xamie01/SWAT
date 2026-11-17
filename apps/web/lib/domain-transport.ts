import { api, ApiError } from './api.js';

export interface DomainCapability {
  contractVersion?: number; admissionSupported?: boolean; localEnrollmentSupported?: boolean;
  sourceImplemented?: boolean; injectedPortsConfigured?: boolean; injectedVerified?: boolean;
  runtimeAccepted?: boolean; liveAccepted?: boolean; supported?: boolean; state?: string;
}
export interface WithdrawalRequest {
  requestKey: string; chain: 'solana' | 'polygon' | 'robinhood-chain'; network: string; assetId: string;
  assetScale: number; sourceWalletId: string; destination: string; amountRaw: string; maxFeeRaw: string; mode: 'paper' | 'live';
}
export interface ReductionRequest extends Omit<WithdrawalRequest, 'sourceWalletId' | 'destination' | 'amountRaw'> {
  accountId: string; positionSide: 'LONG' | 'SHORT'; quantityRaw: string; limitPriceExact: string; expectedRevision: string;
}
export interface FinancialRecordView {
  id: string; intentHash: string; intent: { kind: string; requestKey: string; mode: string; amountRaw?: string;
    quantityRaw?: string; maxFeeRaw: string; assetScale: number; network: string; [key: string]: unknown };
  status: 'awaiting-authorization' | 'queued' | 'prepared' | 'uncertain' | 'partial' | 'settled' | 'failed';
  completedRaw: string; terminal: boolean;
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
  if ((record.status as string) === 'cancelled' && record.terminal === true) return 'Request resolved as cancelled in the audited ledger. No transfer or position closure is inferred.';
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
