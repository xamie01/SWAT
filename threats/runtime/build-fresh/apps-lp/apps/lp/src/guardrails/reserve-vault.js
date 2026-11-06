import { getLpGuardrailConfig, resolveLpGuardrailConfig } from '@swat/db';
export async function resolveReserveVault(scope, grants) {
    const config = await resolveLpGuardrailConfig(scope);
    const pointer = config.reserveSubVault;
    if (!pointer)
        return null;
    const grantValidated = await grants.hasActiveVaultGrant(scope.userId, pointer.address);
    return { chain: pointer.chain, address: pointer.address, grantValidated };
}
/**
 * Fail-closed guard used by the sweep port: a sweep to an unvalidated vault
 * must refuse, loudly, rather than move funds to whatever the pointer says.
 */
export async function assertReserveVaultReady(scope, grants) {
    const config = await getLpGuardrailConfig(scope);
    const resolved = await resolveReserveVault(scope, grants);
    if (!config?.reserveSubVault || !resolved) {
        throw new Error('no reserve sub-vault configured; set one in guardrail config first');
    }
    if (!resolved.grantValidated) {
        throw new Error('reserve sub-vault has no active vault execution grant; refusing to sweep to an unvalidated address');
    }
    return resolved;
}
//# sourceMappingURL=reserve-vault.js.map