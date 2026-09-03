"""The canonical cross-venue trade schema.

A Solana swap and a Polymarket share purchase are different animals. Unifying
them is what lets one model hunt for patterns across both, so the mapping is
made explicit here rather than being implied by whatever each source happens
to emit.

Field meanings that differ by venue:

===============  ==============================  ==============================
field            solana                          polymarket
===============  ==============================  ==============================
market_id        token mint address              condition_id (the market)
market_label     token symbol                    market question
outcome          NULL (a token has no outcome)   outcome name, e.g. "Yes"
price            USD per token                   implied probability, 0.0–1.0
qty              token units                     outcome shares
size_usd         notional USD moved              notional USD moved
===============  ==============================  ==============================

``price`` is deliberately NOT unit-normalized across venues — a Polymarket
price is bounded in [0,1] and carries probability semantics that a token price
does not. Anything comparing the two must use rank/percentile transforms,
never the raw number.
"""

from __future__ import annotations

import polars as pl

# Trade side, normalized. Polymarket BUY/SELL of an outcome maps directly;
# a Solana swap is a BUY of the non-quote leg and a SELL of the quote leg.
SIDE_BUY = "buy"
SIDE_SELL = "sell"

# Quote assets. A swap into one of these is an exit, not an entry.
SOLANA_QUOTE_MINTS: frozenset[str] = frozenset(
    {
        "So11111111111111111111111111111111111111112",  # wSOL
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  # USDT
        "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",   # mSOL
        "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",  # jitoSOL
    }
)

CANONICAL_TRADE_SCHEMA: dict[str, pl.DataType] = {
    # identity
    "trade_id": pl.Utf8,        # deterministic hash; the dedupe key
    "chain": pl.Utf8,           # solana | polymarket
    "kol_address": pl.Utf8,     # bare address, no chain prefix
    "kol_handle": pl.Utf8,
    # when
    "ts": pl.Datetime(time_unit="us", time_zone="UTC"),
    # what
    "venue": pl.Utf8,           # pump-bonding-curve | raydium-amm-v4 | polymarket-clob | …
    "router": pl.Utf8,          # aggregator the order went through, if any
    "market_id": pl.Utf8,
    "market_label": pl.Utf8,
    "outcome": pl.Utf8,
    # how
    "side": pl.Utf8,
    "price": pl.Float64,
    "qty": pl.Float64,
    "size_usd": pl.Float64,
    "fee_usd": pl.Float64,
    # provenance — every row traces back to an immutable raw file
    "tx_ref": pl.Utf8,          # signature (solana) | tx hash (polymarket)
    "raw_file": pl.Utf8,
}

# Reconstructed round-trip positions: an entry, its exits, and the outcome.
# This is the table any supervised model learns from — a trade's *result* only
# exists once it has been closed out.
POSITION_SCHEMA: dict[str, pl.DataType] = {
    "position_id": pl.Utf8,
    "chain": pl.Utf8,
    "kol_address": pl.Utf8,
    "kol_handle": pl.Utf8,
    "market_id": pl.Utf8,
    "market_label": pl.Utf8,
    "outcome": pl.Utf8,
    "opened_at": pl.Datetime(time_unit="us", time_zone="UTC"),
    "closed_at": pl.Datetime(time_unit="us", time_zone="UTC"),
    "is_closed": pl.Boolean,
    "hold_seconds": pl.Float64,
    "entry_count": pl.Int32,
    "exit_count": pl.Int32,
    "cost_usd": pl.Float64,      # total USD in
    "proceeds_usd": pl.Float64,  # total USD out
    "avg_entry_price": pl.Float64,
    "avg_exit_price": pl.Float64,
    "qty_bought": pl.Float64,
    "qty_sold": pl.Float64,
    "residual_qty": pl.Float64,  # >0 means still holding
    "fees_usd": pl.Float64,
    "pnl_usd": pl.Float64,
    "roi": pl.Float64,           # pnl / cost
    "is_win": pl.Boolean,
}


def empty_frame(schema: dict[str, pl.DataType]) -> pl.DataFrame:
    """A correctly-typed empty frame — so downstream code never special-cases
    "no data yet" with a differently-shaped DataFrame."""
    return pl.DataFrame(schema=schema)


def conform(df: pl.DataFrame, schema: dict[str, pl.DataType]) -> pl.DataFrame:
    """Force a frame into a schema: add missing columns as nulls, drop extras,
    order columns, and cast. Keeps every writer honest about the contract."""
    if df.is_empty():
        return empty_frame(schema)
    out = df
    for name, dtype in schema.items():
        if name not in out.columns:
            out = out.with_columns(pl.lit(None, dtype=dtype).alias(name))
    return out.select(
        [pl.col(name).cast(dtype, strict=False) for name, dtype in schema.items()]
    )
