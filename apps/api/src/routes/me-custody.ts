import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { UserScope } from '@swat/db';
import type { CustodyEnrollment, CustodyEnrollmentInput } from '@swat/db/dist/custody-enrollment.js';
import { canonicalCustodyAccount, assertCustodyChainKind, custodyPolicyDigest, CustodyContractError } from '@swat/db/dist/custody-contract.js';
import { requireUser } from '../auth/plugin.js';

export const enrollmentRequestSchema = z.object({ chain: z.enum(['solana', 'polygon', 'robinhood-chain']),
  grantKind: z.enum(['solana_vault', 'polymarket_signer', 'eip7702', 'session_key_4337']),
  accountAddress: z.string().min(32).max(100), consentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  expectedRevision: z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/) }).strict();
export type EnrollmentRequest = z.infer<typeof enrollmentRequestSchema>;
export interface VerifiedEnrollmentContext {
  readonly userId: string; readonly chain: EnrollmentRequest['chain']; readonly grantKind: EnrollmentRequest['grantKind'];
  readonly accountAddress: string; readonly consentId: string; readonly revision: string;
  readonly deploymentId: string; readonly chainId: string;
  readonly linkedAccount: string; readonly proof: string; readonly validUntil: string; readonly policyDigest: string;
  readonly deploymentVerified: true;
  /** Supplied inside the approved service boundary, never from a public credential/body field. */
  readonly input: CustodyEnrollmentInput;
}
export interface MeCustodyPorts {
  readonly enrollment: CustodyEnrollment;
  readonly now: () => Date;
  readonly deploymentId: string;
  readonly chainIds: Readonly<Partial<Record<EnrollmentRequest['chain'], string>>>;
  /** Independently verifies current linked ownership + exact single-use consent + deployed mechanism.
   * Must hold/recheck them through commit, not return a caller-labelled/cached authorization.
   * Supplies already-authorized enrollment material; no credential acquisition/keygen/sign/unwrap in API.
   */
  readonly withVerifiedConsent: <T>(scope: UserScope, request: EnrollmentRequest,
    commit: (context: VerifiedEnrollmentContext) => Promise<T>) => Promise<T>;
}
export function enrollmentCapability(ports?: MeCustodyPorts) {
  return { contractVersion: 1, state: ports ? 'injected-local-record-only' : 'blocked-on-external-capability',
    localEnrollmentSupported: !!ports, enrollmentSupported: false, executionSupported: false,
    sourceImplemented: true, injectedPortsConfigured: !!ports, injectedVerified: false,
    runtimeAccepted: false, liveAccepted: false,
    unavailableReasons: ['approved-linked-consent-deployment-service-unaccepted', 'authorized-live-executor-unavailable'] };
}
export async function enrollMeCustody(request: FastifyRequest, reply: FastifyReply, ports?: MeCustodyPorts) {
  reply.header('Cache-Control', 'no-store');
  const scope = requireUser(request, reply); if (!scope) return;
  if (!ports) return reply.code(503).send({ code: 'CREDENTIAL_SEALING_UNAVAILABLE', credentialsRecorded: false,
    executionSupported: false, capability: enrollmentCapability(), message: 'Verified local enrollment is unavailable. No credential was acquired or grant created.' });
  const parsed = enrollmentRequestSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ code: 'INVALID_ENROLLMENT_REQUEST' });
  try {
    const body = Object.freeze({ ...parsed.data, accountAddress: canonicalCustodyAccount(parsed.data.chain, parsed.data.accountAddress) });
    const pinned = Object.freeze({ userId: scope.userId }) as UserScope;
    assertCustodyChainKind(body.chain, body.grantKind);
    let committed = false;
    let committedGrant: { id: string; chain: string; grantKind: string; accountAddress: string; status: string; hasSealedSecret: boolean; keyVersion: number | null; expiresAt: string | null } | undefined;
    await ports.withVerifiedConsent(pinned, body, async context => {
      if (committed) throw new CustodyContractError('custody-stale');
      committed = true;
      const input = context.input;
      const account = canonicalCustodyAccount(body.chain, context.accountAddress);
      if (context.userId !== pinned.userId || context.chain !== body.chain || context.grantKind !== body.grantKind || account !== body.accountAddress
        || context.consentId !== body.consentId || context.revision !== body.expectedRevision || context.deploymentVerified !== true
        || context.deploymentId !== ports.deploymentId || !context.chainId || context.chainId !== ports.chainIds[body.chain]
        || !context.linkedAccount || !context.proof || !Number.isFinite(ports.now().getTime()) || !(Date.parse(context.validUntil) > ports.now().getTime())
        || input.chain !== body.chain || input.grantKind !== body.grantKind
        || canonicalCustodyAccount(input.chain, input.accountAddress) !== body.accountAddress
        || custodyPolicyDigest(input.scopePolicy) !== context.policyDigest) throw new CustodyContractError('custody-stale');
      const secret = input.secret == null ? null : Uint8Array.from(input.secret);
      try {
        const grant = await ports.enrollment.enroll(pinned, { ...input, secret });
        if (grant.userId !== pinned.userId || grant.accountAddress !== body.accountAddress || grant.chain !== body.chain || grant.grantKind !== body.grantKind) {
          throw new CustodyContractError('custody-conflict');
        }
        // Never project scopePolicy, secret binding, ciphertext, credential identifiers or provider output.
        committedGrant = { id: grant.id, chain: grant.chain, grantKind: grant.grantKind, accountAddress: grant.accountAddress,
          status: grant.status, hasSealedSecret: grant.hasSealedSecret, keyVersion: grant.keyVersion,
          expiresAt: grant.expiresAt?.toISOString() ?? null };
        return committedGrant;
      } finally { secret?.fill(0); }
    });
    if (!committed || !committedGrant) throw new CustodyContractError('custody-unavailable');
    return reply.send({ grant: committedGrant, localOnly: true, executionSupported: false, capability: enrollmentCapability(ports),
      message: 'Local custody record created only. No deployed spending permission, funding address or live execution was enabled.' });
  } catch (error) {
    const code = error instanceof CustodyContractError ? error.code : 'custody-unavailable';
    return reply.code(code === 'custody-invalid' ? 400 : code === 'custody-unavailable' ? 503 : 409)
      .send({ code, executionSupported: false, message: 'Enrollment refused. No execution or financial completion is confirmed.' });
  }
}
export async function registerMeCustodyRoutes(app: FastifyInstance, ports?: MeCustodyPorts) {
  app.post('/v1/me/vault/enrollment', (request, reply) => enrollMeCustody(request, reply, ports));
}
