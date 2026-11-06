import { query } from './client.js';
/**
 * Per-user LP risk guardrails (`059`, Track A3 / Track G).
 *
 * These are the thresholds Track G1/G2 enforce. The defaults here are the build
 * plan's: no single pool may hold more than 50% of a user's deployed LP
 * capital, and 50% of realized profit is swept to the reserve sub-vault. A user
 * with no row gets exactly these defaults — the config is a preference, so its
 * absence must read as "defaults", not as "no guardrails".
 */
export const DEFAULT_LP_GUARDRAIL_CONFIG = {
    maxPoolAllocationPct: 50,
    profitBankPct: 50
};
const GUARDRAIL_COLUMNS = 'user_id, max_pool_allocation_pct, profit_bank_pct, reserve_sub_vault_chain, reserve_sub_vault_address, updated_at';
function toConfig(row) {
    return {
        userId: row.user_id,
        maxPoolAllocationPct: Number(row.max_pool_allocation_pct),
        profitBankPct: Number(row.profit_bank_pct),
        reserveSubVault: row.reserve_sub_vault_chain && row.reserve_sub_vault_address
            ? { chain: row.reserve_sub_vault_chain, address: row.reserve_sub_vault_address }
            : null,
        updatedAt: row.updated_at
    };
}
export async function getLpGuardrailConfig(scope) {
    const rows = await query(`SELECT ${GUARDRAIL_COLUMNS} FROM lp_guardrail_configs WHERE user_id = $1`, [scope.userId]);
    return rows[0] ? toConfig(rows[0]) : null;
}
/** Row or plan defaults — callers never branch on null. */
export async function resolveLpGuardrailConfig(scope) {
    const stored = await getLpGuardrailConfig(scope);
    return (stored ?? {
        userId: scope.userId,
        maxPoolAllocationPct: DEFAULT_LP_GUARDRAIL_CONFIG.maxPoolAllocationPct,
        profitBankPct: DEFAULT_LP_GUARDRAIL_CONFIG.profitBankPct,
        reserveSubVault: null,
        updatedAt: new Date(0)
    });
}
function assertPercent(name, value, minimumExclusive) {
    const inRange = minimumExclusive
        ? value > 0 && value <= 100
        : value >= 0 && value <= 100;
    if (!Number.isFinite(value) || !inRange) {
        const bound = minimumExclusive ? '(0..100]' : '[0..100]';
        throw new Error(`lp_guardrail_configs.${name} must be a finite percent ${bound}, got ${value}`);
    }
}
/**
 * Writes the whole config. Partial inputs keep their previous value where a row
 * exists and fall back to plan defaults where one does not, so a caller that
 * only flips `profitBankPct` cannot accidentally wipe the reserve pointer.
 */
export async function upsertLpGuardrailConfig(scope, input) {
    const existing = await getLpGuardrailConfig(scope);
    const maxPoolAllocationPct = input.maxPoolAllocationPct ??
        existing?.maxPoolAllocationPct ??
        DEFAULT_LP_GUARDRAIL_CONFIG.maxPoolAllocationPct;
    const profitBankPct = input.profitBankPct ?? existing?.profitBankPct ?? DEFAULT_LP_GUARDRAIL_CONFIG.profitBankPct;
    const reserveSubVault = input.reserveSubVault === undefined ? (existing?.reserveSubVault ?? null) : input.reserveSubVault;
    assertPercent('max_pool_allocation_pct', maxPoolAllocationPct, true);
    assertPercent('profit_bank_pct', profitBankPct, false);
    const rows = await query(`INSERT INTO lp_guardrail_configs
       (user_id, max_pool_allocation_pct, profit_bank_pct,
        reserve_sub_vault_chain, reserve_sub_vault_address, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET max_pool_allocation_pct   = EXCLUDED.max_pool_allocation_pct,
           profit_bank_pct           = EXCLUDED.profit_bank_pct,
           reserve_sub_vault_chain   = EXCLUDED.reserve_sub_vault_chain,
           reserve_sub_vault_address = EXCLUDED.reserve_sub_vault_address,
           updated_at                = EXCLUDED.updated_at
     RETURNING ${GUARDRAIL_COLUMNS}`, [
        scope.userId,
        maxPoolAllocationPct,
        profitBankPct,
        reserveSubVault?.chain ?? null,
        reserveSubVault?.address ?? null
    ]);
    return toConfig(rows[0]);
}
//# sourceMappingURL=lp-guardrails.js.map