import { createHash } from 'node:crypto';
import type { Chain, SourceConfirmationState, SourceTradeSide } from '@swat/shared';

/** Exact immutable observation. No network is inferred from a chain label. */
export interface SourceVerificationBinding {
  readonly chain: Chain;
  readonly network: string;
  readonly sourceEventType: 'transaction' | 'order' | 'venue_trade';
  readonly sourceEventId: string;
  readonly sourceEventIndex: string;
  readonly transactionHash: string;
  readonly walletAddress: string;
  readonly tokenMint: string;
  readonly side: SourceTradeSide;
  readonly rawQuantity: string;
  readonly quantityScale: number;
  readonly eventAt: string;
  readonly amountUsd: string | null;
  readonly priceUsd: string | null;
  readonly feeUsd: string | null;
}
export interface SourceVerificationEvidence {
  readonly evidenceId: string;
  readonly binding: SourceVerificationBinding;
  readonly finality: Exclude<SourceConfirmationState, 'observed'>;
  readonly blockHash: string;
  readonly blockHeight: string;
  /** Provider-authenticated event revision, not wall-clock arrival order. */
  readonly revision: string;
  readonly reversesEvidenceId: string | null;
  readonly observedAt: string;
  readonly provenance: {
    readonly providerId: string;
    readonly authorityId: string;
    readonly verifierVersion: string;
    readonly receiptId: string;
  };
  /** Exact bytes/text verified by the trusted adapter; never a certificate label. */
  readonly content: string;
  readonly contentDigest: string;
}
export interface ValidatedSourceProvider {
  readonly providerId: string;
  readonly authorityId: string;
  readonly chain: Chain;
  readonly network: string;
  readonly verifierVersion: string;
  readonly identityDigest: string;
  readonly validUntil: string;
}
/** Implemented by approved server composition, never request/queue JSON.
 * Both identity authentication and chain/venue evidence validation are required.
 * There is intentionally no default implementation, live call, registration,
 * env switch, or certificate-to-authority conversion in this package. */
