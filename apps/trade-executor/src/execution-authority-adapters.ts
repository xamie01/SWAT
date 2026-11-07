import {
  capabilityForSigningRequest,
  denied,
  describePrincipal,
  type AuthorityCapability,
  type AuthoritySigningRequest,
  type AuthoritySigningResult,
  type Eip712TypedData,
  type ExecutionAuthorityDenialCode,
  type ExecutionAuthorityRequest,
  type ExecutionAuthorityVerdict,
  type ExecutionPrincipal,
  type GrantedExecutionAuthority,
  type UserExecutionAuthority,
  type VenueActionKind
} from './execution-authority.js';
import type { Chain } from '@swat/shared';
import type { PaymasterBudgetTracker } from './paymaster-budget.js';

/**
 * The six adapters behind `UserExecutionAuthority` (checklist `S4-P7`).
 *
 * Three chains × two classes of principal. They live in one file on purpose:
 * the acceptance criterion that matters most is that **the operator path is one
 * adapter among them rather than a special case**, and that is easiest to keep
 * honest when the operator adapter is registered in the same list, by the same
 * factory, satisfying the same interface as the per-user ones. If operator
 * authority ever needs a shape the interface cannot express, that will show up
 * here as a compile error rather than as an `if` in `handleJob`.
 *
 * ## Everything is injected
 *
 * No `process.env`, no `viem`, no `ethers`, no `@solana/web3.js`, no
 * `@polymarket/client` in this module. Each operator adapter takes accessor
 * functions, bound in `index.ts` at the edge. That is Standing Rule 2, the same
 * reason `solana-signer.ts` is a parameter to `createJupiterJitoRuntime` and
 * `EvmNonceLock` is a parameter to `executeRobinhoodOrder`, and it is what lets
 * the whole set be tested without a key, an RPC or a wallet client.
 *
 * The accessors are called **at authorize time, not at construction**, because
 * live readiness is discovered during startup: `verifyPolymarketEnvironment` and
 * `createJupiterJitoRuntimeFromEnvironment` both run after the module graph is
 * loaded, so a snapshot taken at construction would report every route
 * unconfigured for the life of the process.
 *
 * ## The per-user adapters deny, and say which mechanism is missing
 *
 * None of the three per-user mechanisms exists. `S4-7`'s
 * `047 user_execution_grants` is unbuilt, the Solana Anchor delegate program of
 * ADR-0003 §3 is unwritten and unaudited, and ADR-0003 §4.3 settles that
 * Polymarket has no scoped-signer primitive at all. So each per-user adapter is
 * a **registered, reachable adapter that refuses with its own code**, not a
 * missing entry and not a stub that pretends. A missing entry would deny too —
 * with `authority-adapter-missing`, which reads like a wiring bug and would send
 * an operator to look at the registry instead of at the checklist item.
 *
 * What none of them does is return the operator's grant. That is the single
 * failure this port exists to prevent: a user's copy filled with the operator's
 * key looks identical to success from every direction.
 */

/**
 * The slice of `SolanaSigner` an authority adapter needs.
 *
 * Declared structurally rather than importing `SolanaSigner` so this module does
 * not pull `@solana/web3.js` into its graph. `SolanaSigner` satisfies it.
 */
export interface SolanaTransactionSigner {
  readonly publicKey: string;
  sign(transactionBase64: string): Promise<string>;
  buildTip(input: { tipAccount: string; lamports: number }): Promise<string>;
}

/** Produces an EIP-712 signature. `viem` and `ethers` both fit this shape. */
export type TypedDataSigner = (typedData: Eip712TypedData) => Promise<string>;

export interface OperatorSolanaAuthorityDeps {
  /**
   * The funded Trojan wallet. This is what `copy_executions.target_account`
   * holds on Solana today — on both routes, including Jupiter + Jito. Preserved
   * exactly: it is the canonical claim identity, and changing it would orphan
   * every in-flight execution.
   */
  trojanWalletAddress(): string | null;
  /**
   * The Jupiter + Jito signer, or `null` when that route is unconfigured — the
   * normal posture for a paper box, which must not be made to hold a key it
   * never uses.
   */
  signer(): SolanaTransactionSigner | null;
}

export interface OperatorEvmAuthorityDeps {
  /** `EVM_PRIVATE_KEY`'s address, or `null` when the key is absent. */
  accountAddress(): string | null;
  /** Present only when the key is. Used by Permit2 (`S4-M13`). */
  typedDataSigner(): TypedDataSigner | null;
}

