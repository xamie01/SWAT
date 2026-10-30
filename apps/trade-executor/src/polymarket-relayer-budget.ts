/**
 * Daily relayer budget tracker for Polymarket Builder executions (S4-P15).
 *
 * Polymarket grants 10,000 builder executions/day. Relayer transactions cover
 * orders, approvals, and settlements.
 *
 * Bounded: tracks usage in a calendar day (UTC). When remaining budget drops to 0,
 * checks fail-closed with explicit code `polymarket-relayer-capacity-exhausted`
 * and skip-with-reason, rather than firing requests that burst into venue rejections.
 *
 * Configurable via `POLYMARKET_RELAYER_DAILY_BUDGET` (scales with growth, not a literal).
 */

export interface RelayerBudgetStatus {
  readonly allowed: boolean;
  readonly budget: number;
  readonly usedToday: number;
  readonly remaining: number;
  readonly reason?: string;
  readonly code?: 'polymarket-relayer-capacity-exhausted';
}

export class PolymarketRelayerBudgetTracker {
  private usedCount = 0;
  private currentDay: string = '';
  private readonly budget: number;

  constructor(budget?: number) {
    this.budget = budget ?? Number(process.env.POLYMARKET_RELAYER_DAILY_BUDGET ?? 10_000);
  }

  private resetIfNewDay(now: Date = new Date()): void {
    const today = now.toISOString().slice(0, 10);
    if (this.currentDay !== today) {
      this.currentDay = today;
      this.usedCount = 0;
    }
  }

  checkBudget(now: Date = new Date()): RelayerBudgetStatus {
    this.resetIfNewDay(now);
    const remaining = Math.max(0, this.budget - this.usedCount);

    if (this.usedCount >= this.budget) {
      return {
        allowed: false,
        budget: this.budget,
        usedToday: this.usedCount,
        remaining: 0,
        code: 'polymarket-relayer-capacity-exhausted',
        reason: `Polymarket daily relayer capacity exhausted (${this.usedCount}/${this.budget} used)`
      };
    }

    return {
      allowed: true,
      budget: this.budget,
      usedToday: this.usedCount,
      remaining
    };
  }

  recordExecution(now: Date = new Date()): void {
    this.resetIfNewDay(now);
    this.usedCount += 1;
  }

  setUsedForTest(count: number, now: Date = new Date()): void {
    this.currentDay = now.toISOString().slice(0, 10);
    this.usedCount = count;
  }

  reset(): void {
    this.usedCount = 0;
    this.currentDay = '';
  }
}

export const globalPolymarketRelayerBudget = new PolymarketRelayerBudgetTracker();
