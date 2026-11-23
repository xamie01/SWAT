import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import type { UserScope } from './tenancy.js';
import {
  lpExactHash, lpIdentity, lpSnapshot, lpTime,
  type LpExactSubscription, type LpExactPosition, type LpExactOperation
} from './lp-exact.js';
import { createLpPaperService, type LpPaperServiceDeps, type LpPaperTransaction } from './lp-paper-service.js';
import { createLpPaperSqlStore, type LpTenantTransaction } from './lp-paper-store.js';
import { createLpPaperAdmissionWriter, lpPaperAdmissionLookup,
  type LpAdmitterTransaction } from './lp-paper-admission-store.js';
import { lpAdmissionContextKey, type LpQuoteAdmissionContext,
  type LpSettlementAdmissionContext } from './lp-paper-admission-contract.js';

/** Export the type from this owned DB leaf; consumers must not import pg or the DB barrel. */
export type { PoolClient, UserScope };
export const lpOwnedSourceGaps = Object.freeze([
  'protected exact LP subscription/guardrail initialization writer and approved direct identity are not provisioned by SQL083/084/085/086',
  'protected LP secret/provider/master/risk provenance admission writer, storage, forced RLS, revocation and approved identity lookup are not implemented by the current LP schema',
  'shared financial integration and its bounded configuration/provisioning remain coordinator owned'
] as const);
export type LpOwnedPurpose = 'initialization' | 'secret' | 'quote' | 'receipt' | 'master' | 'risk' | 'quote-context' | 'settlement-context';
export interface LpOwnedBinding {
  readonly userId: string;
  readonly accountId: string;
  readonly chain: LpExactSubscription['chain'];
  readonly networkId: string;
}
/** A reference to an externally approved, protected identity is mandatory constructor input.
 * It is not minted here. The independently protected reader must re-read its current admission
 * on each use. IDs/provider labels or successful callbacks alone do not authorize anything. */
