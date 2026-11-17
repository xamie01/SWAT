import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { WithdrawalProtocolError, financialHash, type FinancialRecord, type WithdrawalIntent } from '@swat/db/dist/withdrawal-contract.js';
import type { WithdrawalService } from '@swat/db/dist/withdrawal-service.js';
import type { ReducingService } from '@swat/db/dist/reducing-service.js';
import type { ReducingIntent } from '@swat/db/dist/reducing-contract.js';
import { requireUser } from '../auth/plugin.js';

/** Admission/status only. The API receives no execution, receipt-admission or signing port. */
export interface MeFinancialPorts {
  readonly withdrawal?: Pick<WithdrawalService, 'requestOtp' | 'submit' | 'status'>;
  readonly reducing?: Pick<ReducingService, 'request' | 'status'>;
}
export function financialCapability(configured: boolean) {
  return { contractVersion: 1, state: configured ? 'injected-admission-only' : 'blocked-on-external-capability',
    supported: false, admissionSupported: configured, sourceImplemented: true, injectedPortsConfigured: configured,
    injectedVerified: false, runtimeAccepted: false, liveAccepted: false,
    unavailableReasons: ['provider-receipt-reconciliation-unavailable', 'runtime-provider-and-receipt-acceptance-unavailable', ...(configured ? [] : ['durable-domain-ports-unavailable'])] };
}
const text = z.string().min(1).max(256).refine(v => v.trim() === v && v !== '*' && !/[\x00-\x1f]/.test(v));
const raw = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/);
const positiveRaw = raw.refine(v => v !== '0');
const common = { requestKey: text, chain: z.enum(['solana', 'polygon', 'robinhood-chain']), network: text,
  assetId: text, assetScale: z.number().int().min(0).max(36), mode: z.enum(['paper', 'live']), maxFeeRaw: raw,
  feeAssetId: text, feeAssetScale: z.number().int().min(0).max(36), feeFundingAccountId: text };
export const withdrawalRequestSchema = z.object({ ...common, sourceWalletId: text, destination: text, amountRaw: positiveRaw }).strict();
export const withdrawalConfirmSchema = z.object({ intentId: text, authorizationId: text, otp: z.string().regex(/^[0-9]{6,10}$/) }).strict();
export const reducingRequestSchema = z.object({ ...common, accountId: text, positionSide: z.enum(['LONG', 'SHORT']),
  quantityRaw: positiveRaw, limitPriceExact: z.string().max(78).regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/).refine(v => /[1-9]/.test(v)), expectedRevision: text }).strict();

