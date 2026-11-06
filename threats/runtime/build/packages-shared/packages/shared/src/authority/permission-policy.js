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
import { describeUserOperationCall } from './evm-calldata.js';
/** Robinhood Chain (ADR-0003 §2). Every EVM scope in Stage 4 targets this chain. */
export const ROBINHOOD_CHAIN_ID = 4663;
export const MAX_UINT256 = (1n << 256n) - 1n;
/**
 * Permit2 treats `type(uint160).max` in `details.amount` as an unlimited
 * allowance, so a "bound" of that value is not a bound. Listed alongside
 * `type(uint256).max` for that reason.
 *
 * *Unverified against Permit2 source from this workspace* — `permit2.ts` does not
 * exist yet. Re-check when `S4-M13` lands; if the sentinel differs, this constant
 * is the only place to change.
 */
export const MAX_UINT160 = (1n << 160n) - 1n;
/** Amounts that mean "unlimited" and must never be accepted as a bound. */
export const UNBOUNDED_AMOUNT_SENTINELS = [MAX_UINT256, MAX_UINT160];
const MAX_REASON_LENGTH = 500;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_]+$/;
function truncate(value, limit = MAX_REASON_LENGTH) {
    return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
export class AuthorityPolicyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'AuthorityPolicyError';
        this.code = code;
    }
}
/**
 * The only authorisation predicate. Structural, so a caller cannot authorise by
 * checking `verdict.kind !== 'deny'` and waving `unresolved` through.
 */
export function isPermitted(verdict) {
    return verdict.kind === 'permit';
}
// ---------------------------------------------------------------------------
// Address / amount normalisation
// ---------------------------------------------------------------------------
/**
 * Lowercases an EVM address and tolerates a `${chain}:` prefix.
 *
 * Local rather than `address.ts`'s `stripChainPrefix` so this directory stays
 * import-free and the move to `packages/authority` is a rename.
 */
export function normalizeEvmAddress(value) {
    if (typeof value !== 'string')
        return null;
    const colon = value.lastIndexOf(':');
    const raw = colon === -1 ? value : value.slice(colon + 1);
    return EVM_ADDRESS.test(raw) ? raw.toLowerCase() : null;
}
function requireAddress(value, where) {
    if (typeof value !== 'string') {
        throw new AuthorityPolicyError('authority-policy-invalid-address', `${where} must be a string EVM address`);
    }
    const normalized = normalizeEvmAddress(value);
    if (normalized === null) {
        throw new AuthorityPolicyError('authority-policy-invalid-address', `${where} is not a valid EVM address: ${JSON.stringify(value)}`);
    }
    return normalized;
}
function requireAmount(value, where) {
    let parsed;
    if (typeof value === 'bigint') {
        parsed = value;
    }
    else if (typeof value === 'number') {
        if (!Number.isSafeInteger(value)) {
            throw new AuthorityPolicyError('authority-policy-invalid-amount', `${where} must be a safe integer when given as a number; use a string for large values`);
        }
        parsed = BigInt(value);
    }
    else if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
        parsed = BigInt(value);
    }
    else {
        throw new AuthorityPolicyError('authority-policy-invalid-amount', `${where} must be a bigint, a safe integer, or a decimal/hex string; received ${JSON.stringify(value)}`);
    }
    if (parsed < 0n) {
        throw new AuthorityPolicyError('authority-policy-invalid-amount', `${where} must not be negative`);
    }
    if (parsed > MAX_UINT256) {
        throw new AuthorityPolicyError('authority-policy-invalid-amount', `${where} exceeds uint256`);
    }
    return parsed;
}
// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------
/**
 * Functions whose whole purpose is to hand spending authority to another
 * address. §2.1 is specifically about these: permitting one without pinning the
 * grantee *and* bounding the amount reopens the hole this module exists to close,
 * so it is refused at construction rather than denied at trade time.
 */
const ALLOWANCE_FUNCTIONS = ['approve', 'increaseAllowance'];
/** Argument names ERC-20 implementations use for the allowance amount. */
const ALLOWANCE_AMOUNT_ARGS = ['amount', 'value', 'addedValue'];
/** Blanket operator approvals (ERC-721 / ERC-1155). No amount to bound. */
const OPERATOR_APPROVAL_FUNCTIONS = ['setApprovalForAll'];
/**
 * EIP-712 primary types that grant spending authority.
 *
 * Names are Permit2's and EIP-2612's as published; **not verified against
 * installed source from this workspace** — `permit2.ts` does not exist yet. If a
 * name is wrong the failure mode is a *missing* structural check, not a wrong
 * one, so it is listed and flagged rather than omitted.
 */
