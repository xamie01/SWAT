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
export declare function computeProfitBank(input: ProfitBankInput): ProfitBankDecision;
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
    sweep(request: ReserveSweepRequest): Promise<{
        receipt: string;
        executed: boolean;
    }>;
}
/** Runs the full sweep: compute, then move. Returns null when nothing was due. */
export declare function runProfitBankSweep(vault: ReserveVaultPort, input: ProfitBankInput & {
    readonly userId: string;
    readonly positionId: string;
    readonly trigger: 'position-close' | 'fee-harvest';
}): Promise<{
    decision: ProfitBankDecision;
    receipt: string | null;
}>;
//# sourceMappingURL=profit-bank.d.ts.map