export interface TrustedSourceVerifier {
  validateProvider(): Promise<ValidatedSourceProvider | null>;
  verifyEvidence(input: Readonly<{
    evidence: SourceVerificationEvidence;
    expected: SourceVerificationBinding;
    provider: ValidatedSourceProvider;
    evidenceDigest: string;
  }>): Promise<Readonly<{ accepted: boolean; evidenceDigest: string; identityDigest: string }>>;
}
export function sourceContentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
function identifier(value: string, field: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid source ${field}`);
  }
  return value;
}
function integer(value: string, field: string, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || (positive && value === '0')) {
    throw new Error(`Invalid source ${field}: canonical exact integer required`);
  }
  return value;
}
export function exactSourceDecimal(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})(\.[0-9]{1,255})?$/.test(value)) {
    throw new Error('Source economics require exact unsigned decimal strings');
  }
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}
export function sourceTokenQuantity(raw: string, scale: number): string {
  integer(raw, 'raw quantity', true);
  if (!Number.isInteger(scale) || scale < 0 || scale > 255) throw new Error('Invalid source quantity scale');
  if (scale === 0) return raw;
  const padded = raw.padStart(scale + 1, '0');
  return exactSourceDecimal(`${padded.slice(0, -scale)}.${padded.slice(-scale)}`)!;
}
function timestamp(value: string, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid source ${field}: canonical UTC timestamp required`);
  }
  return value;
}
export function canonicalSourceBinding(input: SourceVerificationBinding): SourceVerificationBinding {
  if (!['solana', 'polygon', 'robinhood-chain'].includes(input.chain)) throw new Error('Unsupported source chain');
  if (!['transaction', 'order', 'venue_trade'].includes(input.sourceEventType)) throw new Error('Invalid source event type');
  if (!['buy', 'sell', 'transfer_in', 'transfer_out'].includes(input.side)) throw new Error('Invalid source direction');
  sourceTokenQuantity(input.rawQuantity, input.quantityScale);
  return Object.freeze({ chain: input.chain, network: identifier(input.network, 'network', 128),
    sourceEventType: input.sourceEventType, sourceEventId: identifier(input.sourceEventId, 'event ID'),
    sourceEventIndex: identifier(input.sourceEventIndex, 'event index', 128),
    transactionHash: identifier(input.transactionHash, 'transaction hash'),
    walletAddress: identifier(input.walletAddress, 'wallet', 128), tokenMint: identifier(input.tokenMint, 'mint', 128),
    side: input.side, rawQuantity: input.rawQuantity, quantityScale: input.quantityScale,
    eventAt: timestamp(input.eventAt, 'event time'), amountUsd: exactSourceDecimal(input.amountUsd),
    priceUsd: exactSourceDecimal(input.priceUsd), feeUsd: exactSourceDecimal(input.feeUsd) });
}
export function sourceBindingDigest(input: SourceVerificationBinding): string {
  return sourceContentDigest(JSON.stringify(canonicalSourceBinding(input)));
}
export function canonicalSourceEvidence(input: SourceVerificationEvidence): SourceVerificationEvidence {
  const binding = canonicalSourceBinding(input.binding);
  if (binding.sourceEventIndex.startsWith('ambiguous-data-api-wallet-v1:')) {
    throw new Error('Ambiguous Polymarket Data API observation is not a unique authoritative fill');
  }
  if (!['confirmed', 'finalized', 'reversed'].includes(input.finality)) throw new Error('Invalid source finality');
  if (typeof input.content !== 'string' || !input.content || Buffer.byteLength(input.content, 'utf8') > 1_048_576
      || sourceContentDigest(input.content) !== input.contentDigest) throw new Error('Source content digest mismatch');
  if ((input.finality === 'reversed') !== (input.reversesEvidenceId !== null)) throw new Error('Source reversal must reference accepted evidence');
  return Object.freeze({ evidenceId: identifier(input.evidenceId, 'evidence ID'), binding, finality: input.finality,
    blockHash: identifier(input.blockHash, 'block hash'), blockHeight: integer(input.blockHeight, 'block height'),
    revision: integer(input.revision, 'revision'), reversesEvidenceId: input.reversesEvidenceId === null ? null
      : identifier(input.reversesEvidenceId, 'reversal reference'), observedAt: timestamp(input.observedAt, 'observation time'),
    provenance: Object.freeze({ providerId: identifier(input.provenance.providerId, 'provider ID'),
      authorityId: identifier(input.provenance.authorityId, 'authority ID'),
      verifierVersion: identifier(input.provenance.verifierVersion, 'verifier version'),
      receiptId: identifier(input.provenance.receiptId, 'receipt ID') }), content: input.content, contentDigest: input.contentDigest });
}
export function sourceEvidenceDigest(input: SourceVerificationEvidence): string {
  return sourceContentDigest(JSON.stringify(canonicalSourceEvidence(input)));
}
export async function verifyBoundSourceEvidence(input: {
  expected: SourceVerificationBinding; evidence: SourceVerificationEvidence; verifier: TrustedSourceVerifier; now: Date;
}): Promise<{ evidence: SourceVerificationEvidence; evidenceDigest: string; provider: ValidatedSourceProvider }> {
  const expected = canonicalSourceBinding(input.expected);
  const evidence = canonicalSourceEvidence(input.evidence);
  if (sourceBindingDigest(expected) !== sourceBindingDigest(evidence.binding)) throw new Error('Source evidence immutable binding mismatch');
  if (!Number.isFinite(input.now.getTime()) || Date.parse(evidence.observedAt) > input.now.getTime() + 30_000) {
    throw new Error('Source evidence observation time is invalid');
  }
  if (!input.verifier || typeof input.verifier.validateProvider !== 'function' || typeof input.verifier.verifyEvidence !== 'function') {
    throw new Error('Source confirmation verifier is unavailable');
  }
  const authenticated = await input.verifier.validateProvider();
  if (!authenticated) throw new Error('Source provider identity is unavailable');
  const provider = Object.freeze({ ...authenticated });
  if (provider.chain !== expected.chain || provider.network !== expected.network
      || provider.providerId !== evidence.provenance.providerId || provider.authorityId !== evidence.provenance.authorityId
      || provider.verifierVersion !== evidence.provenance.verifierVersion || !/^[0-9a-f]{64}$/.test(provider.identityDigest)
      || !Number.isFinite(Date.parse(provider.validUntil)) || Date.parse(provider.validUntil) <= input.now.getTime()) {
    throw new Error('Source provider identity/scope validation failed');
  }
  const evidenceDigest = sourceEvidenceDigest(evidence);
  const result = await input.verifier.verifyEvidence(Object.freeze({ evidence, expected, provider, evidenceDigest }));
  if (!result || result.accepted !== true || result.evidenceDigest !== evidenceDigest || result.identityDigest !== provider.identityDigest) {
    throw new Error('Trusted source verifier rejected evidence');
  }
  return { evidence, evidenceDigest, provider };
}