/**
 * EIP-712 primary types that grant spending authority, and therefore must carry
 * an address constraint and an amount bound (S4-M13 moves the `approve` check
 * onto these fields).
 *
 * Verified 2026-08-25 against Uniswap's `permit2/src/libraries/PermitHash.sol`,
 * which defines eight struct types. The five spending-authority ones are listed
 * below plus the two witness variants, which were **missing** from the first
 * draft of this list -- and a missing name here is a *silently skipped*
 * structural check, not a wrong one, which is the more dangerous direction.
 *
 * `PermitDetails` and `TokenPermissions` are deliberately absent: they are
 * sub-structs, never a `primaryType` on their own, so a rule scoped to one could
 * not match a real signature request.
 *
 * `Permit` is EIP-2612 (the ERC-20 permit standard), not Permit2. It is here
 * because it grants an allowance by signature just the same.
 */
const ALLOWANCE_PRIMARY_TYPES = [
    'Permit',
    'PermitSingle',
    'PermitBatch',
    'PermitTransferFrom',
    'PermitBatchTransferFrom',
    'PermitWitnessTransferFrom',
    'PermitBatchWitnessTransferFrom'
];
const CALL_METADATA_FIELDS = ['target', 'selector', 'value', 'chainId'];
const STRUCT_METADATA_FIELDS = ['primaryType', 'verifyingContract', 'chainId'];
const ADDRESS_OPS = ['address_in', 'address_is_owner'];
const AMOUNT_BOUND_OPS = ['uint_lte', 'uint_eq'];
function asRecord(value, where) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new AuthorityPolicyError('authority-policy-invalid-document', `${where} must be an object`);
    }
    return value;
}
function asNonEmptyArray(value, where, code) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new AuthorityPolicyError(code, `${where} must be a non-empty array`);
    }
    return value;
}
function asNonEmptyString(value, where) {
    if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
        throw new AuthorityPolicyError('authority-policy-invalid-document', `${where} must be a non-empty, untrimmed-free string`);
    }
    return value;
}
function normalizeSelector(value, where) {
    const raw = asNonEmptyString(value, where);
    if (!/^0x[0-9a-fA-F]{8}$/.test(raw)) {
        throw new AuthorityPolicyError('authority-policy-invalid-document', `${where} must be a 4-byte selector like 0x095ea7b3; received ${JSON.stringify(raw)}`);
    }
    return raw.toLowerCase();
}
function validateFieldPath(path, scope, ruleId) {
    const segments = path.split('.');
    if (segments.length < 2 || segments.some((s) => !PATH_SEGMENT.test(s))) {
        throw new AuthorityPolicyError('authority-policy-invalid-field-path', `rule ${ruleId}: field path ${JSON.stringify(path)} is not a dotted path of word segments`);
    }
    const [root, second] = segments;
    if (scope.kind === 'contract-call') {
        if (root === 'call') {
            if (segments.length !== 2 || !CALL_METADATA_FIELDS.includes(second)) {
                throw new AuthorityPolicyError('authority-policy-invalid-field-path', `rule ${ruleId}: call metadata paths are call.{${CALL_METADATA_FIELDS.join('|')}}; received ${path}`);
            }
            return;
        }
        // The check that catches the commonest form of footgun 2 before it ships:
        // a condition rooted at a function this rule does not permit can never
        // resolve, so it would deny every request and read as a broken integration.
        if (root !== scope.functionName) {
            throw new AuthorityPolicyError('authority-policy-invalid-field-path', `rule ${ruleId}: field path ${path} is rooted at "${root}" but the rule permits "${scope.functionName}"; a path that cannot resolve would deny every request`);
        }
        if (segments.length !== 2) {
            throw new AuthorityPolicyError('authority-policy-invalid-field-path', `rule ${ruleId}: argument paths are <function>.<argument>; received ${path}`);
        }
        return;
    }
    if (root === 'struct') {
        if (segments.length !== 2 || !STRUCT_METADATA_FIELDS.includes(second)) {
            throw new AuthorityPolicyError('authority-policy-invalid-field-path', `rule ${ruleId}: struct metadata paths are struct.{${STRUCT_METADATA_FIELDS.join('|')}}; received ${path}`);
        }
        return;
    }
    if (root !== 'message') {
        throw new AuthorityPolicyError('authority-policy-invalid-field-path', `rule ${ruleId}: signed-struct paths must start with "struct." or "message."; received ${path}`);
    }
}
function compileCondition(raw, scope, ruleId) {
    const record = asRecord(raw, `rule ${ruleId}: condition`);
    const field = asNonEmptyString(record.field, `rule ${ruleId}: condition.field`);
    validateFieldPath(field, scope, ruleId);
    const op = record.op;
    switch (op) {
        case 'address_in': {
            const list = asNonEmptyArray(record.addresses, `rule ${ruleId}: condition ${field} addresses`, 'authority-policy-invalid-document');
            const addresses = list.map((entry, index) => requireAddress(entry, `rule ${ruleId}: condition ${field} addresses[${index}]`));
            return { field, op: 'address_in', addresses };
        }
        case 'address_is_owner':
            return { field, op: 'address_is_owner' };
        case 'uint_lte': {
            const max = requireAmount(record.max, `rule ${ruleId}: condition ${field} max`);
            assertBounded(max, ruleId, field);
            return { field, op: 'uint_lte', max };
        }
        case 'uint_eq': {
            const value = requireAmount(record.value, `rule ${ruleId}: condition ${field} value`);
            assertBounded(value, ruleId, field);
            return { field, op: 'uint_eq', value };
        }
        case 'uint_lte_now_plus': {
            const seconds = record.maxSecondsAhead;
            if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0) {
                throw new AuthorityPolicyError('authority-policy-invalid-amount', `rule ${ruleId}: condition ${field} maxSecondsAhead must be a positive integer`);
            }
            return { field, op: 'uint_lte_now_plus', maxSecondsAhead: seconds };
        }
        case 'bool_eq': {
            if (typeof record.value !== 'boolean') {
                throw new AuthorityPolicyError('authority-policy-invalid-document', `rule ${ruleId}: condition ${field} value must be a boolean`);
            }
            return { field, op: 'bool_eq', value: record.value };
        }
        default:
            throw new AuthorityPolicyError('authority-policy-invalid-document', `rule ${ruleId}: unknown condition op ${JSON.stringify(op)}`);
    }
}
function assertBounded(amount, ruleId, field) {
    if (UNBOUNDED_AMOUNT_SENTINELS.includes(amount)) {
        throw new AuthorityPolicyError('authority-policy-invalid-unbounded-amount', `rule ${ruleId}: condition ${field} uses ${amount === MAX_UINT256 ? 'type(uint256).max' : 'type(uint160).max'}, which is an unlimited allowance, not a bound (ADR-0003 §2.1)`);
    }
}
function assertApprovalIsConstrained(rule) {
    const { scope, conditions } = rule;
    if (scope.kind === 'contract-call') {
        const fn = scope.functionName;
        if (ALLOWANCE_FUNCTIONS.includes(fn)) {
            const hasSpender = conditions.some((c) => c.field === `${fn}.spender` && ADDRESS_OPS.includes(c.op));
            if (!hasSpender) {
                throw new AuthorityPolicyError('authority-policy-invalid-unbounded-approval', `rule ${rule.id}: "${fn}" is permitted with no constraint on ${fn}.spender — an unconstrained spender lets the key approve an attacker who then drains the token without ever calling the router (ADR-0003 §2.1)`);
            }
            const hasBound = conditions.some((c) => ALLOWANCE_AMOUNT_ARGS.some((arg) => c.field === `${fn}.${arg}`) &&
                AMOUNT_BOUND_OPS.includes(c.op));
            if (!hasBound) {
                throw new AuthorityPolicyError('authority-policy-invalid-unbounded-approval', `rule ${rule.id}: "${fn}" is permitted with no bound on the amount; add a uint_lte on ${fn}.{${ALLOWANCE_AMOUNT_ARGS.join('|')}}`);
            }
            return;
        }
        if (OPERATOR_APPROVAL_FUNCTIONS.includes(fn)) {
            const hasOperator = conditions.some((c) => c.field === `${fn}.operator` && ADDRESS_OPS.includes(c.op));
            if (!hasOperator) {
                throw new AuthorityPolicyError('authority-policy-invalid-unbounded-approval', `rule ${rule.id}: "${fn}" grants blanket operator authority; constrain ${fn}.operator to an allowlist`);
            }
        }
        return;
    }
    if (!ALLOWANCE_PRIMARY_TYPES.includes(scope.primaryType))
        return;
    const hasAddressConstraint = conditions.some((c) => ADDRESS_OPS.includes(c.op));
    if (!hasAddressConstraint) {
        throw new AuthorityPolicyError('authority-policy-invalid-unbounded-approval', `rule ${rule.id}: primary type "${scope.primaryType}" grants spending authority and carries no address constraint (S4-M13 moves the approve check onto these fields)`);
    }
    const hasAmountBound = conditions.some((c) => AMOUNT_BOUND_OPS.includes(c.op));
    if (!hasAmountBound) {
        throw new AuthorityPolicyError('authority-policy-invalid-unbounded-approval', `rule ${rule.id}: primary type "${scope.primaryType}" grants spending authority and carries no amount bound`);
    }
}
function compileRule(raw, index) {
    const record = asRecord(raw, `rules[${index}]`);
    const id = asNonEmptyString(record.id, `rules[${index}].id`);
    if (record.effect !== undefined && record.effect !== 'allow') {
        throw new AuthorityPolicyError('authority-policy-invalid-document', `rule ${id}: the only effect is "allow" — default-deny is structural, there are no deny rules`);
    }
    const scopeRecord = asRecord(record.scope, `rule ${id}: scope`);
    let scope;
    if (scopeRecord.kind === 'contract-call') {
        const targetsRaw = asNonEmptyArray(scopeRecord.targets, `rule ${id}: scope.targets`, 'authority-policy-invalid-unscoped-rule');
        const targets = targetsRaw.map((entry, i) => requireAddress(entry, `rule ${id}: scope.targets[${i}]`));
        scope = {
            kind: 'contract-call',
            targets,
            selector: normalizeSelector(scopeRecord.selector, `rule ${id}: scope.selector`),
            functionName: asNonEmptyString(scopeRecord.functionName, `rule ${id}: scope.functionName`)
        };
        if (!PATH_SEGMENT.test(scope.functionName)) {
            throw new AuthorityPolicyError('authority-policy-invalid-document', `rule ${id}: scope.functionName must be a bare identifier, it is the root of every argument path`);
        }
    }
    else if (scopeRecord.kind === 'signed-struct') {
        const contractsRaw = asNonEmptyArray(scopeRecord.verifyingContracts, `rule ${id}: scope.verifyingContracts`, 'authority-policy-invalid-unscoped-rule');
        scope = {
            kind: 'signed-struct',
            verifyingContracts: contractsRaw.map((entry, i) => requireAddress(entry, `rule ${id}: scope.verifyingContracts[${i}]`)),
            primaryType: asNonEmptyString(scopeRecord.primaryType, `rule ${id}: scope.primaryType`)
        };
    }
    else {
        throw new AuthorityPolicyError('authority-policy-invalid-document', `rule ${id}: scope.kind must be "contract-call" or "signed-struct"`);
    }
    const conditionsRaw = record.conditions;
    if (conditionsRaw !== undefined && !Array.isArray(conditionsRaw)) {
        throw new AuthorityPolicyError('authority-policy-invalid-document', `rule ${id}: conditions must be an array`);
    }
    const conditions = (conditionsRaw ?? []).map((entry) => compileCondition(entry, scope, id));
    const maxNativeValue = record.maxNativeValue === undefined
        ? 0n
        : requireAmount(record.maxNativeValue, `rule ${id}: maxNativeValue`);
    const rule = { id, effect: 'allow', scope, conditions, maxNativeValue };
    assertApprovalIsConstrained(rule);
    return rule;
}
function scopesOverlap(a, b) {
    if (a.kind !== b.kind)
        return false;
    if (a.kind === 'contract-call' && b.kind === 'contract-call') {
        if (a.selector !== b.selector)
            return false;
        return a.targets.some((t) => b.targets.includes(t));
    }
    if (a.kind === 'signed-struct' && b.kind === 'signed-struct') {
        if (a.primaryType !== b.primaryType)
            return false;
        return a.verifyingContracts.some((c) => b.verifyingContracts.includes(c));
    }
    return false;
}
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
export function compileAuthorityPolicy(document) {
    const record = asRecord(document, 'policy');
    const chainId = record.chainId;
    if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
        throw new AuthorityPolicyError('authority-policy-invalid-document', 'policy.chainId must be a positive integer (Robinhood Chain is 4663)');
    }
    if (record.version !== undefined && record.version !== 1) {
        throw new AuthorityPolicyError('authority-policy-invalid-document', `policy.version ${JSON.stringify(record.version)} is not supported by this engine`);
    }
    const rulesRaw = record.rules;
    if (!Array.isArray(rulesRaw)) {
        throw new AuthorityPolicyError('authority-policy-invalid-document', 'policy.rules must be an array');
    }
    // An empty rule list is valid and denies everything. That is a safe state, and
    // refusing it would leave no way to express "revoked but not yet deleted".
    const rules = rulesRaw.map((entry, index) => compileRule(entry, index));
    const seen = new Set();
    for (const rule of rules) {
        if (seen.has(rule.id)) {
            throw new AuthorityPolicyError('authority-policy-invalid-duplicate-rule-id', `duplicate rule id ${JSON.stringify(rule.id)}: verdict codes name the rule, so ids must be unique`);
        }
        seen.add(rule.id);
    }
    for (let i = 0; i < rules.length; i += 1) {
        for (let j = i + 1; j < rules.length; j += 1) {
            const a = rules[i];
            const b = rules[j];
            if (scopesOverlap(a.scope, b.scope)) {
                throw new AuthorityPolicyError('authority-policy-invalid-overlapping-allow', `rules ${JSON.stringify(a.id)} and ${JSON.stringify(b.id)} both permit the same scope; overlapping ALLOW rules union their conditions, so the looser one silently wins (DG-3). Merge them into one rule.`);
            }
        }
    }
    return { version: 1, chainId, rules };
}
function describeKeys(keys) {
    const shown = keys.slice(0, 8);
    return shown.length === 0
        ? '(no fields)'
        : `${shown.join(', ')}${keys.length > shown.length ? ', ...' : ''}`;
}
function resolveField(action, rule, path) {
    const segments = path.split('.');
    const root = segments[0];
    if (action.kind === 'contract-call') {
        if (root === 'call') {
            switch (segments[1]) {
                case 'target':
                    return { kind: 'value', value: action.target };
                case 'selector':
                    return { kind: 'value', value: action.selector };
                case 'value':
                    return { kind: 'value', value: action.value };
                case 'chainId':
                    return { kind: 'value', value: BigInt(action.chainId) };
                default:
                    return { kind: 'missing', reason: `call metadata has no field ${JSON.stringify(segments[1])}` };
            }
        }
        // Rooted at the rule's own function name (validated at compile time), so the
        // only way to get here with a miss is a *wrong argument name*.
        const argName = segments[1];
        const value = action.args[argName];
        if (value === undefined) {
            return {
                kind: 'missing',
                reason: `argument ${JSON.stringify(argName)} is not present on the decoded call to ${action.functionName}; decoded arguments are: ${describeKeys(Object.keys(action.args))}`
            };
        }
        return { kind: 'value', value };
    }
    if (root === 'struct') {
        switch (segments[1]) {
            case 'primaryType':
                return { kind: 'value', value: action.primaryType };
            case 'verifyingContract':
                return { kind: 'value', value: action.verifyingContract };
            case 'chainId':
                return { kind: 'value', value: BigInt(action.chainId) };
            default:
                return { kind: 'missing', reason: `struct metadata has no field ${JSON.stringify(segments[1])}` };
        }
    }
    if (root !== 'message') {
        return { kind: 'missing', reason: `rule ${rule.id} path root ${JSON.stringify(root)} does not exist on a signed struct` };
    }
    let node = action.message;
    for (let i = 1; i < segments.length; i += 1) {
        const segment = segments[i];
        if (typeof node !== 'object' || node === null) {
            return {
                kind: 'missing',
                reason: `${segments.slice(0, i).join('.')} is a leaf value, so ${segment} cannot be read from it`
            };
        }
        const next = node[segment];
        if (next === undefined) {
            return {
                kind: 'missing',
                reason: `${segments.slice(0, i + 1).join('.')} is not present; available at ${segments.slice(0, i).join('.')}: ${describeKeys(Object.keys(node))}`
            };
        }
        node = next;
    }
    if (typeof node === 'object' && node !== null) {
        return { kind: 'not-a-value', reason: `${path} resolves to a nested struct, not a value` };
    }
    return { kind: 'value', value: node };
}
// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
function unresolvedVerdict(code, reason, ruleId, field) {
    return { kind: 'unresolved', code, reason: truncate(reason), ruleId, field };
}
function denyVerdict(code, reason, ruleId, field) {
    return { kind: 'deny', code, reason: truncate(reason), ruleId, field };
}
function evaluateCondition(condition, action, rule, context) {
    const resolved = resolveField(action, rule, condition.field);
    if (resolved.kind === 'missing') {
        // Footgun 2, under its own name. This is *not* a policy denial: nothing about
        // the request was judged. The rule points at a field that does not exist.
        return unresolvedVerdict('authority-field-path-unresolved', `rule ${rule.id}: condition path ${condition.field} did not resolve — ${resolved.reason}. The policy is wrong, not the request.`, rule.id, condition.field);
    }
    if (resolved.kind === 'not-a-value') {
        return unresolvedVerdict('authority-field-type-mismatch', `rule ${rule.id}: ${resolved.reason}`, rule.id, condition.field);
    }
    const value = resolved.value;
    switch (condition.op) {
        case 'address_in':
        case 'address_is_owner': {
            if (typeof value !== 'string') {
                return unresolvedVerdict('authority-field-type-mismatch', `rule ${rule.id}: ${condition.field} is ${typeof value}, but ${condition.op} needs an address`, rule.id, condition.field);
            }
            const normalized = normalizeEvmAddress(value);
            if (normalized === null) {
                return unresolvedVerdict('authority-field-type-mismatch', `rule ${rule.id}: ${condition.field} is ${JSON.stringify(truncate(value, 80))}, which is not an EVM address`, rule.id, condition.field);
            }
            if (condition.op === 'address_is_owner') {
                const owner = normalizeEvmAddress(context.ownerAccount);
                if (owner === null) {
                    return unresolvedVerdict('authority-field-type-mismatch', `context.ownerAccount ${JSON.stringify(truncate(context.ownerAccount, 80))} is not an EVM address, so ${condition.field} cannot be pinned to it`, rule.id, condition.field);
                }
                if (normalized !== owner) {
                    return denyVerdict('authority-deny-condition-failed', `rule ${rule.id}: ${condition.field} is ${normalized}, which is not the grant's own account ${owner}`, rule.id, condition.field);
                }
                return null;
            }
            if (!condition.addresses.includes(normalized)) {
                return denyVerdict('authority-deny-condition-failed', `rule ${rule.id}: ${condition.field} is ${normalized}, which is not in the allowlist [${condition.addresses.join(', ')}]`, rule.id, condition.field);
            }
            return null;
        }
        case 'uint_lte':
        case 'uint_eq':
        case 'uint_lte_now_plus': {
            if (typeof value !== 'bigint') {
                return unresolvedVerdict('authority-field-type-mismatch', `rule ${rule.id}: ${condition.field} is ${typeof value}, but ${condition.op} needs an unsigned integer`, rule.id, condition.field);
            }
            if (condition.op === 'uint_lte' && value > condition.max) {
                return denyVerdict('authority-deny-condition-failed', `rule ${rule.id}: ${condition.field} is ${value}, above the permitted maximum ${condition.max}`, rule.id, condition.field);
            }
            if (condition.op === 'uint_eq' && value !== condition.value) {
                return denyVerdict('authority-deny-condition-failed', `rule ${rule.id}: ${condition.field} is ${value}, but only ${condition.value} is permitted`, rule.id, condition.field);
            }
            if (condition.op === 'uint_lte_now_plus') {
                const ceiling = BigInt(context.nowSeconds) + BigInt(condition.maxSecondsAhead);
                if (value > ceiling) {
                    return denyVerdict('authority-deny-condition-failed', `rule ${rule.id}: ${condition.field} is ${value}, more than ${condition.maxSecondsAhead}s ahead of now (${context.nowSeconds}); ceiling ${ceiling}`, rule.id, condition.field);
                }
            }
            return null;
        }
        case 'bool_eq': {
            if (typeof value !== 'boolean') {
                return unresolvedVerdict('authority-field-type-mismatch', `rule ${rule.id}: ${condition.field} is ${typeof value}, but bool_eq needs a boolean`, rule.id, condition.field);
            }
            if (value !== condition.value) {
                return denyVerdict('authority-deny-condition-failed', `rule ${rule.id}: ${condition.field} is ${value}, but only ${condition.value} is permitted`, rule.id, condition.field);
            }
            return null;
        }
    }
}
function ruleMatchesAction(rule, action) {
    if (rule.scope.kind === 'contract-call') {
        if (action.kind !== 'contract-call')
            return false;
        if (rule.scope.selector !== action.selector.toLowerCase())
            return false;
        const target = normalizeEvmAddress(action.target);
        return target !== null && rule.scope.targets.includes(target);
    }
    if (action.kind !== 'signed-struct')
        return false;
    if (rule.scope.primaryType !== action.primaryType)
        return false;
    const contract = normalizeEvmAddress(action.verifyingContract);
    return contract !== null && rule.scope.verifyingContracts.includes(contract);
}
/**
 * The decision function. Never throws — a throw on an authorisation path is how a
 * job crash becomes a BullMQ retry becomes a duplicate position.
 */