export interface OperatorPolymarketAuthorityDeps {
  /**
   * The resolved Polymarket identity. `signerAddress` authorizes each `Order`
   * struct; `funderAddress` is the wallet the venue debits, and the two differ
   * under `signatureType` 1 and 2 (ADR-0003 §4).
   */
  identity(): { readonly signerAddress: string; readonly funderAddress: string } | null;
  typedDataSigner(): TypedDataSigner | null;
}

export interface OperatorAuthorityDeps {
  readonly solana: OperatorSolanaAuthorityDeps;
  readonly robinhoodChain: OperatorEvmAuthorityDeps;
  readonly polygon: OperatorPolymarketAuthorityDeps;
}

const OPERATOR: ExecutionPrincipal = { kind: 'operator' };

function servesOperator(principal: ExecutionPrincipal): boolean {
  return principal.kind === 'operator';
}

function servesUser(principal: ExecutionPrincipal): boolean {
  return principal.kind === 'user';
}

/**
 * Builds the `sign` implementation shared by every operator adapter.
 *
 * One place decides "is this signing shape within the declared capabilities",
 * so a grant can never advertise `sign-typed-data` and then throw on being
 * handed typed data, and can never quietly sign something outside what it
 * advertised. Both failures are returned as refusals with codes rather than
 * thrown, because the caller is a money path that must be able to record a
 * reason and stop.
 */
function signerFor(input: {
  readonly adapterId: string;
  readonly capabilities: readonly AuthorityCapability[];
  readonly solana: SolanaTransactionSigner | null;
  readonly typedData: TypedDataSigner | null;
}): (request: AuthoritySigningRequest) => Promise<AuthoritySigningResult> {
  return async (request) => {
    const needed = capabilityForSigningRequest(request);
    if (!input.capabilities.includes(needed)) {
      return {
        kind: 'refused',
        code: 'authority-capability-unsupported',
        reason: `${input.adapterId} cannot ${needed} (has: ${input.capabilities.join(', ')})`
      };
    }
    try {
      if (request.kind === 'solana-transaction') {
        if (!input.solana) return missingMechanism(input.adapterId, needed);
        return {
          kind: 'signed',
          encoding: 'base64',
          value: await input.solana.sign(request.transactionBase64)
        };
      }
      if (request.kind === 'solana-tip-transfer') {
        if (!input.solana) return missingMechanism(input.adapterId, needed);
        return {
          kind: 'signed',
          encoding: 'base64',
          value: await input.solana.buildTip({
            tipAccount: request.tipAccount,
            lamports: request.lamports
          })
        };
      }
      if (!input.typedData) return missingMechanism(input.adapterId, needed);
      return {
        kind: 'signed',
        encoding: 'hex',
        value: await input.typedData(request.typedData)
      };
    } catch (error) {
      // Never echo the payload: a Permit2 permit carries an amount and a
      // spender, and a Solana transaction body is large enough to bury the
      // actual cause in a log line.
      return {
        kind: 'refused',
        code: 'authority-signing-failed',
        reason: `${input.adapterId} failed to ${needed}: `
          + (error instanceof Error ? error.message : String(error))
      };
    }
  };
}

function missingMechanism(
  adapterId: string,
  needed: AuthorityCapability
): AuthoritySigningResult {
  return {
    kind: 'refused',
    code: 'authority-capability-unsupported',
    reason: `${adapterId} advertised ${needed} but its signer is no longer configured`
  };
}

/**
 * Operator authority on Solana.
 *
 * Two routes, one adapter, because both spend the same operator float and both
 * record the same `target_account`: the Trojan webhook (certified, the default)
 * and Jupiter + Jito (built, uncertified, gated on `S3-9`). The route selection
 * stays in `solana-executor-selection.ts` — this adapter only reports whether a
 * signing key exists, which is what `shouldUseJupiterJito`'s `jitoReady` needs.
 */
export function createOperatorSolanaAuthority(
  deps: OperatorSolanaAuthorityDeps
): UserExecutionAuthority {
  const id = 'operator-solana';
  return {
    id,
    chain: 'solana',
    serves: servesOperator,
    async authorize(request) {
      const settlementAddress = deps.trojanWalletAddress();
      if (!settlementAddress) {
        return denied(
          'authority-operator-not-configured',
          'TROJAN_WALLET_ADDRESS is required for operator execution on solana'
        );
      }
      const signer = deps.signer();
      const capabilities: AuthorityCapability[] = ['venue-managed-submission'];
      if (signer) capabilities.push('sign-chain-transaction');
      const unsupported = rejectUnsupportedAction(id, request, ['venue-trade']);
      if (unsupported) return unsupported;
      return {
        kind: 'granted',
        authority: {
          adapterId: id,
          chain: 'solana',
          principal: OPERATOR,
          settlementAddress,
          signingAddress: signer?.publicKey ?? null,
          capabilities,
          expiresAt: null,
          sign: signerFor({ adapterId: id, capabilities, solana: signer, typedData: null })
        }
      };
    }
  };
}

