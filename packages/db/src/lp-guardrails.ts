import type { LpChain } from '@swat/shared';
import { scopedQuery, withTenantTransaction, type UserScope } from './tenancy.js';

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
} as const;

export interface LpGuardrailConfig {
  readonly userId: string;
  readonly maxPoolAllocationPct: number;
  readonly profitBankPct: number;
  /** User-owned reserve account; `null` until the user designates one. */
  readonly reserveSubVault: { readonly chain: LpChain; readonly address: string } | null;
  readonly updatedAt: Date;
}

interface GuardrailRow {
  user_id: string;
  max_pool_allocation_pct: number | string;
  profit_bank_pct: number | string;
  reserve_sub_vault_chain: LpChain | null;
  reserve_sub_vault_address: string | null;
  updated_at: Date;
}

const GUARDRAIL_COLUMNS =
  'user_id, max_pool_allocation_pct, profit_bank_pct, reserve_sub_vault_chain, reserve_sub_vault_address, updated_at';

function toConfig(row: GuardrailRow): LpGuardrailConfig {
  return {
    userId: row.user_id,
    maxPoolAllocationPct: Number(row.max_pool_allocation_pct),
    profitBankPct: Number(row.profit_bank_pct),
    reserveSubVault:
      row.reserve_sub_vault_chain && row.reserve_sub_vault_address
        ? { chain: row.reserve_sub_vault_chain, address: row.reserve_sub_vault_address }
        : null,
    updatedAt: row.updated_at
  };
}

export async function getLpGuardrailConfig(scope: UserScope): Promise<LpGuardrailConfig | null> {
  const rows = await scopedQuery<GuardrailRow>(scope,
    `SELECT ${GUARDRAIL_COLUMNS} FROM lp_guardrail_configs WHERE user_id = $1`,
    [scope.userId]
  );
  return rows[0] ? toConfig(rows[0]) : null;
}

/** Row or plan defaults — callers never branch on null. */
export async function resolveLpGuardrailConfig(scope: UserScope): Promise<LpGuardrailConfig> {
  const stored = await getLpGuardrailConfig(scope);
  return (
    stored ?? {
      userId: scope.userId,
      maxPoolAllocationPct: DEFAULT_LP_GUARDRAIL_CONFIG.maxPoolAllocationPct,
      profitBankPct: DEFAULT_LP_GUARDRAIL_CONFIG.profitBankPct,
      reserveSubVault: null,
      updatedAt: new Date(0)
    }
  );
}

export interface UpsertLpGuardrailInput {
  readonly maxPoolAllocationPct?: number;
  readonly profitBankPct?: number;
  readonly reserveSubVault?: { readonly chain: LpChain; readonly address: string } | null;
}

function assertPercent(name: string, value: number, minimumExclusive: boolean): void {
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
export async function upsertLpGuardrailConfig(
  scope: UserScope,
  input: UpsertLpGuardrailInput
): Promise<LpGuardrailConfig> {
  return withTenantTransaction(scope, async client => {
  await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [scope.userId]);
  const stored = await client.query<GuardrailRow>(`SELECT ${GUARDRAIL_COLUMNS} FROM lp_guardrail_configs WHERE user_id = $1 FOR UPDATE`, [scope.userId]);
  const existing = stored.rows[0] ? toConfig(stored.rows[0]) : null;
  const maxPoolAllocationPct =
    input.maxPoolAllocationPct ??
    existing?.maxPoolAllocationPct ??
    DEFAULT_LP_GUARDRAIL_CONFIG.maxPoolAllocationPct;
  const profitBankPct =
    input.profitBankPct ?? existing?.profitBankPct ?? DEFAULT_LP_GUARDRAIL_CONFIG.profitBankPct;
  const reserveSubVault =
    input.reserveSubVault === undefined ? (existing?.reserveSubVault ?? null) : input.reserveSubVault;

  assertPercent('max_pool_allocation_pct', maxPoolAllocationPct, true);
  assertPercent('profit_bank_pct', profitBankPct, false);

  const rows = await client.query<GuardrailRow>(
    `INSERT INTO lp_guardrail_configs
       (user_id, max_pool_allocation_pct, profit_bank_pct,
        reserve_sub_vault_chain, reserve_sub_vault_address, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id) DO UPDATE
       SET max_pool_allocation_pct   = EXCLUDED.max_pool_allocation_pct,
           profit_bank_pct           = EXCLUDED.profit_bank_pct,
           reserve_sub_vault_chain   = EXCLUDED.reserve_sub_vault_chain,
           reserve_sub_vault_address = EXCLUDED.reserve_sub_vault_address,
           updated_at                = EXCLUDED.updated_at
     RETURNING ${GUARDRAIL_COLUMNS}`,
    [
      scope.userId,
      maxPoolAllocationPct,
      profitBankPct,
      reserveSubVault?.chain ?? null,
      reserveSubVault?.address ?? null
    ]
  );
  return toConfig(rows.rows[0]!);
  });
}
