/**
 * Argument-scoped permission policy engine — checklist `S4-P10`, ADR-0003 §2.1.
 *
 * **This directory moves to `packages/authority` when that package is created
 * (checklist §7.1).** It lives under `packages/shared/src/authority/` only
 * because standing up a new workspace package needs a `pnpm install` to link it.
 * Nothing in here imports anything else from `@swat/shared`, and nothing here
 * imports a third-party package at all, so the move is a directory rename plus a
 * `package.json` — deliberately, to keep that later move a non-event.
 *
 * ## The hole this closes
 *
 * A session key scoped to "the router, swap selectors only" is still drainable.
 * Every ERC-20 swap needs `approve(spender, amount)` on the *token*, so the scope
 * must permit `approve`. An unconstrained `spender` then lets the key approve an
 * attacker, who drains the token directly and never calls the router. "No
 * `transfer`, no `withdraw`" is an *incomplete* specification of the scope, and a
 * `(target, selector)` policy cannot express the missing half.
 *
 * So the unit of permission here is `(target, selector, decoded argument)`:
 *
 *   * `approve` only where `spender` is allowlisted **and** `amount` is bounded
 *     (never `type(uint256).max`, and never Permit2's `type(uint160).max`),
 *   * swap selectors only where the recipient argument is the user's own account,
 *   * everything not explicitly listed is denied.
 *
 * ## Not only calldata
 *
 * Checklist `S4-M13` moves EVM approvals to Permit2, which removes the on-chain
 * `approve` entirely and relocates the argument-level check onto the *signature's*
 * `token` / `spender` / `amount` / `deadline` fields. The thing being authorised
 * is therefore not always calldata, so `AuthorityAction` has two shapes from the
 * start: a decoded `contract-call` and a `signed-struct` (an EIP-712 payload).
 * The condition vocabulary is shared between them; only the field paths differ.
 * `apps/trade-executor/src/permit2.ts` (built separately) supplies the concrete
 * field names — this module is not coupled to them.
 *
 * ## Three verdict kinds, not two
 *
 * `permit` / `deny` / `unresolved`, following the split that
 * `apps/trade-executor/src/solana-simulation.ts` documents at length. The third
 * kind exists because of a specific documented footgun (`DG-3`): **a mis-pathed
 * condition fails closed.** A rule written against `transfer.amount` when the
 * call is `approve` denies every request — which is the *right* direction, but it
 * presents to an operator as "the integration is broken", not "the policy is
 * wrong". Folding it into `deny` sends that operator to debug a trade that was
 * fine. So an unresolvable path returns `unresolved` with
 * `authority-field-path-unresolved` and names the path and the keys that *were*
 * available. It still refuses — `isPermitted` is true for `permit` and nothing
 * else — but it refuses under its own name.
 *
 * ## Overlapping ALLOW rules are rejected at construction
 *
 * The other `DG-3` footgun: when two ALLOW rules both constrain the same field,
 * the union is what you get, so an accidentally-broad second rule silently
 * defeats a tight first one. Two resolutions were available — reject the overlap
 * at construction, or evaluate so the tighter constraint wins. This engine
 * **rejects at construction**, for three reasons:
 *
 *   1. "Tighter wins" needs an intersection semantics over heterogeneous
 *      operators (address sets vs numeric bounds), which is not always
 *      well-defined and would have to be *simulated* to be audited.
 *   2. Rejecting keeps the document its own specification: the permission for any
 *      `(target, selector)` is readable from exactly one rule, by eye.
 *   3. Our layer is defence in depth *alongside* a vendor engine (Privy) whose
 *      semantics are a union. Inventing different merge semantics here would mean
 *      the same policy text means two different things in two places — which is a
 *      worse footgun than the one being fixed.
 *
 * The check is deliberately coarse: at most one ALLOW rule may be reachable for
 * any `(target, selector)` pair. The cost is real and is documented on
 * `compileAuthorityPolicy` — per-target variation must be expressed inside one
 * rule, and a policy needing *different bounds per spender* on the same token and
 * selector is not expressible today. Coarse and loud beats clever and quiet in a
 * funds path.
 *
 * ## Default-deny is structural
 *
 * There is no `deny` effect and no deny list, in the same spirit as
 * `USER_REACHABLE_PREFIXES` in `apps/api/src/auth/plugin.ts`: a blocklist leaves
 * every newly-deployed selector permitted until somebody remembers to add it.
 * Rules only ever *add* a narrow permission, so the fallthrough is not an `else`
 * — it is the absence of a match. Native value is denied the same way: a rule
 * that says nothing about value permits zero.
 *
 * ## Pure
 *
 * No I/O, no DB, no network, no clock — `nowSeconds` is injected. The compiled
 * policy is what `execution_grants.scope_policy` holds
 * (`packages/db/src/execution-grants.ts`); the owner account and the grant expiry
 * are passed in from the grant row rather than duplicated in the document, so a
 * templated policy cannot pin to the wrong user's address.
 */
