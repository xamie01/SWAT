import type { PoolClient } from 'pg';
import type { UserScope } from './tenancy.js';
import { lpExactHash, lpSnapshot, lpTime, type LpExactOperation, type LpExactPosition, type LpPaperReceipt } from './lp-exact.js';
import {
  lpAdmissionQuoteInput, lpAdmissionContextKey, requireLpQuoteContext, requireLpSettlementContext,
  requireLpQuoteAdmission, requireLpSettlementAdmission,
  type LpProtectedQuoteAdmission, type LpProtectedSettlementAdmission,
  type LpQuoteAdmissionContext, type LpSettlementAdmissionContext
} from './lp-paper-admission-contract.js';
import { lpValidateQuote, lpValidateReceipt, type LpInjectedProtocolPort } from './lp-paper-service.js';

interface QuoteRow {
  id: string; user_id: string; input: LpProtectedQuoteAdmission['input']; quote: LpProtectedQuoteAdmission['quote'];
  context: LpQuoteAdmissionContext; context_key: string; quote_hash: string; admitted_at: Date | string;
}
interface SettlementRow {
  id: string; user_id: string; quote_admission_id: string; operation_id: string; position_id: string;
  position_revision: string; receipt: LpPaperReceipt; context: LpSettlementAdmissionContext; admitted_at: Date | string;
}
function need(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`LP protected admission: ${reason}`);
}
function quoteRecord(row: QuoteRow | undefined): LpProtectedQuoteAdmission | null {
  need(!row || (row.admitted_at !== null && row.admitted_at !== undefined), 'stored quote chronology unavailable');
  return row ? lpSnapshot({ id: row.id, userId: row.user_id, input: row.input, quote: row.quote,
    context: row.context, contextKey: row.context_key, quoteHash: row.quote_hash, admittedAt: new Date(row.admitted_at).toISOString() }) : null;
}
function settlementRecord(row: SettlementRow | undefined): LpProtectedSettlementAdmission | null {
  need(!row || (row.admitted_at !== null && row.admitted_at !== undefined), 'stored settlement chronology unavailable');
  return row ? lpSnapshot({ id: row.id, userId: row.user_id, quoteAdmissionId: row.quote_admission_id,
    operationId: row.operation_id, positionId: row.position_id, positionRevision: row.position_revision,
    receipt: row.receipt, context: row.context, admittedAt: new Date(row.admitted_at).toISOString() }) : null;
}
/** Pool-free, stateless SELECT-only lookup. Every call requires the owner's checked-out client. */
export const lpPaperAdmissionLookup = {
  async now(client: PoolClient): Promise<Date> {
    need(client && typeof client.query === 'function', 'owned transaction client required');
    const result = await client.query<{ now: Date | string }>('SELECT clock_timestamp() AS now /* lp-admission:clock */');
    need(result.rows[0] && result.rows[0].now !== null && result.rows[0].now !== undefined, 'database clock unavailable');
    const date = new Date(result.rows[0].now); lpTime(date.toISOString()); return date;
  },
  async quote(client: PoolClient, userId: string, context: LpQuoteAdmissionContext, historical = false): Promise<LpProtectedQuoteAdmission> {
    need(client && typeof client.query === 'function', 'owned transaction client required');
    const input = lpAdmissionQuoteInput(userId, context), candidate = context.commit.quote;
    const result = await client.query<QuoteRow>(`SELECT id,user_id,input,quote,context,context_key,quote_hash,admitted_at
      FROM public.lp_protected_quote_admissions WHERE user_id=$1 AND intent_hash=$2
        AND input=$3::jsonb AND quote=$4::jsonb AND context=$5::jsonb AND context_key=$6 /* lp-admission:quote */`,
    [userId, input.intentHash, JSON.stringify(input), JSON.stringify(candidate), JSON.stringify(context), lpAdmissionContextKey(context)]);
    need(result.rows.length <= 1, 'ambiguous quote admission');
    const admission = requireLpQuoteAdmission(quoteRecord(result.rows[0]), input, candidate, await this.now(client), historical);
    requireLpQuoteContext(admission, context); return admission;
  },
  async settlement(client: PoolClient, op: LpExactOperation, position: LpExactPosition, receipt: LpPaperReceipt): Promise<LpProtectedSettlementAdmission> {
    need(client && typeof client.query === 'function', 'owned transaction client required');
    const quote = await this.quote(client, op.userId, { kind: 'operation', commit: {
      position, operationKey: op.operationKey, fingerprint: op.fingerprint, action: op.action,
      quote: op.quote, plan: op.plan, receiptKey: op.receiptKey
    } }, true);
    const operation = await client.query<{ created_at: Date | string }>(`SELECT created_at FROM public.lp_exact_operations
      WHERE user_id=$1 AND id=$2 AND position_id=$3 AND data=$4::jsonb /* lp-admission:operation-time */`,
    [op.userId, op.id, position.id, JSON.stringify(op)]);
    need(operation.rows[0] && operation.rows[0].created_at !== null && operation.rows[0].created_at !== undefined,
      'canonical operation chronology unavailable');
    const context: LpSettlementAdmissionContext = { operation: op, position,
      operationCreatedAt: new Date(operation.rows[0].created_at).toISOString() };
    const result = await client.query<SettlementRow>(`SELECT id,user_id,quote_admission_id,operation_id,position_id,
      position_revision,receipt,context,admitted_at FROM public.lp_protected_settlement_admissions
      WHERE user_id=$1 AND operation_id=$2 /* lp-admission:settlement */`, [op.userId, op.id]);
    need(result.rows.length <= 1, 'ambiguous settlement admission');
    const admission = requireLpSettlementAdmission(settlementRecord(result.rows[0]), quote, op, position, receipt, await this.now(client));
    requireLpSettlementContext(admission, quote, context); return admission;
  }
};

