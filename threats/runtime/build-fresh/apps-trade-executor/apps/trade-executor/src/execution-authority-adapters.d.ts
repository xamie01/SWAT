import { type Eip712TypedData, type ExecutionAuthorityVerdict, type GrantedExecutionAuthority, type UserExecutionAuthority } from './execution-authority.js';
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
    buildTip(input: {
        tipAccount: string;
        lamports: number;
    }): Promise<string>;
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
    identity(): {
        readonly signerAddress: string;
        readonly funderAddress: string;
    } | null;
    typedDataSigner(): TypedDataSigner | null;
}
export interface OperatorAuthorityDeps {
    readonly solana: OperatorSolanaAuthorityDeps;
    readonly robinhoodChain: OperatorEvmAuthorityDeps;
    readonly polygon: OperatorPolymarketAuthorityDeps;
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
export declare function createOperatorSolanaAuthority(deps: OperatorSolanaAuthorityDeps): UserExecutionAuthority;
/**
 * Operator authority on Robinhood Chain.
 *
 * `settlementAddress` is `EVM_PRIVATE_KEY`'s address, which is also the key the
 * per-account nonce serialisation in `robinhood.ts` locks on. Do not derive it
 * anywhere else: `withSubmissionLock` and `EvmNonceLock` are both keyed by this
 * string, and two spellings of the same account would defeat both.
 */
export declare function createOperatorRobinhoodAuthority(deps: OperatorEvmAuthorityDeps): UserExecutionAuthority;
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
export declare function createOperatorPolymarketAuthority(deps: OperatorPolymarketAuthorityDeps): UserExecutionAuthority;
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
export declare function createUserRobinhoodAuthority(options?: UserGrantAuthorityOptions): UserExecutionAuthority;
/** Live, audited WAKE Vault Anchor program ID on Solana (ADR-0003 §3, S4-P12). */
export declare const WAKE_VAULT_PROGRAM_ID = "6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS";
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
export declare function createUserSolanaAuthority(options?: UserSolanaAuthorityOptions): UserExecutionAuthority;
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
export declare function createUserPolymarketAuthority(): UserExecutionAuthority;
/**
 * Every adapter, in routing order.
 *
 * Operator and per-user entries sit in the same array and are picked by the same
 * rule. Ordering within a chain does not matter because `serves` partitions the
 * principals, but keeping the pairs adjacent makes it obvious at a glance that
 * no chain has one without the other.
 */
export declare function createExecutionAuthorityAdapters(deps: OperatorAuthorityDeps, userSolanaOptions?: UserSolanaAuthorityOptions): readonly UserExecutionAuthority[];
/** Convenience for tests and for the wiring assertions. */
export declare function grantedAuthorityOrNull(verdict: ExecutionAuthorityVerdict): GrantedExecutionAuthority | null;
//# sourceMappingURL=execution-authority-adapters.d.ts.map