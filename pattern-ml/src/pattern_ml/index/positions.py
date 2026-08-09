"""Reconstruct round-trip positions from a flat trade stream.

Why this exists
---------------
A single trade has no outcome. "Did this KOL make money" only becomes a
question once an entry has been matched to its exits. Any supervised pattern
mining needs that label, so this module walks each (kol, market, outcome) group
in time order and folds buys and sells into positions.

Matching rule: **average-cost, flat-to-flat**. A position opens on the first
buy from zero inventory and closes when inventory returns to (approximately)
zero. Sells draw down cost basis at the running average entry price.

Why average-cost and not FIFO
-----------------------------
FIFO and LIFO both need a per-lot ledger, and they disagree with each other on
partial exits. Average-cost gives one unambiguous ROI per position, which is
what a label needs to be. The tradeoff is that it cannot express "sold the
first tranche at 3x and rode the rest to zero" as two separate results — that
shows up as one blended ROI. Documented rather than hidden because it changes
how ROI should be read.

Residual inventory
------------------
A position with inventory left over is genuinely unfinished and is marked
``is_closed = False``. These rows carry a null label and are excluded from
training — they are the single biggest source of survivorship bias in KOL
analysis, because the bags a KOL is still holding are disproportionately the
losers. ``label_coverage`` reports how many were dropped so the bias stays
visible rather than silent.
"""

from __future__ import annotations

import hashlib

import polars as pl

from ..schema import POSITION_SCHEMA, SIDE_BUY, conform, empty_frame

# Inventory below this fraction of peak holdings counts as flat. Exact zero
# never happens — dust, decimal rounding, and partial fills leave slivers.
FLAT_EPSILON = 1e-6
FLAT_FRACTION = 0.01


def _position_id(kol: str, market: str, outcome: str | None, opened_at: object) -> str:
    payload = f"{kol}|{market}|{outcome or ''}|{opened_at}"
    return hashlib.sha256(payload.encode()).hexdigest()[:32]


