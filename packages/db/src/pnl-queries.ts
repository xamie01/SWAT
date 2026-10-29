import { fetchTokenPriceUsd, isChain } from '@swat/shared';
import { query } from './client.js';
import { calculateAverageCostPnl } from './pnl-math.js';
import type { PositionLedgerTrade, PositionPnl } from './pnl-math.js';
import type { OpenPositionSnapshot } from './stop-loss.js';

export { calculateAverageCostPnl, markToMarketPnl } from './pnl-math.js';
// The argument and result types, not just the functions (`S4-M28`). Re-exporting
// only the functions left every consumer outside this package unable to name what
// `calculateAverageCostPnl` takes -- `apps/scorer/src/master-metrics.test.ts` had to
// carry a hand-rolled structural copy of `PositionLedgerTrade`, which is free to
// drift from the real one with nothing to catch it. Not a stale-dist symptom: the
// gap was in `src` too.
export type { PositionLedgerTrade, PositionPnl } from './pnl-math.js';

type PositionTrade = {
  signal_id: string;
  user_id: string | null;
  token_mint: string;
  direction: 'buy' | 'sell';
  token_amount: number | string | null;
  amount_usd: number | string | null;
  price_usd: number | string | null;
  fee_usd: number | string | null;
};

type OpenMasterLot = {
  lot_id: string;
  signal_id: string;
  user_id: string;
  master_wallet_address: string;
  token_mint: string;
  chain: string;
  remaining_quantity: number | string;
  remaining_cost_basis_usd: number | string | null;
};

/**
 * One tenant's slice of one signal's trade ledger -- the unit this pass values.
 *
 * ## Why the ledger gained a dimension (`S4-M46`)
 *
 * It used to be keyed by `signal_id` alone. `trades.user_id` has existed since
 * migration 050 and this query never read it, so **every user's trades on one signal
 * merged into a single position**. Two consequences, both silent:
 *
 *   1. The average cost basis was blended across tenants. User A buying at $1 and
 *      user B buying at $2 produced one $1.50 basis, so B's drawdown was measured
 *      against money A spent.
 *   2. Downstream, `signal_stop_losses` is `PRIMARY KEY (account, signal_id)`. One
 *      merged position yields one claim, so **the first user to breach claimed the
 *      signal and every other holder was never sold** -- and the sweep reported
 *      success, having protected one of them.
 *
 * `S4-M16` describes the per-user risk work as "substitute the user key for
 * `'operator'`". That phrasing hides this: no substitution reaches a query that has
 * no user dimension to substitute into. The dimension has to exist first.
 */
type LedgerKey = {
  readonly signalId: string;
  /** `null` IS the pre-tenancy operator account (migration 050 backfills nothing). */
  readonly userId: string | null;
};

/**
 * NUL, as `copy-trade-lifecycle.ts` uses it for `COPY_IDENTITY_SEPARATOR`: a UUID
 * cannot contain one, so no pair of distinct `(signal, user)` keys can collide into a
 * single string.
 */
const LEDGER_KEY_SEPARATOR = String.fromCharCode(0);

/**
 * Stands in for the operator's `null` in a map key.
 *
 * A reserved marker rather than the empty string, so an operator group can never
 * collide with an empty user id. The leading space is what reserves it: it cannot be a
 * UUID.
 */
const OPERATOR_LEDGER_MARKER = ' operator';

/** Map key for a `(signal, user)` pair. */
function ledgerKey(signalId: string, userId: string | null): string {
  return `${signalId}${LEDGER_KEY_SEPARATOR}${userId ?? OPERATOR_LEDGER_MARKER}`;
}

/** What one `(signal, user)` ledger resolved to, before the signal-level rollup. */
type ValuedLedger = {
  readonly key: LedgerKey;
  readonly tokenMint: string;
  readonly pnl: PositionPnl;
  readonly currentPriceUsd: number | null;
};

export type MarkToMarketResult = {
  /** Signals whose `pnl_usd` / `realized_pnl_usd` / `unrealized_pnl_usd` were written. */
  updated: number;
  /**
   * `(signal, user)` ledgers that could not be valued, counted per ledger rather than
   * per signal. With one tenant -- every row at `user_id NULL` -- the two are the same
   * number, which is why the pre-`S4-M46` counts are unchanged.
   */
  skipped: number;
  /**
   * Every still-open position this pass priced, one per `(signal, user)`.
   *
   * This is the stop-loss sweep's input, so it is also the reason the sweep needs no
   * subscription lookup: a user appears here because they hold something, not because
   * a subscription row says they should.
   */
  positions: OpenPositionSnapshot[];
};