export function evaluateAuthorityAction(policy, action, context) {
    if (action.chainId !== policy.chainId) {
        return denyVerdict('authority-deny-chain-mismatch', `action is on chain ${action.chainId} but this scope was written for chain ${policy.chainId}`, null, null);
    }
    const expiresAt = context.grantExpiresAtSeconds;
    if (typeof expiresAt === 'number' && context.nowSeconds >= expiresAt) {
        return denyVerdict('authority-deny-grant-expired', `grant expired at ${expiresAt}; now is ${context.nowSeconds}`, null, null);
    }
    const matched = policy.rules.filter((rule) => ruleMatchesAction(rule, action));
    if (matched.length === 0) {
        // Structural default-deny: not an `else`, the absence of a match.
        const what = action.kind === 'contract-call'
            ? `${action.target} ${action.selector} (${action.functionName})`
            : `${action.verifyingContract} ${action.primaryType}`;
        return denyVerdict('authority-deny-no-matching-rule', `no rule in this scope permits ${what}`, null, null);
    }
    if (matched.length > 1) {
        // Unreachable via compileAuthorityPolicy, which rejects overlaps. Kept
        // because a hand-built CompiledAuthorityPolicy would otherwise get the union
        // semantics DG-3 warns about, silently.
        return unresolvedVerdict('authority-policy-ambiguous-match', `rules [${matched.map((r) => r.id).join(', ')}] all match; overlapping ALLOW rules union their conditions and must be rejected at compile time`, matched[0].id, null);
    }
    const rule = matched[0];
    if (action.kind === 'contract-call' && action.value > rule.maxNativeValue) {
        return denyVerdict('authority-deny-value-not-permitted', `rule ${rule.id}: call attaches ${action.value} wei but the rule permits at most ${rule.maxNativeValue}`, rule.id, 'call.value');
    }
    for (const condition of rule.conditions) {
        const failure = evaluateCondition(condition, action, rule, context);
        if (failure !== null)
            return failure;
    }
    return {
        kind: 'permit',
        ruleId: rule.id,
        matched: rule.scope.kind === 'contract-call' ? rule.scope.functionName : rule.scope.primaryType
    };
}
/**
 * Convenience composition for the 4337 path: decode a UserOperation's `callData`
 * and evaluate the result.
 *
 * A decode failure is mapped to the verdict family it belongs to — "we cannot
 * tell what this calldata does" is `unresolved`, while a bare value transfer is a
 * definite `deny`. Both refuse; only the name differs, which is the whole point.
 */
export function authorizeUserOperationCall(policy, userOp, descriptors, context) {
    const described = describeUserOperationCall(userOp, descriptors);
    if (described.kind === 'failed') {
        if (described.code === 'authority-deny-bare-value-transfer') {
            return denyVerdict(described.code, described.reason, null, null);
        }
        return unresolvedVerdict(described.code, described.reason, null, null);
    }
    return evaluateAuthorityAction(policy, described.action, context);
}
//# sourceMappingURL=permission-policy.js.map