/** The host must supply a direct externally authorized swat_lp_admitter session during its ephemeral
 * LOGIN window (default provisioning remains NOLOGIN), plus tenant setup, rollback and checked COMMIT.
 * Provision/revoke lifecycle belongs to the external owner. Never SET ROLE or reuse runtime clients. */
export type LpAdmitterTransaction = <T>(scope: UserScope, action: (client: PoolClient) => Promise<T>) => Promise<T>;
export interface LpTrustedAdmissionSource {
  readonly protocol: LpInjectedProtocolPort;
  /** Resolve/approve authoritative context independently; the selector is NOT an acquisition DTO/hash. */
  quoteContext(client: PoolClient, scope: UserScope, selector: string): Promise<LpQuoteAdmissionContext | null>;
  /** Return independently approved full operation/current-position context and its DB chronology.
   * Position must use lpProjectProtectedPosition (SQL lp085_current_position), including legacy state/consent. */
  settlementContext(client: PoolClient, scope: UserScope, operationId: string): Promise<LpSettlementAdmissionContext | null>;
}
async function restricted(client: PoolClient, userId: string): Promise<void> {
  need(client && typeof client.query === 'function', 'separate restricted client required');
  const result = await client.query<{ allowed: boolean }>(`SELECT (
    current_user='swat_lp_admitter' AND session_user='swat_lp_admitter'
    AND current_setting('row_security')='on' AND public.current_app_user_id()=$1::uuid
    AND COALESCE(current_setting('app.bypass_rls',true),'off')='off'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user
      AND NOT(rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
      OR roleid=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datdba=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))
    AND NOT pg_catalog.has_schema_privilege(current_user,'public','CREATE')
    AND NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE')
    ) AS allowed /* lp-admission:restricted */`, [userId]);
  need(result.rows[0]?.allowed === true, 'direct isolated restricted role and tenant required');
}
/** Only trusted constructor callbacks can produce admission payloads. No public candidate-admit API. */
export function createLpPaperAdmissionWriter(run: LpAdmitterTransaction, source: LpTrustedAdmissionSource) {
  need(typeof run === 'function' && source?.protocol && typeof source.quoteContext === 'function'
    && typeof source.settlementContext === 'function', 'separate transaction and trusted source required');
  const protocol = { providerId: source.protocol.providerId, networks: lpSnapshot(source.protocol.networks),
    quote: source.protocol.quote.bind(source.protocol), receipt: source.protocol.receipt.bind(source.protocol) };
  const quoteContext = source.quoteContext.bind(source), settlementContext = source.settlementContext.bind(source);
  function scopeValid(scope: UserScope, selector: string) {
    need(scope && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(scope.userId)
      && typeof selector === 'string' && selector.length > 0
      && selector.length <= 256, 'canonical tenant and source selector required');
  }
  return {
    quote: async (scope: UserScope, selector: string) => {
      scopeValid(scope, selector); scope = { userId: scope.userId } as UserScope;
      return run(scope, async client => {
        await restricted(client, scope.userId);
        const resolved = await quoteContext(client, scope, selector); need(resolved, 'trusted quote context unavailable');
        const context = lpSnapshot(resolved), input = lpAdmissionQuoteInput(scope.userId, context);
        const output = await protocol.quote(lpSnapshot(input)); need(output, 'trusted admitted provider quote unavailable');
        const quote = lpSnapshot(output), now = await lpPaperAdmissionLookup.now(client);
        lpValidateQuote(quote, input, protocol, now);
        need(lpExactHash(quote) === lpExactHash(context.commit.quote), 'trusted context/provider quote mismatch');
        const result = await client.query<QuoteRow>(`INSERT INTO public.lp_protected_quote_admissions
          (user_id,intent_hash,input,quote,quote_hash,context,context_key,quote_canonical) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6::jsonb,$7,$8)
          ON CONFLICT(user_id,context_key) DO NOTHING RETURNING * /* lp-admission:write-quote */`,
        [scope.userId, input.intentHash, JSON.stringify(input), JSON.stringify(quote), lpExactHash(quote), JSON.stringify(context),
          lpAdmissionContextKey(context), JSON.stringify(lpSnapshot(quote))]);
        if (!result.rows[0]) return lpPaperAdmissionLookup.quote(client, scope.userId, context, true);
        const admission = requireLpQuoteAdmission(quoteRecord(result.rows[0]), input, quote, await lpPaperAdmissionLookup.now(client));
        requireLpQuoteContext(admission, context); return admission;
      });
    },
    settlement: async (scope: UserScope, operationId: string) => {
      scopeValid(scope, operationId); scope = { userId: scope.userId } as UserScope;
      return run(scope, async client => {
        await restricted(client, scope.userId);
        const resolved = await settlementContext(client, scope, operationId); need(resolved, 'trusted settlement context unavailable');
        const context = lpSnapshot(resolved), { operation, position } = context;
        need(operation.id === operationId && operation.userId === scope.userId && position.userId === scope.userId, 'trusted settlement tenant mismatch');
        const quote = await lpPaperAdmissionLookup.quote(client, scope.userId, { kind: 'operation', commit: {
          position, operationKey: operation.operationKey, fingerprint: operation.fingerprint, action: operation.action,
          quote: operation.quote, plan: operation.plan, receiptKey: operation.receiptKey
        } }, true);
        const output = await protocol.receipt(lpSnapshot({ operation, position })); need(output, 'trusted admitted provider settlement unavailable');
        const receipt = lpSnapshot(output); lpValidateReceipt(receipt, operation, position, protocol, await lpPaperAdmissionLookup.now(client));
        const observed = await lpPaperAdmissionLookup.now(client);
        need(lpTime(context.operationCreatedAt) >= lpTime(quote.admittedAt)
          && lpTime(context.operationCreatedAt) < lpTime(quote.quote.expiresAt)
          && lpTime(receipt.settledAt) >= lpTime(context.operationCreatedAt)
          && lpTime(receipt.settledAt) >= lpTime(quote.admittedAt)
          && lpTime(receipt.settledAt) <= observed.getTime(), 'trusted settlement chronology mismatch');
        const result = await client.query<SettlementRow>(`INSERT INTO public.lp_protected_settlement_admissions
          (user_id,quote_admission_id,operation_id,position_id,position_revision,receipt,context)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT(user_id,operation_id) DO NOTHING
          RETURNING * /* lp-admission:write-settlement */`, [scope.userId, quote.id, operation.id, position.id,
          position.revision, JSON.stringify(receipt), JSON.stringify(context)]);
        if (!result.rows[0]) return lpPaperAdmissionLookup.settlement(client, operation, position, receipt);
        const admission = requireLpSettlementAdmission(settlementRecord(result.rows[0]), quote, operation, position, receipt,
          await lpPaperAdmissionLookup.now(client));
        requireLpSettlementContext(admission, quote, context); return admission;
      });
    }
  };
}
