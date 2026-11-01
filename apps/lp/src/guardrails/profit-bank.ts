/**
 * Profit-banking sweep (Track G2) — on position close or fee harvest, moves
 * the configured percent of realized gain to the user's reserve sub-vault.
 *
 * The pure core computes *what* to sweep; the port decides *how*. In paper
 * mode the sweep records intent (this service has no keys to move anything);
 * in live mode the port implementation would drive a vault transfer through
 * the existing non-custodial vault pattern (ADR-0003) — user-owned vault,
 * executor authority scoped to program-internal movements only.
 */

export interface ProfitBankInput {
  /** Realized gain on the close/harvest, USD. Non-positive gains sweep nothing. */
  readonly realizedGainUsd: number;
  /** Guardrail config percent, [0..100]. */
  readonly profitBankPct: number;
}

export interface ProfitBankDecision {
  /** Amount to move to the reserve, USD. */
  readonly sweepAmountUsd: number;
  /** Amount that stays in the operating position, USD. */
  readonly retainedUsd: number;
  readonly swept: boolean;
  readonly reason: string;
}

export function computeProfitBank(input: ProfitBankInput): ProfitBankDecision {
  if (!Number.isFinite(input.realizedGainUsd)) {
    throw new Error(`realizedGainUsd must be finite, got ${input.realizedGainUsd}`);
  }
  if (!Number.isFinite(input.profitBankPct) || input.profitBankPct < 0 || input.profitBankPct > 100) {
    throw new Error(`profitBankPct must be a percent in [0..100], got ${input.profitBankPct}`);
  }

  if (input.realizedGainUsd <= 0) {
    return {
      sweepAmountUsd: 0,
      retainedUsd: input.realizedGainUsd,
      swept: false,
      reason: 'no-realized-gain'
    };
  }
  if (input.profitBankPct === 0) {
    return {
      sweepAmountUsd: 0,
      retainedUsd: input.realizedGainUsd,
      swept: false,
      reason: 'profit-banking-disabled'
    };
  }

  const sweepAmountUsd = (input.realizedGainUsd * input.profitBankPct) / 100;
  return {
    sweepAmountUsd,
    retainedUsd: input.realizedGainUsd - sweepAmountUsd,
    swept: true,
    reason: `banking ${input.profitBankPct}% of realized gain`
  };
}

export interface ReserveSweepRequest {
  readonly userId: string;
  readonly positionId: string;
  readonly amountUsd: number;
  readonly trigger: 'position-close' | 'fee-harvest';
}

export interface ReserveVaultPort {
  /**
   * Executes (live) or records (paper) the sweep. Returns a receipt string
   * the caller can log and show — a sweep that silently no-ops is the
   * failure mode this port exists to prevent.
   */
  sweep(request: ReserveSweepRequest): Promise<{ receipt: string; executed: boolean }>;
}

/** Runs the full sweep: compute, then move. Returns null when nothing was due. */
export async function runProfitBankSweep(
  vault: ReserveVaultPort,
  input: ProfitBankInput & { readonly userId: string; readonly positionId: string; readonly trigger: 'position-close' | 'fee-harvest' }
): Promise<{ decision: ProfitBankDecision; receipt: string | null }> {
  const decision = computeProfitBank({
    realizedGainUsd: input.realizedGainUsd,
    profitBankPct: input.profitBankPct
  });
  if (!decision.swept) {
    return { decision, receipt: null };
  }
  const result = await vault.sweep({
    userId: input.userId,
    positionId: input.positionId,
    amountUsd: decision.sweepAmountUsd,
    trigger: input.trigger
  });
  return { decision, receipt: result.receipt };
}
