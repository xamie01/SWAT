import type { LpChain } from '@swat/shared';
import { type UserScope } from '@swat/db';
/**
 * Reserve sub-vault (Track G3).
 *
 * The reserve is *not* a new custody path: the pointer stored in
 * `lp_guardrail_configs` names a user-owned vault account following the
 * existing non-custodial pattern (ADR-0003, `user_execution_grants`
 * `solana_vault` kind — the user is the sole withdrawer; the executor
 * authority can only move funds program-internally). This module resolves and
 * validates that pointer; the sweep port decides execution.
 *
 * Validation rules, fail-closed:
 *   - No pointer configured  → the guardrail config still works (banking is
 *     computed, the sweep port is told there is nowhere to move funds).
 *   - A pointer set without an active matching vault grant → refusing to
 *     sweep to an unvalidated address is the correct default; the user fixes
 *     the pointer or the grant, not the sweep.
 */
export interface ResolvedReserveVault {
    readonly chain: LpChain;
    readonly address: string;
    /** True when the pointer matched an active execution grant of the vault kind. */
    readonly grantValidated: boolean;
}
export interface VaultGrantPort {
    /** True when the user has an active vault-kind grant at this address. */
    hasActiveVaultGrant(userId: string, address: string): Promise<boolean>;
}
export declare function resolveReserveVault(scope: UserScope, grants: VaultGrantPort): Promise<ResolvedReserveVault | null>;
/**
 * Fail-closed guard used by the sweep port: a sweep to an unvalidated vault
 * must refuse, loudly, rather than move funds to whatever the pointer says.
 */
export declare function assertReserveVaultReady(scope: UserScope, grants: VaultGrantPort): Promise<ResolvedReserveVault>;
//# sourceMappingURL=reserve-vault.d.ts.map