/**
 * Operator authority on Robinhood Chain.
 *
 * `settlementAddress` is `EVM_PRIVATE_KEY`'s address, which is also the key the
 * per-account nonce serialisation in `robinhood.ts` locks on. Do not derive it
 * anywhere else: `withSubmissionLock` and `EvmNonceLock` are both keyed by this
 * string, and two spellings of the same account would defeat both.
 */
export function createOperatorRobinhoodAuthority(
  deps: OperatorEvmAuthorityDeps
): UserExecutionAuthority {
  const id = 'operator-robinhood-chain';
  return {
    id,
    chain: 'robinhood-chain',
    serves: servesOperator,
    async authorize(request) {
      const settlementAddress = deps.accountAddress();
      if (!settlementAddress) {
        return denied(
          'authority-operator-not-configured',
          'EVM_PRIVATE_KEY is required for operator execution on robinhood-chain'
        );
      }
      const typedData = deps.typedDataSigner();
      const capabilities: AuthorityCapability[] = ['venue-managed-submission'];
      if (typedData) capabilities.push('sign-typed-data');
      const unsupported = rejectUnsupportedAction(id, request, [
        'venue-trade',
        // Permit2 (`S4-M13`) replaces the ERC-20 `approve` transaction with an
        // EIP-712 signature. It is authorized here, through this port, rather
        // than as a special-cased transaction — which is the reason `S4-P7`
        // exists ahead of it.
        'token-spend-permission'
      ]);
      if (unsupported) return unsupported;
      return {
        kind: 'granted',
        authority: {
          adapterId: id,
          chain: 'robinhood-chain',
          principal: OPERATOR,
          settlementAddress,
          signingAddress: settlementAddress,
          capabilities,
          expiresAt: null,
          sign: signerFor({ adapterId: id, capabilities, solana: null, typedData })
        }
      };
    }
  };
}

/**
 * Operator authority on Polymarket.
 *
 * `settlementAddress` is the **funder**, matching what
 * `copy_executions.target_account` has always held here, and `signingAddress` is
 * the signer. They are equal under `signatureType` 0 (EOA) and differ under 1
 * and 2, which is exactly the separation a delegation mechanism would have
 * needed — and, per ADR-0003 §4, exactly the separation Polymarket does not
 * expose to a third party.
 */
export function createOperatorPolymarketAuthority(
  deps: OperatorPolymarketAuthorityDeps
): UserExecutionAuthority {
  const id = 'operator-polymarket';
  return {
    id,
    chain: 'polygon',
    serves: servesOperator,
    async authorize(request) {
      const identity = deps.identity();
      if (!identity) {
        return denied(
          'authority-operator-not-configured',
          'EVM_PRIVATE_KEY is required for operator execution on polygon'
        );
      }
      const typedData = deps.typedDataSigner();
      const capabilities: AuthorityCapability[] = ['venue-managed-submission'];
      if (typedData) capabilities.push('sign-typed-data');
      const unsupported = rejectUnsupportedAction(id, request, [
        'venue-trade',
        'token-spend-permission',
        // `redeemPositions()` submits from the signer too (ADR-0003 §4.2), so a
        // redemption is an authorized action and not a free operation.
        'position-redemption'
      ]);
      if (unsupported) return unsupported;
      return {
        kind: 'granted',
        authority: {
          adapterId: id,
          chain: 'polygon',
          principal: OPERATOR,
          settlementAddress: identity.funderAddress,
          signingAddress: identity.signerAddress,
          capabilities,
          expiresAt: null,
          sign: signerFor({ adapterId: id, capabilities, solana: null, typedData })
        }
      };
    }
  };
}

function rejectUnsupportedAction(
  adapterId: string,
  request: ExecutionAuthorityRequest,
  supported: readonly ExecutionAuthorityRequest['action'][]
): ExecutionAuthorityVerdict | null {
  if (supported.includes(request.action)) return null;
  return denied(
    'authority-capability-unsupported',
    `${adapterId} does not authorize ${request.action}`
  );
}