/**
 * Recompute realized and unrealized average-cost P&L from ordered filled trades.
 * Token prices are fetched once per distinct mint and only for open positions.
 *
 * Also returns a snapshot of every still-open position it priced, so stop-loss
 * enforcement can reuse this pass instead of re-querying the ledger and
 * re-fetching prices on its own schedule.
 *
 * ## Two groupings, deliberately
 *
 * Valuation is per `(signal, user)` -- see `LedgerKey` for why. The `signals` table has
 * no user dimension (`001_init.sql` / `025`), so its three P&L columns stay a
 * platform-wide total, and this pass writes them by **summing the per-user results**.
 *
 * That sum is not an approximation of the old merged number, it is a correction of it.
 * Realized P&L, unrealized P&L, open quantity and open cost basis are all additive over
 * disjoint sub-ledgers; average unit *cost* is not. Valuing each tenant against their
 * own basis and adding is right; blending the bases first and then valuing invents a
 * cost neither tenant paid. With a single tenant the two agree exactly, which is what
 * keeps the operator path byte-identical.
 *
 * ## A partly unvaluable cohort does not produce a signal-level number
 *
 * If any one tenant's slice of a signal is unusable (oversold ledger, mixed mints, no
 * price), the signal's total is unknown and the UPDATE is skipped rather than written
 * from the tenants that did resolve. A total that silently omits a holder is a
 * fabricated input to the performance dashboard. The tenants that *did* resolve still
 * get their `positions` entry, because an open position needs a stop-loss regardless of
 * whether some other tenant's books balance.
 */
