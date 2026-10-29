import type { Chain } from '@swat/shared';

/**
 * The `UserExecutionAuthority` port (checklist `S4-P7`, ADR-0003).
 *
 * ## Why this exists
 *
 * Three delegation mechanisms have nothing in common at the key level: an
 * ERC-4337 session key / EIP-7702 delegation on Robinhood Chain, a Solana
 * program delegate (a PDA owned by an Anchor program we have not written), and
 * whatever Polymarket resolves to — which per ADR-0003 §4.3 is *nothing*, the
 * venue exposes no scoped-signer facility at all. If any of those leaks into
 * `handleJob`, adding the second one means editing the money path.
 *
 * `solana-signer.ts` already proves the seam works for one chain: it is injected
 * into `createJupiterJitoRuntime` as `signTransaction` / `buildTipTransaction`,
 * so the runtime never learns where authority comes from. This module
 * generalises exactly that shape — a port with adapters behind it — to all
 * three chains and to both principals.
 *
 * ## The operator is an adapter, not a branch
 *
 * Today every trade executes from one operator account: `EVM_PRIVATE_KEY` on
 * Robinhood Chain and Polymarket, a funded Trojan wallet plus
 * `SOLANA_PRIVATE_KEY` on Solana. That is **one adapter among the six**, chosen
 * by `serves(principal)` like any other. There is deliberately no
 * `if (principal.kind === 'operator')` anywhere outside an adapter: the moment
 * operator-ness is a branch in the executor, per-user authority has to be
 * threaded past it, and the shortest patch to make a user's trade work is to
 * fall through to the operator's keys.
 *
 * ## Fail closed, with a code that says which mechanism is missing
 *
 * A denial is never a fallback. `authorize` returns a verdict, and the only two
 * shapes are `granted` (with signing capability) and `denied` (with a stable
 * code). A per-user request on a chain whose delegation mechanism is unbuilt
 * gets `authority-solana-delegate-unavailable` or
 * `authority-evm-session-key-unavailable` — never the operator's grant. Signing
 * a user's trade with the operator's key is the worst failure mode of this
 * refactor: it would be undetectable from the outside, since the trade fills.
 *
 * Codes are split by *what an operator should go and look at*, following
 * `solana-simulation.ts`, which keeps `refuse` and `unavailable` on separate
 * codes so nobody debugs a route that is fine. "Not built yet" (Solana,
 * Robinhood Chain) and "cannot exist on this venue" (Polymarket) are therefore
 * different codes, because the first is a scheduling answer and the second is an
 * architectural one.
 *
 * ## Nothing here touches a key
 *
 * This file has no crypto, no RPC, no `process.env`, and no `@swat/db` import.
 * It is the vocabulary and the routing rule. Key material lives only inside the
 * adapters, and only inside a closure there.
 */

/**
 * Whose funds a job moves.
 *
 * Deliberately a union rather than a nullable user id: `{ kind: 'operator' }` is
 * a real principal with a real adapter, not the absence of a user. A nullable
 * field invites `userId ?? operator`, which is the silent fallback this port
 * exists to make impossible.
 */
export type ExecutionPrincipal =
  | { readonly kind: 'operator' }
  | { readonly kind: 'user'; readonly userId: string };

/** Stable label for a principal, for logs and reason strings. Never a key. */
export function describePrincipal(principal: ExecutionPrincipal): string {
  return principal.kind === 'operator' ? 'operator' : `user:${principal.userId}`;
}

/**
 * What is being authorized, named by venue effect rather than by key operation.
 *
 * `token-spend-permission` covers both the legacy ERC-20 `approve` and the
 * Permit2 permit that replaces it (`S4-M13`). That is the point: under Permit2
 * the permission is an EIP-712 **signature**, not a transaction, and an
 * interface that could only express "sign and send a transaction" would force
 * Permit2 to special-case around the port. The action stays the same; only the
 * `AuthoritySigningRequest` the adapter is handed changes.
 */
export type VenueActionKind =
  /** A swap or CLOB order that moves the principal's funds on a venue. */
  | 'venue-trade'
  /** An allowance or Permit2 permit that lets a venue contract pull tokens. */
  | 'token-spend-permission'
  /** Claiming collateral from a resolved position (Polymarket redemption). */
  | 'position-redemption';