import { type EvmFunctionDescriptor, type EvmUserOperationCallInput } from './evm-calldata.js';
/** Robinhood Chain (ADR-0003 §2). Every EVM scope in Stage 4 targets this chain. */
export declare const ROBINHOOD_CHAIN_ID = 4663;
export declare const MAX_UINT256: bigint;
/**
 * Permit2 treats `type(uint160).max` in `details.amount` as an unlimited
 * allowance, so a "bound" of that value is not a bound. Listed alongside
 * `type(uint256).max` for that reason.
 *
 * *Unverified against Permit2 source from this workspace* — `permit2.ts` does not
 * exist yet. Re-check when `S4-M13` lands; if the sentinel differs, this constant
 * is the only place to change.
 */
export declare const MAX_UINT160: bigint;
/** Amounts that mean "unlimited" and must never be accepted as a bound. */
export declare const UNBOUNDED_AMOUNT_SENTINELS: readonly bigint[];
/**
 * A definite refusal. The action was understood and is not permitted.
 * An operator seeing one of these should look at the *policy*, not the plumbing.
 */
export type AuthorityDenyCode = 
/** Default-deny: no ALLOW rule's scope covers this target/selector. */
'authority-deny-no-matching-rule'
/** A rule matched by scope and one of its argument conditions rejected. */
 | 'authority-deny-condition-failed'
/** The action is on a different chain than the scope was written for. */
 | 'authority-deny-chain-mismatch'
/** The grant's expiry has passed. */
 | 'authority-deny-grant-expired'
/** Native value attached above what the matched rule permits (default zero). */
 | 'authority-deny-value-not-permitted'
/** `execute(dest, value, "")` — a bare value transfer is never authorised. */
 | 'authority-deny-bare-value-transfer';
/**
 * The engine could not answer. Says nothing about whether the action was
 * legitimate — it means the policy or the decoder does not line up with the
 * payload. Every one of these still refuses; the separate names exist so the
 * operator is sent to the right place.
 */
export type AuthorityUnresolvedCode = 
/** A condition's field path does not exist on this action. Footgun 2. */
'authority-field-path-unresolved'
/** The path resolved, but to a value of the wrong kind for the operator. */
 | 'authority-field-type-mismatch'
/** No descriptor for the 4-byte selector: we cannot say what this call does. */
 | 'authority-action-unknown-selector'
/** A descriptor matched but the bytes do not decode against it. */
 | 'authority-action-undecodable'
/** Two ALLOW rules matched. `compileAuthorityPolicy` should have refused it. */
 | 'authority-policy-ambiguous-match';