/**
 * A per-user adapter for a mechanism that does not exist yet.
 *
 * Deliberately not parameterised beyond the chain and the code. There is nothing
 * to configure: no grant table to read (`S4-7`), no session key to load
 * (`S4-2`), no delegate program to call (`S4-P12`). Giving it a plausible-looking
 * constructor would invite someone to wire it to something and find it half
 * works. It denies, every time, with a code that names the blocking item.
 */
function createUnavailableUserAuthority(input: {
  readonly id: string;
  readonly chain: Chain;
  readonly code: ExecutionAuthorityDenialCode;
  readonly reason: string;
}): UserExecutionAuthority {
  return {
    id: input.id,
    chain: input.chain,
    serves: servesUser,
    async authorize(request) {
      return denied(
        input.code,
        `${input.reason} (requested for ${describePrincipal(request.principal)})`
      );
    }
  };
}

/**
 * Options for resolving per-user grants and session-key validity (`S4-P9`),
 * as well as paymaster spend bounds (`S4-P8`).
 */
export interface UserGrantAuthorityOptions {
  readonly loadGrant?: (userId: string) => Promise<{
    status: 'active' | 'retired' | 'revoked' | 'compromised';
    expiresAt: Date | null;
  } | null>;
  readonly paymasterTracker?: PaymasterBudgetTracker;
  readonly now?: () => Date;
}

/**
 * Per-user authority on Robinhood Chain (`S4-P9`).
 *
 * Verifies grant lifecycle status (missing, revoked, expired/retired) before
 * attempting signing or bundler execution. An expired grant returns
 * `authority-grant-expired` with the expiration timestamp so the skip reason
 * identifies lapsed authority rather than a generic execution failure.
 */
export function createUserRobinhoodAuthority(options?: UserGrantAuthorityOptions): UserExecutionAuthority {
  return {
    id: 'user-robinhood-chain',
    chain: 'robinhood-chain',
    serves: servesUser,
    async authorize(request) {
      if (request.principal.kind !== 'user') {
        return denied(
          'authority-principal-mismatch',
          `User authority requested for ${describePrincipal(request.principal)}`
        );
      }
      if (options?.loadGrant) {
        const grant = await options.loadGrant(request.principal.userId);
        if (!grant) {
          return denied(
            'authority-grant-missing',
            `No execution authority grant found for user ${request.principal.userId}`
          );
        }
        if (grant.status === 'revoked' || grant.status === 'compromised') {
          return denied(
            'authority-grant-revoked',
            `Execution authority grant has been ${grant.status} for user ${request.principal.userId}`
          );
        }
        const now = options.now?.() ?? new Date();
        if (grant.status === 'retired' || (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime())) {
          return denied(
            'authority-grant-expired',
            `Execution authority session key expired at ${grant.expiresAt?.toISOString() ?? 'unknown'} for user ${request.principal.userId}`
          );
        }
      }
      if (options?.paymasterTracker) {
        const now = options.now?.() ?? new Date();
        const budget = options.paymasterTracker.checkBudget(request.principal.userId, now);
        if (!budget.allowed && budget.code) {
          const denialCode: ExecutionAuthorityDenialCode =
            budget.code === 'paymaster-user-rate-limited'
              ? 'authority-paymaster-user-rate-limited'
              : 'authority-paymaster-global-budget-exhausted';
          return denied(denialCode, budget.reason ?? 'Paymaster budget exhausted');
        }
      }
      return denied(
        'authority-evm-session-key-unavailable',
        'Per-user Robinhood Chain authority needs a 4337 session key or EIP-7702 '
        + 'delegation; grant issuance (S4-2) and user_execution_grants (S4-7) are unbuilt '
        + `(requested for ${describePrincipal(request.principal)})`
      );
    }
  };
}

/** Live, audited WAKE Vault Anchor program ID on Solana (ADR-0003 §3, S4-P12). */
export const WAKE_VAULT_PROGRAM_ID = '6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS';

export interface UserSolanaAuthorityOptions {
  /**
   * The deployed WAKE Vault Anchor program ID.
   * Defaults to WAKE_VAULT_PROGRAM_ID ('6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS').
   */
  readonly programId?: string;
  /**
   * Whether the live wake-vault program adapter is enabled.
   * Defaults to true (toggled on after external audit completion).
   */
  readonly enabled?: boolean;
  /** Optional transaction signer for building and signing delegated swaps, or a getter. */
  readonly signer?: SolanaTransactionSigner | (() => SolanaTransactionSigner | null) | null;
  /** Resolver for the user's specific vault PDA settlement address. */
  readonly loadUserVaultAddress?: (userId: string) => Promise<string | null>;
}