export async function markToMarketOpenPositions(
  signalId?: string
): Promise<MarkToMarketResult> {
  const trades = await query<PositionTrade>(`
    SELECT
      t.signal_id,
      t.user_id,
      t.token_mint,
      t.direction,
      t.token_amount,
      t.amount_usd,
      t.price_usd,
      t.fee_usd
    FROM trades t
    WHERE t.signal_id IS NOT NULL
      AND t.status IN ('filled', 'partial')
      AND t.direction IN ('buy', 'sell')
      AND (t.execution_mode IS NULL OR t.execution_mode != 'shadow')
      AND ($1::uuid IS NULL OR t.signal_id = $1)
    ORDER BY t.signal_id, t.user_id, t.executed_at, t.id
  `, [signalId ?? null]);

  // `ORDER BY ... t.user_id ...` keeps each tenant's rows contiguous and in execution
  // order, which is what average-cost accounting requires. Grouping in TypeScript
  // rather than in SQL for the reason `listFanoutCandidates` gives: the rules below
  // (what makes a ledger unusable, when an unknown must stay unknown) are decisions,
  // and a decision buried in SQL is one no unit test in this repo can reach.
  const grouped = new Map<string, { key: LedgerKey; trades: PositionTrade[] }>();
  for (const trade of trades) {
    const mapKey = ledgerKey(trade.signal_id, trade.user_id);
    const group = grouped.get(mapKey)
      ?? { key: { signalId: trade.signal_id, userId: trade.user_id }, trades: [] };
    group.trades.push(trade);
    grouped.set(mapKey, group);
  }

  const priceCache = new Map<string, number | null>();
  const positions: OpenPositionSnapshot[] = [];
  let skipped = 0;

  // Lot rows are the authoritative tenant/master identity once confirmed copy
  // evidence has created them. The trade-ledger path remains the compatibility
  // fallback for legacy rows and for tenants whose evidence predates migration 058.
  const hasTenantLedger = [...grouped.values()].some((group) => group.key.userId !== null);
  const openMasterLots = hasTenantLedger
    ? await query<OpenMasterLot>(
        `SELECT
           lot.id AS lot_id,
           lot.signal_id,
           lot.user_id,
           lot.master_wallet_address,
           lot.token_mint,
           lot.chain,
           lot.remaining_quantity,
           lot.remaining_cost_basis_usd
           FROM copy_position_master_lots lot
          WHERE lot.remaining_quantity > 0
            AND ($1::uuid IS NULL OR lot.signal_id = $1)
          ORDER BY lot.signal_id, lot.user_id, lot.master_wallet_address, lot.acquired_at, lot.id`,
        [signalId ?? null]
      )
    : [];
  const lotsByLedger = new Map<string, OpenMasterLot[]>();
  for (const lot of openMasterLots) {
    const key = ledgerKey(lot.signal_id, lot.user_id);
    const existing = lotsByLedger.get(key);
    if (existing) existing.push(lot);
    else lotsByLedger.set(key, [lot]);
  }

  // Per signal: every ledger that resolved, and whether any failed to. Both are needed
  // before a signal-level total can be written, so the rollup happens after the loop.
  const bySignal = new Map<string, { valued: ValuedLedger[]; incomplete: boolean }>();
  const signalEntry = (id: string) => {
    const existing = bySignal.get(id);
    if (existing) return existing;
    const created = { valued: [] as ValuedLedger[], incomplete: false };
    bySignal.set(id, created);
    return created;
  };

  for (const group of grouped.values()) {
    const entry = signalEntry(group.key.signalId);
    const tokenMint = group.trades[0]?.token_mint;
    if (!tokenMint) {
      skipped++;
      entry.incomplete = true;
      continue;
    }
    if (group.trades.some((trade) => trade.token_mint !== tokenMint)) {
      skipped++;
      entry.incomplete = true;
      continue;
    }

    const ledgerTrades: PositionLedgerTrade[] = group.trades.map((trade) => {
      const tokenAmount = Number(trade.token_amount);
      const explicitAmountUsd = trade.amount_usd == null ? null : Number(trade.amount_usd);
      const priceUsd = trade.price_usd == null ? null : Number(trade.price_usd);
      const feeUsd = trade.fee_usd == null ? 0 : Number(trade.fee_usd);
      const amountUsd = explicitAmountUsd ?? (
        priceUsd !== null && Number.isFinite(priceUsd) ? tokenAmount * priceUsd : Number.NaN
      );
      return { direction: trade.direction, tokenAmount, amountUsd, feeUsd };
    });

    let openQuantity = 0;
    let ledgerValid = true;
    for (const trade of ledgerTrades) {
      if (!Number.isFinite(trade.tokenAmount) || trade.tokenAmount <= 0) {
        ledgerValid = false;
        break;
      }
      openQuantity += trade.direction === 'buy' ? trade.tokenAmount : -trade.tokenAmount;
      if (openQuantity < -1e-12) {
        ledgerValid = false;
        break;
      }
    }
    if (!ledgerValid) {
      skipped++;
      entry.incomplete = true;
      continue;
    }

    let currentPrice: number | null = null;
    if (openQuantity > 1e-12) {
      const cached = priceCache.get(tokenMint);
      if (cached !== undefined) {
        currentPrice = cached;
      } else {
        currentPrice = await fetchTokenPriceUsd(tokenMint);
        priceCache.set(tokenMint, currentPrice);

        if (currentPrice !== null) {
          const sep = tokenMint.indexOf(':');
          const chain = sep >= 0 ? tokenMint.slice(0, sep) : 'solana';
          await query(`
            INSERT INTO price_snapshots (token_mint, chain, price_usd, snapshot_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (token_mint, chain, snapshot_at) DO NOTHING
          `, [tokenMint, chain, currentPrice]).catch((error) => {
            console.error('[db] failed to save price snapshot', error);
          });
        }
      }
    }

    const pnl = calculateAverageCostPnl(ledgerTrades, currentPrice);
    if (pnl === null) {
      skipped++;
      entry.incomplete = true;
      continue;
    }

    entry.valued.push({ key: group.key, tokenMint, pnl, currentPriceUsd: currentPrice });

    const lots = group.key.userId === null
      ? []
      : lotsByLedger.get(ledgerKey(group.key.signalId, group.key.userId)) ?? [];
    const snapshotLots = lots.length > 0 ? lots : [null];
    for (const lot of snapshotLots) {
      const lotQuantity = lot ? Number(lot.remaining_quantity) : pnl.openQuantity;
      const lotCostBasis = lot
        ? (lot.remaining_cost_basis_usd === null ? null : Number(lot.remaining_cost_basis_usd))
        : pnl.openCostBasisUsd;
      if (!Number.isFinite(lotQuantity) || lotQuantity <= 1e-12) continue;
      if (lotCostBasis === null || !Number.isFinite(lotCostBasis) || currentPrice === null) continue;
      const separator = tokenMint.indexOf(':');
      const chain = separator >= 0 ? tokenMint.slice(0, separator) : 'solana';
      if (!isChain(chain)) continue;
      positions.push({
        signalId: group.key.signalId,
        userId: group.key.userId,
        ...(lot ? { positionKey: lot.lot_id } : {}),
        tokenMint,
        chain,
        openQuantity: lotQuantity,
        openCostBasisUsd: lotCostBasis,
        unrealizedPnlUsd: lotQuantity * currentPrice - lotCostBasis,
        currentPriceUsd: currentPrice
      });
    }
  }

  let updated = 0;
  for (const [signal, entry] of bySignal) {
    if (entry.incomplete || entry.valued.length === 0) continue;

    let totalPnlUsd = 0;
    let realizedPnlUsd = 0;
    let unrealizedPnlUsd = 0;
    for (const ledger of entry.valued) {
      totalPnlUsd += ledger.pnl.totalPnlUsd;
      realizedPnlUsd += ledger.pnl.realizedPnlUsd;
      unrealizedPnlUsd += ledger.pnl.unrealizedPnlUsd;
    }

    await query(
      `UPDATE signals
          SET pnl_usd = $1,
              realized_pnl_usd = $2,
              unrealized_pnl_usd = $3
        WHERE id = $4`,
      [totalPnlUsd, realizedPnlUsd, unrealizedPnlUsd, signal]
    );
    updated++;
  }

  return { updated, skipped, positions };
}