export interface ExecutionAuthorityRequest {
  readonly chain: Chain;
  readonly principal: ExecutionPrincipal;
  readonly action: VenueActionKind;
  readonly direction?: 'buy' | 'sell';
  /**
   * Venue instrument the action targets — a token mint, an ERC-20 address, a
   * Polymarket `tokenID`. Opaque here; an adapter with a scoped grant checks it
   * against the grant's allowlist (ADR-0003 §2.1: the scope is an
   * argument-checked allowlist, not a `(target, selector)` pair).
   */
  readonly instrument?: string;
}

/**
 * What can be asked of a granted authority *through this port*.
 *
 * `venue-managed-submission` is the honest description of every route where the
 * bytes never pass through here: the Trojan webhook, where a third party holds
 * the key entirely; the viem wallet client inside `robinhood.ts`; the Polymarket
 * secure client, which signs each `Order` struct itself. Those routes have real
 * authority — they just do not expose it as "hand me bytes and I will sign
 * them". Claiming `sign-chain-transaction` for them would be a lie a Permit2
 * caller could act on.
 */
export type AuthorityCapability =
  /** Will sign transaction bytes handed to it (the Jupiter + Jito route). */
  | 'sign-chain-transaction'
  /** Will produce an EIP-712 signature (Permit2 permit, Polymarket Order). */
  | 'sign-typed-data'
  /** Submits through its own venue client; signing is not exposed here. */
  | 'venue-managed-submission';

/**
 * An EIP-712 payload, structurally what `viem`'s `signTypedData` and ethers'
 * `_signTypedData` both take.
 *
 * Declared locally rather than imported from `viem` so this port stays free of
 * any chain library: the Solana adapters must be able to implement the interface
 * without pulling EVM types into their module graph.
 */
export interface Eip712TypedData {
  readonly domain: {
    readonly name?: string;
    readonly version?: string;
    readonly chainId?: number;
    readonly verifyingContract?: string;
    readonly salt?: string;
  };
  readonly types: Readonly<
    Record<string, readonly { readonly name: string; readonly type: string }[]>
  >;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
}

export type AuthoritySigningRequest =
  /** A built, possibly partially-signed Solana versioned transaction, base64. */
  | { readonly kind: 'solana-transaction'; readonly transactionBase64: string }
  /** A Jito tip transfer the authority builds and signs itself. */
  | {
      readonly kind: 'solana-tip-transfer';
      readonly tipAccount: string;
      readonly lamports: number;
    }
  /** An EIP-712 payload: a Permit2 permit (`S4-M13`) or a Polymarket Order. */
  | { readonly kind: 'eip712-typed-data'; readonly typedData: Eip712TypedData };

export type AuthoritySigningResult =
  | {
      readonly kind: 'signed';
      /** `base64` for a serialised Solana transaction, `hex` for a signature. */
      readonly encoding: 'base64' | 'hex';
      readonly value: string;
    }
  | {
      readonly kind: 'refused';
      readonly code: ExecutionAuthorityDenialCode;
      readonly reason: string;
    };

/**
 * Every way authorization can fail. Stable strings — they reach skip reasons,
 * `copy_executions.reason`, and operator alerts, so they are part of the
 * contract and must not be reworded in place.
 *
 * Grouped by what an operator should do about it.
 */