export interface LpOwnedAuthority {
  readonly identityId: string;
  readonly providerId: string;
}
export interface LpOwnedProtectedRecord<T> {
  readonly id: string;
  readonly identityId: string;
  readonly providerId: string;
  readonly binding: LpOwnedBinding;
  readonly purpose: LpOwnedPurpose;
  readonly selector: string;
  readonly payload: T;
  readonly payloadHash: string;
  readonly admittedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: null;
}
export interface LpOwnedInitialization {
  readonly subscription: LpExactSubscription;
  readonly poolCapBps: number;
}
export interface LpOwnedSecretAdmission {
  /** A protected secret admission reference, never secret bytes or signing material. */
  readonly secretAdmissionId: string;
  readonly accountId: string;
  readonly actions: readonly ['acquire', 'copy', 'rebalance', 'close', 'recover'];
}
export interface LpOwnedProtectedSource {
  /** SELECT from independently protected admissions, not certification of a runtime DTO.
   * The host must supply approved identity provisioning/storage; current LP SQL does not
   * provision these initialization/secret/provider records. Absent backing must return null. */
  read<T>(client: PoolClient, binding: LpOwnedBinding, purpose: LpOwnedPurpose, selector: string): Promise<LpOwnedProtectedRecord<T> | null>;
}
export interface LpOwnedCompositionPorts {
  readonly binding: LpOwnedBinding;
  readonly runtimeTransaction: LpTenantTransaction;
  readonly admissionTransaction: LpAdmitterTransaction;
  readonly authorities: Readonly<Record<LpOwnedPurpose, LpOwnedAuthority>>;
  readonly protectedSource: LpOwnedProtectedSource;
  readonly initializationSelector: string;
  readonly secretSelector: string;
  readonly protocol: NonNullable<LpPaperServiceDeps['protocol']>;
  readonly master: NonNullable<LpPaperServiceDeps['master']>;
  readonly copyRisk: NonNullable<LpPaperServiceDeps['copyRisk']>;
  readonly mode: LpPaperServiceDeps['mode'];
  readonly plan: LpPaperServiceDeps['plan'];
  readonly enqueue?: LpPaperServiceDeps['enqueue'];
}
function need(value: unknown, reason: string): asserts value {
  if (!value) throw new Error(`LP owned composition: ${reason}`);
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const purposes: readonly LpOwnedPurpose[] = ['initialization','secret','quote','receipt','master','risk','quote-context','settlement-context'];
function same(a: unknown, b: unknown, reason: string): void { need(lpExactHash(a) === lpExactHash(b), reason); }

/** Actual canonical service, protected SQL writer and SQL store bodies, not a business clone.
 * No ambient client fallback, pool, signer, network, role switch or initialization grant.
 * Transactions must own all work through checked COMMIT and refuse uncertain outcomes.
 * Distinct runtime/admitter clients are checked in SQL, never inferred from port names. */
export function createOwnedLpPaperComposition(input: LpOwnedCompositionPorts) {
  need(input && typeof input.runtimeTransaction === 'function' && typeof input.admissionTransaction === 'function'
    && input.runtimeTransaction !== input.admissionTransaction && typeof input.protectedSource?.read === 'function',
  'distinct owned runtime/admitter transactions and protected source required');
  need(input.protocol && typeof input.protocol.quote === 'function' && typeof input.protocol.receipt === 'function'
    && input.master && typeof input.master.read === 'function' && input.copyRisk && typeof input.copyRisk.assess === 'function'
    && typeof input.mode === 'function' && typeof input.plan === 'function', 'mandatory protected protocol/master/risk ports required');
  const binding = lpSnapshot(input.binding), authorities = lpSnapshot(input.authorities);
  need(binding && uuid.test(binding.userId) && typeof binding.networkId === 'string'
    && binding.networkId.startsWith(`${binding.chain}:`), 'exact tenant/network/account binding required');
  lpIdentity(binding.chain, binding.accountId);
  for (const purpose of purposes) need(authorities?.[purpose] && uuid.test(authorities[purpose].identityId)
    && typeof authorities[purpose].providerId === 'string' && !!authorities[purpose].providerId.trim(),
  `externally approved ${purpose} identity required`);
  need(authorities.quote.providerId === input.protocol.providerId && authorities.receipt.providerId === input.protocol.providerId
    && authorities.master.providerId === input.master.providerId && authorities.risk.providerId === input.copyRisk.providerId
    && input.protocol.networks[binding.chain] === binding.networkId, 'approved provider/network identities mismatch');
  need(input.initializationSelector && input.secretSelector, 'protected initialization/secret selectors required');
  const runtime = input.runtimeTransaction, admitter = input.admissionTransaction;
  const read = input.protectedSource.read.bind(input.protectedSource);
  const protocolQuote = input.protocol.quote.bind(input.protocol), protocolReceipt = input.protocol.receipt.bind(input.protocol);
  const masterRead = input.master.read.bind(input.master), riskAssess = input.copyRisk.assess.bind(input.copyRisk);
  const scope = { userId: binding.userId } as UserScope;
  const initializationSelector = input.initializationSelector, secretSelector = input.secretSelector;
  const networks = lpSnapshot(input.protocol.networks);
  function owned(s: UserScope): void { need(s?.userId === binding.userId, 'foreign tenant refused'); }
  async function runtimeIdentity(client: PoolClient): Promise<void> {
    const result = await client.query(`SELECT current_user::text AS role,session_user::text AS session,
      current_setting('row_security') AS row_security,public.current_app_user_id()::text AS tenant,
      COALESCE(current_setting('app.bypass_rls',true),'off') AS bypass /* lp-owned:runtime-identity */`);
    const r = result.rows[0];
    need(result.rows.length === 1 && r.role === 'swat_app' && r.session === 'swat_app'
      && r.row_security === 'on' && r.tenant === binding.userId && r.bypass === 'off', 'direct authenticated runtime identity required');
  }
  const currentClient = new AsyncLocalStorage<PoolClient>();
  const checkedRuntime: LpTenantTransaction = async (s, action) => {
    owned(s); return runtime(scope, async client => {
      await runtimeIdentity(client); return currentClient.run(client, () => action(client));
    });
  };
  const checkedAdmitter: LpAdmitterTransaction = async (s, action) => {
    owned(s); return admitter(scope, client => currentClient.run(client, () => action(client)));
  };
  async function protectedRecord<T>(client: PoolClient, purpose: LpOwnedPurpose, selector: string): Promise<T> {
    need(typeof selector === 'string' && selector.length > 0 && selector.length <= 256, 'bounded protected selector required');
    const output = await read<T>(client, lpSnapshot(binding), purpose, selector);
    need(output, `independently protected ${purpose} admission unavailable; external approved backing required`);
    const record = lpSnapshot(output), now = await lpPaperAdmissionLookup.now(client);
    const authority = authorities[purpose];
    need(uuid.test(record.id) && record.identityId === authority.identityId && record.providerId === authority.providerId
      && record.purpose === purpose && record.selector === selector && record.revokedAt === null,
    `${purpose} protected identity/revocation mismatch`);
    same(record.binding, binding, `${purpose} tenant/network/account mismatch`);
    same(record.payloadHash, lpExactHash(record.payload), `${purpose} complete protected payload mismatch`);
    need(lpTime(record.admittedAt) <= now.getTime() && lpTime(record.expiresAt) > now.getTime()
      && lpTime(record.expiresAt) > lpTime(record.admittedAt), `${purpose} protected chronology refused`);
    if (purpose === 'quote' || purpose === 'master' || purpose === 'risk' || purpose === 'receipt') {
      const evidence = record.payload as { observedAt?: string; settledAt?: string; pool?: { observedAt: string } };
      const evidenceTime = purpose === 'receipt' ? evidence.settledAt : evidence.observedAt;
      need(typeof evidenceTime === 'string' && lpTime(record.admittedAt) >= lpTime(evidenceTime)
        && (!evidence.pool || lpTime(record.admittedAt) >= lpTime(evidence.pool.observedAt)),
      `${purpose} protected admission predates evidence`);
    }
    return lpSnapshot(record.payload);
  }
  async function approved<T>(purpose: LpOwnedPurpose, selector: string, candidate: T): Promise<T> {
    const compare = async (client: PoolClient) => {
      const payload = await protectedRecord<T>(client, purpose, selector);
      same(payload, candidate, `${purpose} independently admitted complete evidence mismatch`); return lpSnapshot(payload);
    };
    const active = currentClient.getStore();
    return active ? compare(active) : checkedRuntime(scope, compare);
  }
  const protocol: NonNullable<LpPaperServiceDeps['protocol']> = {
    providerId: authorities.quote.providerId, networks,
    quote: async qInput => {
      need(qInput.userId === binding.userId && qInput.chain === binding.chain, 'quote tenant/chain mismatch');
      const q = await protocolQuote(lpSnapshot(qInput)); if (!q) return null;
      need(q.pool.networkId === binding.networkId, 'quote protected network mismatch');
      return approved('quote', q.quoteId, q);
    },
    receipt: async context => {
      need(context.operation.userId === binding.userId && context.position.userId === binding.userId
        && context.position.chain === binding.chain, 'receipt tenant/chain mismatch');
      const r = await protocolReceipt(lpSnapshot(context)); if (!r) return null;
      return approved('receipt', r.receiptId, r);
    }
  };
  const writer = createLpPaperAdmissionWriter(checkedAdmitter, { protocol,
    quoteContext: async (client, s, selector) => {
      owned(s); return protectedRecord<LpQuoteAdmissionContext>(client, 'quote-context', selector);
    },
    settlementContext: async (client, s, operationId) => {
      owned(s); return protectedRecord<LpSettlementAdmissionContext>(client, 'settlement-context', operationId);
    }
  });
  async function finalAuthority(tx: LpPaperTransaction): Promise<void> {
    const client = currentClient.getStore(); need(client, 'owned final transaction required');
    const initialized = await protectedRecord<LpOwnedInitialization>(client, 'initialization', initializationSelector);
    need(initialized.subscription.userId === binding.userId && initialized.subscription.chain === binding.chain
      && initialized.subscription.status === 'active', 'final protected initialization scope mismatch');
    same(await tx.subscription(initialized.subscription.id), initialized.subscription, 'final protected subscription revision mismatch');
    const secret = await protectedRecord<LpOwnedSecretAdmission>(client, 'secret', secretSelector);
    need(uuid.test(secret.secretAdmissionId) && secret.accountId === binding.accountId, 'final protected secret admission required');
    same(secret.actions, ['acquire','copy','rebalance','close','recover'], 'final secret action scope mismatch');
    const cap = await client.query<{ cap: string }>('SELECT max_pool_allocation_pct::text AS cap FROM public.lp_guardrail_configs WHERE user_id=$1 /* lp-owned:initialization */', [binding.userId]);
    need(cap.rows.length === 1 && /^\d+(\.\d{1,6})?$/.test(cap.rows[0]!.cap), 'final initialized guardrail unavailable');
    const [whole, fraction = ''] = cap.rows[0]!.cap.split('.');
    need(Number.isInteger(initialized.poolCapBps) && initialized.poolCapBps > 0 && initialized.poolCapBps <= 10000
      && BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0')) === BigInt(initialized.poolCapBps) * 10_000n,
    'final protected guardrail mismatch');
  }
  const sql = createLpPaperSqlStore(checkedRuntime);
  const service = createLpPaperService({ mode: input.mode, plan: input.plan, enqueue: input.enqueue,
    // Canonical service uses its ordinary production wall clock; protected record checks
    // and SQL admission lookups independently use clock_timestamp at final mutation.
    // No caller clock override may weaken either freshness boundary.
    protocol,
    master: { providerId: authorities.master.providerId, read: async eventId => {
      const event = await masterRead(eventId); if (!event) return null;
      need(event.chain === binding.chain && event.networkId === binding.networkId, 'master protected network mismatch');
      return approved('master', eventId, event);
    } },
    copyRisk: { providerId: authorities.risk.providerId, assess: async context => {
      need(context.userId === binding.userId, 'risk tenant mismatch');
      const risk = await riskAssess(lpSnapshot(context)); if (!risk) return null;
      return approved('risk', context.quote.intentHash, risk);
    } },
    store: { transaction: async (s, action) => sql.transaction(s, async tx => {
      const guarded: LpPaperTransaction = { ...tx,
        pending: async limit => {
          const pending = await tx.pending(limit), ownedPending: LpExactOperation[] = [];
          for (const op of pending) {
            const p = await tx.position(op.positionId);
            if (p?.userId === binding.userId && p.chain === binding.chain) ownedPending.push(op);
          }
          return ownedPending;
        },
        insertAcquisition: async commit => {
          await finalAuthority(tx);
          if (commit.origin) {
            const client = currentClient.getStore()!;
            const event = await protectedRecord<NonNullable<Awaited<ReturnType<typeof masterRead>>>>(client, 'master', commit.origin.eventId);
            same(lpExactHash(event), commit.origin.masterEvidenceHash, 'final protected master evidence mismatch');
            same(await protectedRecord(client, 'risk', commit.fingerprint), commit.origin.riskEvidence, 'final protected risk evidence mismatch');
          }
          const context: LpQuoteAdmissionContext = { kind: 'acquisition', commit: lpSnapshot(commit) };
          await writer.quote(s, lpAdmissionContextKey(context)); return tx.insertAcquisition(commit);
        },
        insertOperation: async commit => {
          await finalAuthority(tx);
          const context: LpQuoteAdmissionContext = { kind: 'operation', commit: lpSnapshot(commit) };
          await writer.quote(s, lpAdmissionContextKey(context)); return tx.insertOperation(commit);
        },
        settle: async (operation, position, receipt) => {
          await finalAuthority(tx);
          await writer.settlement(s, operation.id); return tx.settle(operation, position, receipt);
        }
      };
      return action(guarded);
    }) }
  });
  async function initialization(s: UserScope): Promise<LpOwnedInitialization> {
    owned(s);
    const expected = await checkedRuntime(scope, client => protectedRecord<LpOwnedInitialization>(client, 'initialization', initializationSelector));
    need(expected.subscription.userId === binding.userId && expected.subscription.chain === binding.chain
      && expected.subscription.status === 'active', 'protected initialization tenant/chain/status mismatch');
    const current = await sql.transaction(scope, tx => tx.subscription(expected.subscription.id));
    need(current, 'protected initialization SQL writer unavailable; externally initialized subscription required');
    same(current, expected.subscription, 'persisted exact initialization/revision mismatch');
    await checkedRuntime(scope, async client => {
      const result = await client.query<{ cap: string }>('SELECT max_pool_allocation_pct::text AS cap FROM public.lp_guardrail_configs WHERE user_id=$1 /* lp-owned:initialization */', [binding.userId]);
      need(result.rows.length === 1 && /^\d+(\.\d{1,6})?$/.test(result.rows[0]!.cap), 'protected initialized guardrail unavailable');
      const [whole, fraction = ''] = result.rows[0]!.cap.split('.');
      const micro = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
      need(Number.isInteger(expected.poolCapBps) && expected.poolCapBps > 0 && expected.poolCapBps <= 10000
        && micro === BigInt(expected.poolCapBps) * 10_000n, 'persisted exact protected guardrail mismatch');
    });
    return lpSnapshot(expected);
  }
  async function admission(s: UserScope): Promise<LpOwnedInitialization> {
    const initialized = await initialization(s);
    await checkedRuntime(scope, async client => {
      const secret = await protectedRecord<LpOwnedSecretAdmission>(client, 'secret', secretSelector);
      need(uuid.test(secret.secretAdmissionId) && secret.accountId === binding.accountId, 'distinct protected secret admission required');
      same(secret.actions, ['acquire','copy','rebalance','close','recover'], 'complete secret admission action scope mismatch');
    });
    return initialized;
  }
  async function position(s: UserScope, id: string): Promise<LpExactPosition | null> {
    owned(s); const p = await service.position(s, id);
    need(!p || p.chain === binding.chain, 'owned position chain mismatch'); return p;
  }
  return {
    initialization,
    acquire: async (s: UserScope, request: Parameters<typeof service.acquire>[1]) => {
      const captured = lpSnapshot(request); await admission(s);
      need(captured.chain === binding.chain, 'acquisition chain mismatch'); return service.acquire(s, captured);
    },
    copyMint: async (s: UserScope, request: Parameters<typeof service.copyMint>[1]) => {
      const captured = lpSnapshot(request), initialized = await admission(s);
      need(captured.subscriptionId === initialized.subscription.id, 'copy protected subscription mismatch'); return service.copyMint(s, captured);
    },
    requestOperation: async (s: UserScope, request: Parameters<typeof service.requestOperation>[1]) => {
      const captured = lpSnapshot(request); await admission(s);
      need(await position(s, captured.positionId), 'owned operation position unavailable'); return service.requestOperation(s, captured);
    },
    process: async (s: UserScope, request: Parameters<typeof service.process>[1]) => {
      const captured = lpSnapshot(request); await admission(s);
      need(captured.chain === binding.chain, 'processing chain mismatch');
      const operation = await service.operation(s, captured.operationId);
      need(operation && await position(s, operation.positionId), 'owned durable operation unavailable'); return service.process(s, captured);
    },
    recover: async (s: UserScope, limit = 100) => { await admission(s); return service.recover(s, limit); },
    position,
    operation: async (s: UserScope, id: string): Promise<LpExactOperation | null> => {
      owned(s); const op = await service.operation(s, id); if (op) await position(s, op.positionId); return op;
    },
    capabilities: () => ({ ...service.capabilities(), ownedCompositionSourceImplemented: true as const,
      protectedBackingInstalled: false as const, sourceComplete: false as const, sourceGaps: lpOwnedSourceGaps })
  };
}
export type OwnedLpPaperComposition = ReturnType<typeof createOwnedLpPaperComposition>;