/** Construction-time rejections. All are thrown as `AuthorityPolicyError`. */
export type AuthorityPolicyErrorCode = 'authority-policy-invalid-document' | 'authority-policy-invalid-address' | 'authority-policy-invalid-amount' | 'authority-policy-invalid-duplicate-rule-id' | 'authority-policy-invalid-unscoped-rule' | 'authority-policy-invalid-overlapping-allow' | 'authority-policy-invalid-unbounded-amount' | 'authority-policy-invalid-unbounded-approval' | 'authority-policy-invalid-field-path';
export declare class AuthorityPolicyError extends Error {
    readonly code: AuthorityPolicyErrorCode;
    constructor(code: AuthorityPolicyErrorCode, message: string);
}
/** A leaf value a condition can be written against. */
export type AuthorityFieldValue = string | bigint | boolean;
/**
 * A nested EIP-712 message.
 *
 * **Arrays are deliberately not representable.** `DG-3` records that the vendor
 * engine has no documented array-index condition path, so a rule over
 * `calls[0].target` is not expressible there either; permitting it here would
 * produce a policy our defence-in-depth partner cannot mirror. The practical
 * consequence is that Permit2 `PermitSingle` is expressible and `PermitBatch` is
 * not, and that a 4337 `executeBatch` is refused rather than partially checked.
 */
export interface AuthorityStructNode {
    readonly [key: string]: AuthorityFieldValue | AuthorityStructNode;
}
/** A decoded contract call — one `(target, selector, args)` triple. */
export interface AuthorityContractCall {
    readonly kind: 'contract-call';
    readonly chainId: number;
    /** Contract being called. Raw EVM address; case is normalised on evaluation. */
    readonly target: string;
    /** `0x` + 8 hex. The on-chain identity of the function. */
    readonly selector: string;
    /** Decoded name, for diagnostics. Rule matching is on `selector`. */
    readonly functionName: string;
    /** Native value attached to this call. */
    readonly value: bigint;
    /** Decoded arguments by name. Reached as `<functionName>.<argName>`. */
    readonly args: Readonly<Record<string, AuthorityFieldValue>>;
}
/** An EIP-712 payload awaiting a signature — Permit2 today (`S4-M13`). */
export interface AuthoritySignedStruct {
    readonly kind: 'signed-struct';
    readonly chainId: number;
    readonly primaryType: string;
    readonly verifyingContract: string;
    readonly message: AuthorityStructNode;
}
export type AuthorityAction = AuthorityContractCall | AuthoritySignedStruct;
export type AuthorityConditionOp = 'address_in' | 'address_is_owner' | 'uint_lte' | 'uint_eq' | 'uint_lte_now_plus' | 'bool_eq';
/**
 * One argument constraint.
 *
 * `field` is a dotted path. The roots are deliberately the same shape the vendor
 * engine uses (`approve.spender`), so one rule reads the same in both places.
 */
export type AuthorityCondition = {
    readonly field: string;
    readonly op: 'address_in';
    readonly addresses: readonly string[];
}
/** Pins to the grant's own account. The swap-recipient constraint of §2.1. */
 | {
    readonly field: string;
    readonly op: 'address_is_owner';
} | {
    readonly field: string;
    readonly op: 'uint_lte';
    readonly max: bigint;
} | {
    readonly field: string;
    readonly op: 'uint_eq';
    readonly value: bigint;
}
/** For Permit2 `deadline`: bounded relative to the injected clock. */
 | {
    readonly field: string;
    readonly op: 'uint_lte_now_plus';
    readonly maxSecondsAhead: number;
} | {
    readonly field: string;
    readonly op: 'bool_eq';
    readonly value: boolean;
};
/**
 * A rule permits exactly **one** function or primary type.
 *
 * Not an arbitrary restriction: it is what makes `<functionName>.<arg>` paths
 * unambiguous. A rule covering both `approve` and `transfer` would have to answer
 * "what does a condition on `approve.spender` mean when the call is `transfer`?",
 * and every answer to that is either a loosening or a surprise.
 */