/** Check tenant and immutable digest; never serialize an arbitrary storage/provider row. */
export function publicFinancialRecord(record: FinancialRecord<WithdrawalIntent | ReducingIntent>, userId: string) {
  if (record.userId !== userId || record.intent.userId !== userId || record.intentHash !== financialHash(record.intent)) {
    throw new Error('Invalid domain projection');
  }
  const intent = record.intent;
  const maximum = intent.kind === 'withdrawal' ? intent.amountRaw : intent.quantityRaw;
  if (!raw.safeParse(record.completedRaw).success || !positiveRaw.safeParse(maximum).success || typeof record.terminal !== 'boolean'
    || BigInt(record.completedRaw) > BigInt(maximum)
    || !['awaiting-authorization', 'queued', 'prepared', 'uncertain', 'partial', 'settled', 'failed', 'cancelled'].includes(record.status)
    || (record.status === 'settled' && (!record.terminal || record.completedRaw !== maximum))
    || (record.status === 'cancelled' && (!record.terminal || record.completedRaw !== '0' || !text.safeParse(record.cancellationReason).success))
    || (record.status !== 'cancelled' && record.cancellationReason != null)
    || (record.terminal && !['settled', 'partial', 'failed', 'cancelled'].includes(record.status))) {
    throw new Error('Invalid domain progress');
  }
  const base = { version: 1, requestKey: intent.requestKey, chain: intent.chain, network: intent.network,
    assetId: intent.assetId, assetScale: intent.assetScale, mode: intent.mode, maxFeeRaw: intent.maxFeeRaw,
    feeAssetId: intent.feeAssetId, feeAssetScale: intent.feeAssetScale, feeFundingAccountId: intent.feeFundingAccountId, expiresAt: intent.expiresAt };
  const { expiresAt: _expiresAt, version: _version, ...requestBase } = base;
  const projectedRequest = intent.kind === 'withdrawal'
    ? { ...requestBase, sourceWalletId: intent.sourceWalletId, destination: intent.destination, amountRaw: intent.amountRaw }
    : { ...requestBase, accountId: intent.accountId, positionSide: intent.positionSide, quantityRaw: intent.quantityRaw,
      limitPriceExact: intent.limitPriceExact, expectedRevision: intent.expectedRevision };
  if (!(intent.kind === 'withdrawal' ? withdrawalRequestSchema : reducingRequestSchema).safeParse(projectedRequest).success) {
    throw new Error('Invalid domain intent');
  }
  const binding = intent.kind === 'withdrawal'
    ? { ...base, kind: 'withdrawal', sourceWalletId: intent.sourceWalletId, destination: intent.destination, amountRaw: intent.amountRaw }
    : { ...base, kind: 'reducing', venue: intent.venue, positionId: intent.positionId, accountId: intent.accountId,
      positionSide: intent.positionSide, side: intent.side, quantityRaw: intent.quantityRaw,
      limitPriceExact: intent.limitPriceExact, expectedRevision: intent.expectedRevision };
  return { id: record.id, intentHash: record.intentHash, intent: binding, status: record.status,
    completedRaw: record.completedRaw, terminal: record.terminal, cancellationReason: record.cancellationReason ?? null, createdAt: record.createdAt };
}
export function financialRouteError(error: unknown, reply: FastifyReply) {
  if (!(error instanceof WithdrawalProtocolError)) return reply.code(503).send({ code: 'FINANCIAL_DOMAIN_UNAVAILABLE', message: 'Domain request unavailable. No completion is confirmed.' });
  const code = error.code;
  const status = /not-found/.test(code) ? 404 : /ownership|otp-invalid|otp-locked|authorization-mismatch/.test(code) ? 403
    : /^invalid-|invalid$|scale-loss/.test(code) ? 400 : /unavailable|persistence/.test(code) ? 503 : 409;
  return reply.code(status).send({ code, message: 'Domain request refused. No financial completion is confirmed.' });
}
export async function registerMeFinancialRoutes(app: FastifyInstance, ports?: MeFinancialPorts) {
  const unavailable = (reply: FastifyReply) => reply.code(501).send({ error: 'withdrawal-unsupported', supported: false,
    capability: financialCapability(false), message: 'Withdrawals are unavailable. No code was sent, authorization recorded, or transfer queued.' });
  app.post('/v1/me/trading/withdraw/request-otp', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = requireUser(request, reply); if (!scope) return;
    if (!ports?.withdrawal) return unavailable(reply);
    const parsed = withdrawalRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_EXACT_WITHDRAWAL' });
    try {
      const result = await ports.withdrawal.requestOtp(scope.userId, parsed.data);
      return reply.send({ record: publicFinancialRecord(result.intent, scope.userId), authorizationId: result.authorizationId,
        authorizationExpiresAt: result.authorizationExpiresAt, delivery: result.delivery, replay: result.replay,
        capability: financialCapability(true), message: 'Exact intent recorded only. No transfer has been submitted by this route.' });
    } catch (error) { return financialRouteError(error, reply); }
  });
  app.post('/v1/me/trading/withdraw', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = requireUser(request, reply); if (!scope) return;
    if (!ports?.withdrawal) return unavailable(reply);
    const parsed = withdrawalConfirmSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_WITHDRAWAL_CONFIRMATION' });
    try {
      const result = await ports.withdrawal.submit(scope.userId, parsed.data);
      return reply.send({ record: publicFinancialRecord(result, scope.userId), capability: financialCapability(true),
        message: 'Durable request status recorded. Queue admission is not transfer completion.' });
    } catch (error) { return financialRouteError(error, reply); }
  });
  app.get('/v1/me/trading/withdraw/:intentId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = requireUser(request, reply); if (!scope) return;
    if (!ports?.withdrawal) return unavailable(reply);
    const id = text.safeParse((request.params as { intentId: string }).intentId);
    if (!id.success) return reply.code(400).send({ code: 'INVALID_INTENT_ID' });
    try {
      const record = await ports.withdrawal.status(scope.userId, id.data);
      if (!record) return reply.code(404).send({ code: 'INTENT_NOT_FOUND' });
      return reply.send({ record: publicFinancialRecord(record, scope.userId), capability: financialCapability(true) });
    } catch (error) { return financialRouteError(error, reply); }
  });
  app.get('/v1/me/reducing/:intentId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const scope = requireUser(request, reply); if (!scope) return;
    if (!ports?.reducing) return reply.code(503).send({ code: 'POSITION_EXIT_UNAVAILABLE', supported: false });
    const id = text.safeParse((request.params as { intentId: string }).intentId);
    if (!id.success) return reply.code(400).send({ code: 'INVALID_INTENT_ID' });
    try {
      const record = await ports.reducing.status(scope.userId, id.data);
      if (!record) return reply.code(404).send({ code: 'INTENT_NOT_FOUND' });
      return reply.send({ record: publicFinancialRecord(record, scope.userId), capability: financialCapability(true) });
    } catch (error) { return financialRouteError(error, reply); }
  });
  app.get('/v1/me/financial-capabilities', async (request, reply) => {
    reply.header('Cache-Control', 'no-store'); if (!requireUser(request, reply)) return;
    return reply.send({ withdrawal: financialCapability(!!ports?.withdrawal), reducing: financialCapability(!!ports?.reducing),
      closeAll: financialCapability(false) });
  });
}
export async function requestMeReduction(request: FastifyRequest, reply: FastifyReply, service: NonNullable<MeFinancialPorts['reducing']>, venue: 'spot' | 'polymarket-perps') {
  reply.header('Cache-Control', 'no-store');
  const scope = requireUser(request, reply); if (!scope) return;
  const id = text.safeParse((request.params as { id: string }).id);
  const parsed = reducingRequestSchema.safeParse(request.body);
  if (!parsed.success || !id.success) return reply.code(400).send({ code: 'INVALID_EXACT_REDUCTION' });
  try {
    const record = await service.request(scope.userId, { ...parsed.data, positionId: id.data, venue });
    return reply.send({ record: publicFinancialRecord(record, scope.userId), capability: financialCapability(true),
      message: 'Reducing intent admitted only. Exposure is not closed without receipt settlement.' });
  } catch (error) { return financialRouteError(error, reply); }
}
