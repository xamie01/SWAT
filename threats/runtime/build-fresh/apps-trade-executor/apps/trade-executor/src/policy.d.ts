export type TradingMode = 'paper' | 'live';
export declare function parseTradingMode(value: string | undefined): TradingMode;
export declare function parseScore(value: unknown, label: string): number;
export declare function parsePositiveNumber(value: string | undefined, fallback: number, label: string): number;
export declare function parseNonNegativeNumber(value: string | undefined, fallback: number, label: string): number;
export declare function floorToPrecision(value: number, precision: number): number;
export declare function capPositionToAvailableBalance(opts: {
    requested: number;
    available: number;
    maximum: number;
    precision: number;
}): number;
export interface BalanceAwareSizingInput {
    balance: number;
    base: number;
    maximum: number;
    riskPct: number;
    tierMultiplier: number;
    scoreMultiplier: number;
    precision: number;
    dynamic: boolean;
}
/**
 * The size this configuration *asks for*, before any cap is applied.
 *
 * Extracted from `calculateBalanceAwareSize` rather than reimplemented, and it is
 * the only statement of the formula in this repo. `per-user-sizing.ts` needs the
 * pre-clamp figure so it can report *which* bound reduced a user's size — an
 * operator asking "why did I get 0.05 and not 0.2" cannot be answered from a
 * single already-clamped number. Deriving the request a second time there would
 * have put two copies of the sizing formula in the tree, and the copy that drifted
 * would misattribute the clamp while still returning a plausible size.
 *
 * Validation lives here, so both this and `calculateBalanceAwareSize` refuse the
 * same inputs.
 */
export declare function requestedBalanceAwareSize(opts: BalanceAwareSizingInput): number;
export declare function calculateBalanceAwareSize(opts: BalanceAwareSizingInput): number;
export declare function calculateRiskBasedSize(opts: {
    balance: number;
    riskPct: number;
    tierMultiplier: number;
    scoreMultiplier: number;
    maximum: number;
    precision: number;
}): number;
//# sourceMappingURL=policy.d.ts.map