export type AuthorityRuleScope = {
    readonly kind: 'contract-call';
    /** Contracts this rule covers. Never empty — an empty list is unscoped. */
    readonly targets: readonly string[];
    readonly selector: string;
    /** The path root for argument conditions in this rule. */
    readonly functionName: string;
} | {
    readonly kind: 'signed-struct';
    readonly verifyingContracts: readonly string[];
    readonly primaryType: string;
};
export interface AuthorityRule {
    readonly id: string;
    /** Only `allow` exists. Default-deny is structural, not a rule. */
    readonly effect: 'allow';
    readonly scope: AuthorityRuleScope;
    readonly conditions: readonly AuthorityCondition[];
    /** Native value ceiling. Absent means zero. */
    readonly maxNativeValue: bigint;
}
export interface CompiledAuthorityPolicy {
    readonly version: 1;
    /** The chain this scope was written for. Robinhood Chain is 4663. */
    readonly chainId: number;
    readonly rules: readonly AuthorityRule[];
}
export interface AuthorityEvaluationContext {
    /**
     * The user's own account — what `address_is_owner` pins to. Sourced from
     * `execution_grants.account_address`, which is stored unprefixed; a
     * `chain:`-prefixed value is accepted and stripped so a caller reading from a
     * prefixed column cannot silently pin to a literal that matches nothing.
     */
    readonly ownerAccount: string;
    /** Injected clock, unix seconds. Nothing here reads `Date.now()`. */
    readonly nowSeconds: number;
    /** From `execution_grants.expires_at`. `null`/absent means no expiry. */
    readonly grantExpiresAtSeconds?: number | null;
}
export type AuthorityVerdict = {
    readonly kind: 'permit';
    readonly ruleId: string;
    /** Which function/primary type the rule matched, for the audit line. */
    readonly matched: string;
} | {
    readonly kind: 'deny';
    readonly code: AuthorityDenyCode;
    readonly reason: string;
    readonly ruleId: string | null;
    readonly field: string | null;
} | {
    readonly kind: 'unresolved';
    readonly code: AuthorityUnresolvedCode;
    readonly reason: string;
    readonly ruleId: string | null;
    readonly field: string | null;
};
/**
 * The only authorisation predicate. Structural, so a caller cannot authorise by
 * checking `verdict.kind !== 'deny'` and waving `unresolved` through.
 */
export declare function isPermitted(verdict: AuthorityVerdict): verdict is Extract<AuthorityVerdict, {
    kind: 'permit';
}>;
/**
 * Lowercases an EVM address and tolerates a `${chain}:` prefix.
 *
 * Local rather than `address.ts`'s `stripChainPrefix` so this directory stays
 * import-free and the move to `packages/authority` is a rename.
 */
export declare function normalizeEvmAddress(value: string): string | null;
/**
 * Parses and validates a policy document — what `execution_grants.scope_policy`
 * holds. Throws `AuthorityPolicyError` with a stable `code`; it never returns a
 * half-valid policy, because a policy that loads with a warning is a policy that
 * runs with a warning.
 *
 * **Known limitation, from the overlap rule.** At most one ALLOW rule may be
 * reachable for any `(target, selector)`. A policy that wants *different bounds
 * for different spenders on the same token and selector* cannot be written today;
 * merge the spenders into one `address_in` and take the tighter bound. That
 * limitation is the price of the guarantee that the permission for a
 * `(target, selector)` is readable from one rule.
 */
export declare function compileAuthorityPolicy(document: unknown): CompiledAuthorityPolicy;
/**
 * The decision function. Never throws — a throw on an authorisation path is how a
 * job crash becomes a BullMQ retry becomes a duplicate position.
 */
export declare function evaluateAuthorityAction(policy: CompiledAuthorityPolicy, action: AuthorityAction, context: AuthorityEvaluationContext): AuthorityVerdict;
/**
 * Convenience composition for the 4337 path: decode a UserOperation's `callData`
 * and evaluate the result.
 *
 * A decode failure is mapped to the verdict family it belongs to — "we cannot
 * tell what this calldata does" is `unresolved`, while a bare value transfer is a
 * definite `deny`. Both refuse; only the name differs, which is the whole point.
 */
export declare function authorizeUserOperationCall(policy: CompiledAuthorityPolicy, userOp: EvmUserOperationCallInput, descriptors: readonly EvmFunctionDescriptor[], context: AuthorityEvaluationContext): AuthorityVerdict;
//# sourceMappingURL=permission-policy.d.ts.map