def build_positions(trades: pl.DataFrame) -> pl.DataFrame:
    """Fold a canonical trade frame into round-trip positions."""
    if trades.is_empty():
        return empty_frame(POSITION_SCHEMA)

    needed = {"kol_address", "market_id", "ts", "side", "qty", "size_usd"}
    missing = needed - set(trades.columns)
    if missing:
        raise ValueError(f"trades frame is missing columns: {sorted(missing)}")

    # Sort once; the fold below relies on time order within each group.
    df = trades.sort(["kol_address", "market_id", "outcome", "ts"])

    positions: list[dict[str, object]] = []
    group_keys = ["chain", "kol_address", "market_id", "outcome"]

    for keys, group in df.group_by(group_keys, maintain_order=True):
        chain, kol_address, market_id, outcome = keys

        # Running state for the open position, reset each time we go flat.
        open_pos: dict[str, object] | None = None
        qty_held = 0.0
        cost_basis = 0.0  # USD cost of currently-held inventory
        peak_qty = 0.0

        for row in group.iter_rows(named=True):
            side = row["side"]
            qty = row["qty"] or 0.0
            size_usd = row["size_usd"]
            fee = row["fee_usd"] or 0.0
            if qty <= 0:
                continue

            if side == SIDE_BUY:
                if open_pos is None:
                    open_pos = {
                        "position_id": _position_id(
                            kol_address, market_id, outcome, row["ts"]
                        ),
                        "chain": chain,
                        "kol_address": kol_address,
                        "kol_handle": row.get("kol_handle"),
                        "market_id": market_id,
                        "market_label": row.get("market_label"),
                        "outcome": outcome,
                        "opened_at": row["ts"],
                        "closed_at": None,
                        "entry_count": 0,
                        "exit_count": 0,
                        "cost_usd": 0.0,
                        "proceeds_usd": 0.0,
                        "qty_bought": 0.0,
                        "qty_sold": 0.0,
                        "fees_usd": 0.0,
                        # Track USD-priced quantity separately: trades with a
                        # null size_usd must not count toward the average price
                        # or they'd drag it toward zero.
                        "_priced_entry_qty": 0.0,
                        "_priced_exit_qty": 0.0,
                    }
                    qty_held = 0.0
                    cost_basis = 0.0
                    peak_qty = 0.0

                open_pos["entry_count"] = int(open_pos["entry_count"]) + 1
                open_pos["qty_bought"] = float(open_pos["qty_bought"]) + qty
                open_pos["fees_usd"] = float(open_pos["fees_usd"]) + fee
                qty_held += qty
                peak_qty = max(peak_qty, qty_held)
                if size_usd is not None:
                    open_pos["cost_usd"] = float(open_pos["cost_usd"]) + size_usd
                    open_pos["_priced_entry_qty"] = (
                        float(open_pos["_priced_entry_qty"]) + qty
                    )
                    cost_basis += size_usd
                continue

            # SELL. A sell with no open position is either a short or an exit
            # from inventory acquired before our data window. Either way we
            # cannot compute a cost basis for it, so it is skipped rather than
            # recorded as a free-money position.
            if open_pos is None:
                continue

            sell_qty = min(qty, qty_held) if qty_held > 0 else 0.0
            if sell_qty <= 0:
                continue

            open_pos["exit_count"] = int(open_pos["exit_count"]) + 1
            open_pos["qty_sold"] = float(open_pos["qty_sold"]) + sell_qty
            open_pos["fees_usd"] = float(open_pos["fees_usd"]) + fee
            if size_usd is not None:
                # Pro-rate proceeds if we clipped the sell to held inventory.
                realized = size_usd * (sell_qty / qty) if qty else size_usd
                open_pos["proceeds_usd"] = float(open_pos["proceeds_usd"]) + realized
                open_pos["_priced_exit_qty"] = (
                    float(open_pos["_priced_exit_qty"]) + sell_qty
                )

            # Draw down basis at the running average cost.
            if qty_held > 0:
                cost_basis -= cost_basis * (sell_qty / qty_held)
            qty_held -= sell_qty

            flat_threshold = max(FLAT_EPSILON, peak_qty * FLAT_FRACTION)
            if qty_held <= flat_threshold:
                open_pos["closed_at"] = row["ts"]
                open_pos["residual_qty"] = max(qty_held, 0.0)
                positions.append(open_pos)
                open_pos = None
                qty_held = 0.0
                cost_basis = 0.0
                peak_qty = 0.0

        # Whatever is still open at the end of the stream stays open.
        if open_pos is not None:
            open_pos["residual_qty"] = qty_held
            positions.append(open_pos)

    if not positions:
        return empty_frame(POSITION_SCHEMA)

    out = pl.DataFrame(positions, infer_schema_length=None, strict=False)

    out = out.with_columns(
        is_closed=pl.col("closed_at").is_not_null(),
        hold_seconds=(
            pl.col("closed_at").cast(pl.Datetime("us", "UTC"))
            - pl.col("opened_at").cast(pl.Datetime("us", "UTC"))
        )
        .dt.total_seconds()
        .cast(pl.Float64),
        avg_entry_price=pl.when(pl.col("_priced_entry_qty") > 0)
        .then(pl.col("cost_usd") / pl.col("_priced_entry_qty"))
        .otherwise(None),
        avg_exit_price=pl.when(pl.col("_priced_exit_qty") > 0)
        .then(pl.col("proceeds_usd") / pl.col("_priced_exit_qty"))
        .otherwise(None),
    )

    # PnL is only meaningful for a closed position with a real cost basis.
    out = (
        out.with_columns(
            pnl_usd=pl.when(pl.col("is_closed") & (pl.col("cost_usd") > 0))
            .then(pl.col("proceeds_usd") - pl.col("cost_usd") - pl.col("fees_usd"))
            .otherwise(None)
        )
        .with_columns(
            roi=pl.when(pl.col("cost_usd") > 0)
            .then(pl.col("pnl_usd") / pl.col("cost_usd"))
            .otherwise(None)
        )
        .with_columns(
            is_win=pl.when(pl.col("pnl_usd").is_not_null())
            .then(pl.col("pnl_usd") > 0)
            .otherwise(None)
        )
    )

    return conform(out, POSITION_SCHEMA)


def label_coverage(positions: pl.DataFrame) -> dict[str, float | int]:
    """Report how much of the position set is actually labellable.

    Surfaced by the CLI because a low closed-position rate is the signal that
    survivorship bias is about to distort everything downstream.
    """
    if positions.is_empty():
        return {"positions": 0, "closed": 0, "labelled": 0, "closed_rate": 0.0}

    total = positions.height
    closed = int(positions.select(pl.col("is_closed").sum()).item() or 0)
    labelled = int(positions.select(pl.col("is_win").is_not_null().sum()).item() or 0)
    return {
        "positions": total,
        "closed": closed,
        "labelled": labelled,
        "closed_rate": round(closed / total, 4) if total else 0.0,
    }