export type ExecutionAuthorityDenialCode =
  // ── Wiring ────────────────────────────────────────────────────────────────
  /** No adapter is registered for this chain and principal kind. */
  | 'authority-adapter-missing'
  /**
   * An adapter was handed a principal it does not serve. Fail closed rather
   * than proceed: this is the guard that makes "the operator adapter silently
   * satisfied a user's request" a test failure instead of a filled trade.
   */
  | 'authority-principal-mismatch'
  /** The adapter does not cover the requested chain. */
  | 'authority-chain-mismatch'
  // ── Operator adapter ─────────────────────────────────────────────────────
  /**
   * The operator's own secret or address is absent: no `EVM_PRIVATE_KEY`, no
   * `TROJAN_WALLET_ADDRESS`. Replaces the three bare
   * `EVM_PRIVATE_KEY is required for canonical … execution` throws that used to
   * live in `resolveLiveCopyTargetAccount`.
   */
  | 'authority-operator-not-configured'
  // ── Per-user adapters: mechanism does not exist yet ──────────────────────
  /**
   * Robinhood Chain, per user. The 4337 session key / EIP-7702 delegation is
   * buildable today (ADR-0003 §2 — EntryPoint, bundler and paymaster all exist
   * on chain 4663) but is not built: `S4-7`'s `user_execution_grants` table and
   * `S4-2`'s grant issuance are both unbuilt. Scheduling answer.
   */
  | 'authority-evm-session-key-unavailable'
  /**
   * Solana, per user. Needs the Anchor delegate program of ADR-0003 §3 plus its
   * external audit — "the long pole of the whole architecture" (`S4-P12`).
   * Native SPL `approve` is not a substitute: a delegate may transfer to any
   * destination, so it bounds how much and never to whom. Scheduling answer,
   * with a much longer schedule.
   */
  | 'authority-solana-delegate-unavailable'
  /**
   * Polymarket, per user. Architectural, not scheduling: ADR-0003 §4.3 settles
   * that no primitive equivalent to a session key or a PDA delegate exists on
   * this venue. Order placement needs the account signer's key, L2 credentials
   * authenticate the HTTP request only, and Builder credentials are an
   * integration identity — "each wallet remains controlled by its signer".
   * Unblocking this means accepting the fork-(b) venue-scoped custodial
   * exception (`S4-P13`), which is a decision, not an implementation.
   */
  | 'authority-polymarket-delegation-unsupported'
  // ── Session key / Grant lifecycle (S4-P9) ─────────────────────────────────
  /** The user's execution authority grant has expired/lapsed. */
  | 'authority-grant-expired'
  /** The user's execution authority grant was revoked. */
  | 'authority-grant-revoked'
  /** No execution authority grant was found for this user and chain. */
  | 'authority-grant-missing'
  // ── Paymaster budget / rate limits (S4-P8) ─────────────────────────────────
  /** User exceeded daily sponsored UserOperation cap. */
  | 'authority-paymaster-user-rate-limited'
  /** Global daily sponsored UserOperation budget exhausted. */
  | 'authority-paymaster-global-budget-exhausted'
  // ── Granted, but not for this ───────────────────────────────────────────
  /** The grant exists but cannot perform this action or signing shape. */
  | 'authority-capability-unsupported'
  /** The signer threw. Distinct from a refusal: the mechanism is present. */
  | 'authority-signing-failed';

/**
 * A live authorization. Carries addresses and a signing capability — never key
 * material, and never anything the caller can extract a key from.
 */
export interface GrantedExecutionAuthority {
  /** Which adapter issued this, for logs and for the wiring assertions. */
  readonly adapterId: string;
  readonly chain: Chain;
  readonly principal: ExecutionPrincipal;
  /**
   * The account the venue debits: `copy_executions.target_account`, the balance
   * the sizing reads, and the key the EVM nonce lock serialises on.
   */
  readonly settlementAddress: string;
  /**
   * The address whose signature authorizes the action, when we hold one.
   *
   * `null` on a venue-managed route (Trojan), where the key is not ours.
   * Separate from `settlementAddress` because every delegation mechanism this
   * port exists for separates them: a 4337 session key is not the smart
   * account, a PDA delegate is not the owner, and Polymarket `signatureType`
   * 1 and 2 split `signer_address` from `maker_address` outright.
   */
  readonly signingAddress: string | null;
  readonly capabilities: readonly AuthorityCapability[];
  /**
   * When the grant lapses, or `null` for one that does not.
   *
   * The operator's key never expires; a session key always does, and ADR-0003
   * §8 makes that a liveness dependency (`S4-P9`). Nothing reads this yet —
   * expiry monitoring is `S4-P9`'s — but a grant that cannot state its own
   * expiry cannot be monitored, and adding the field later means revisiting
   * every adapter.
   */
  readonly expiresAt: Date | null;
  sign(request: AuthoritySigningRequest): Promise<AuthoritySigningResult>;
}

export type ExecutionAuthorityVerdict =
  | { readonly kind: 'granted'; readonly authority: GrantedExecutionAuthority }
  | {
      readonly kind: 'denied';
      readonly code: ExecutionAuthorityDenialCode;
      readonly reason: string;
    };

