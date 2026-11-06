/** Stable label for a principal, for logs and reason strings. Never a key. */
export function describePrincipal(principal) {
    return principal.kind === 'operator' ? 'operator' : `user:${principal.userId}`;
}
export function denied(code, reason) {
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
function authorizeThrough(adapter, request) {
    if (adapter.chain !== request.chain) {
        return Promise.resolve(denied('authority-chain-mismatch', `${adapter.id} serves ${adapter.chain}, not ${request.chain}`));
    }
    if (!adapter.serves(request.principal)) {
        return Promise.resolve(denied('authority-principal-mismatch', `${adapter.id} does not serve ${describePrincipal(request.principal)}`));
    }
    return adapter.authorize(request).then((verdict) => {
        if (verdict.kind !== 'granted')
            return verdict;
        // Second half of the same guard, on the way out. An adapter that serves
        // operator requests must not hand back a grant stamped with a user
        // principal, and vice versa — that mismatch is what a silent fallback to
        // the operator's authority would look like from here.
        if (verdict.authority.principal.kind !== request.principal.kind) {
            return denied('authority-principal-mismatch', `${adapter.id} issued a ${verdict.authority.principal.kind} grant for `
                + `${describePrincipal(request.principal)}`);
        }
        if (request.principal.kind === 'user'
            && verdict.authority.principal.kind === 'user'
            && verdict.authority.principal.userId !== request.principal.userId) {
            return denied('authority-principal-mismatch', `${adapter.id} issued a grant for a different user than ${request.principal.userId}`);
        }
        if (verdict.authority.chain !== request.chain) {
            return denied('authority-chain-mismatch', `${adapter.id} issued a ${verdict.authority.chain} grant for ${request.chain}`);
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
export function createExecutionAuthorityRegistry(adapters) {
    return async (request) => {
        const adapter = adapters.find((candidate) => candidate.chain === request.chain && candidate.serves(request.principal));
        if (!adapter) {
            return denied('authority-adapter-missing', `No execution authority adapter serves ${describePrincipal(request.principal)} `
                + `on ${request.chain}`);
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
export function capabilityForSigningRequest(request) {
    return request.kind === 'eip712-typed-data'
        ? 'sign-typed-data'
        : 'sign-chain-transaction';
}
//# sourceMappingURL=execution-authority.js.map