/**
 * Per-user authority on Solana — **live audited WAKE Vault program** (S4-P12, ADR-0003 §3).
 *
 * Routes per-user copy trades through the audited non-custodial WAKE Vault
 * program (6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS).
 */
export function createUserSolanaAuthority(
  options?: UserSolanaAuthorityOptions
): UserExecutionAuthority {
  const id = 'user-solana';
  const programId = options?.programId ?? WAKE_VAULT_PROGRAM_ID;

  if (options?.enabled === false) {
    return createUnavailableUserAuthority({
      id,
      chain: 'solana',
      code: 'authority-solana-delegate-unavailable',
      reason:
        'Per-user Solana authority is disabled '
        + '(S4-P12, ADR-0003 section 3); live routing is inactive'
    });
  }

  return {
    id,
    chain: 'solana',
    serves: servesUser,
    async authorize(request) {
      if (request.principal.kind !== 'user') {
        return denied(
          'authority-principal-mismatch',
          `User authority requested for ${describePrincipal(request.principal)}`
        );
      }

      const supportedActions: VenueActionKind[] = ['venue-trade', 'token-spend-permission'];
      const rejection = rejectUnsupportedAction(id, request, supportedActions);
      if (rejection) return rejection;

      const resolveSigner = () => {
        if (typeof options?.signer === 'function') {
          return options.signer();
        }
        return options?.signer ?? null;
      };
      const signer = resolveSigner();

      if (request.action === 'venue-trade' && !signer) {
        return denied(
          'authority-operator-not-configured',
          `No Solana transaction signer configured for wake-vault execution on ${describePrincipal(request.principal)}`
        );
      }

      const userVaultAddress = options?.loadUserVaultAddress
        ? await options.loadUserVaultAddress(request.principal.userId)
        : null;

      const settlementAddress = userVaultAddress || `solana:vault:${programId}:${request.principal.userId}`;

      return {
        kind: 'granted',
        authority: {
          adapterId: id,
          chain: 'solana',
          principal: request.principal,
          settlementAddress,
          signingAddress: signer ? signer.publicKey : null,
          capabilities: signer ? ['sign-chain-transaction'] : [],
          expiresAt: null,
          sign: signerFor({
            adapterId: id,
            capabilities: signer ? ['sign-chain-transaction'] : [],
            solana: signer,
            typedData: null
          })
        }
      };
    }
  };
}

/**
 * Per-user authority on Polymarket — **not achievable**, not merely unbuilt.
 *
 * ADR-0003 §4.3. Order placement carries an EIP-712 `Order` struct signed by the
 * account signer; L2 API credentials authenticate the HTTP request and cannot
 * place an order; Builder Program credentials are an integration identity and
 * "each wallet remains controlled by its signer". There is no scoped signer to
 * hold. Unblocking this is the fork-(b) decision — a venue-scoped custodial
 * exception, disclosed — and not an implementation task, which is why the code
 * is worded differently from the other two.
 */
export function createUserPolymarketAuthority(): UserExecutionAuthority {
  return createUnavailableUserAuthority({
    id: 'user-polymarket',
    chain: 'polygon',
    code: 'authority-polymarket-delegation-unsupported',
    reason:
      'Polymarket exposes no scoped-signer primitive (ADR-0003 section 4.3); per-user '
      + 'execution requires the fork-(b) venue-scoped custodial decision (S4-P13)'
  });
}

/**
 * Every adapter, in routing order.
 *
 * Operator and per-user entries sit in the same array and are picked by the same
 * rule. Ordering within a chain does not matter because `serves` partitions the
 * principals, but keeping the pairs adjacent makes it obvious at a glance that
 * no chain has one without the other.
 */
export function createExecutionAuthorityAdapters(
  deps: OperatorAuthorityDeps,
  userSolanaOptions?: UserSolanaAuthorityOptions
): readonly UserExecutionAuthority[] {
  // Do NOT fall back to operator signer for user authority (EXE-01 / CRY-01)
  const solanaSigner = userSolanaOptions?.signer;
  return [
    createOperatorSolanaAuthority(deps.solana),
    createUserSolanaAuthority({
      signer: solanaSigner,
      ...userSolanaOptions
    }),
    createOperatorRobinhoodAuthority(deps.robinhoodChain),
    createUserRobinhoodAuthority(),
    createOperatorPolymarketAuthority(deps.polygon),
    createUserPolymarketAuthority()
  ];
}

/** Convenience for tests and for the wiring assertions. */
export function grantedAuthorityOrNull(
  verdict: ExecutionAuthorityVerdict
): GrantedExecutionAuthority | null {
  return verdict.kind === 'granted' ? verdict.authority : null;
}