/**
 * One adapter: one chain, one class of principal, one delegation mechanism.
 *
 * `serves` is on the port rather than in the registry so that adding a
 * mechanism never edits the routing rule. The operator adapters answer
 * `principal.kind === 'operator'`; the per-user adapters answer `'user'`.
 */
export interface UserExecutionAuthority {
  /** Stable identifier, e.g. `operator-solana`. Appears in reasons and logs. */
  readonly id: string;
  readonly chain: Chain;
  serves(principal: ExecutionPrincipal): boolean;
  authorize(request: ExecutionAuthorityRequest): Promise<ExecutionAuthorityVerdict>;
}

/**
 * The single function the executor holds. Injected, so a test substitutes a
 * stub authority without the executor knowing (`S4-P7`'s own acceptance test).
 */
export type ExecutionAuthorityResolver = (
  request: ExecutionAuthorityRequest
) => Promise<ExecutionAuthorityVerdict>;

export function denied(
  code: ExecutionAuthorityDenialCode,
  reason: string
): ExecutionAuthorityVerdict {
  return { kind: 'denied', code, reason };
}

/**
 * Wraps one adapter so it can never answer for a principal or chain it does not
 * serve, whatever its own `authorize` does.
 *
 * The guard lives here, above every adapter, on purpose. An adapter that
 * forgets to check `serves` is a plausible bug; this makes the resulting failure
 * a denial with `authority-principal-mismatch` rather than a trade signed with
 * the wrong key.
 */
function authorizeThrough(
  adapter: UserExecutionAuthority,
  request: ExecutionAuthorityRequest
): Promise<ExecutionAuthorityVerdict> {
  if (adapter.chain !== request.chain) {
    return Promise.resolve(denied(
      'authority-chain-mismatch',
      `${adapter.id} serves ${adapter.chain}, not ${request.chain}`
    ));
  }
  if (!adapter.serves(request.principal)) {
    return Promise.resolve(denied(
      'authority-principal-mismatch',
      `${adapter.id} does not serve ${describePrincipal(request.principal)}`
    ));
  }
  return adapter.authorize(request).then((verdict) => {
    if (verdict.kind !== 'granted') return verdict;
    // Second half of the same guard, on the way out. An adapter that serves
    // operator requests must not hand back a grant stamped with a user
    // principal, and vice versa — that mismatch is what a silent fallback to
    // the operator's authority would look like from here.
    if (verdict.authority.principal.kind !== request.principal.kind) {
      return denied(
        'authority-principal-mismatch',
        `${adapter.id} issued a ${verdict.authority.principal.kind} grant for `
        + `${describePrincipal(request.principal)}`
      );
    }
    if (
      request.principal.kind === 'user'
      && verdict.authority.principal.kind === 'user'
      && verdict.authority.principal.userId !== request.principal.userId
    ) {
      return denied(
        'authority-principal-mismatch',
        `${adapter.id} issued a grant for a different user than ${request.principal.userId}`
      );
    }
    if (verdict.authority.chain !== request.chain) {
      return denied(
        'authority-chain-mismatch',
        `${adapter.id} issued a ${verdict.authority.chain} grant for ${request.chain}`
      );
    }
    return verdict;
  });
}

/**
 * Routes a request to the one adapter that serves it.
 *
 * The rule is uniform: first registered adapter whose chain matches and whose
 * `serves` accepts the principal. The operator adapters are entries in the same
 * list as the per-user ones, so "operator" is a registration, not a code path.
 */
export function createExecutionAuthorityRegistry(
  adapters: readonly UserExecutionAuthority[]
): ExecutionAuthorityResolver {
  return async (request) => {
    const adapter = adapters.find(
      (candidate) => candidate.chain === request.chain && candidate.serves(request.principal)
    );
    if (!adapter) {
      return denied(
        'authority-adapter-missing',
        `No execution authority adapter serves ${describePrincipal(request.principal)} `
        + `on ${request.chain}`
      );
    }
    return authorizeThrough(adapter, request);
  };
}

/**
 * Whether a grant can carry out a signing shape, checked before it is asked.
 *
 * Exported because the adapters and the Permit2 caller both need the same
 * answer, and two copies of this mapping would drift.
 */
export function capabilityForSigningRequest(
  request: AuthoritySigningRequest
): AuthorityCapability {
  return request.kind === 'eip712-typed-data'
    ? 'sign-typed-data'
    : 'sign-chain-transaction';
}
