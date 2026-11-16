"""Turn raw source rows into the canonical trade schema.

Kept separate from sourcing so it can be re-run over the immutable Parquet
dumps whenever a rule changes, without re-pulling millions of rows.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import polars as pl

from ..schema import (
    CANONICAL_TRADE_SCHEMA,
    SIDE_BUY,
    SIDE_SELL,
    SOLANA_QUOTE_MINTS,
    conform,
    empty_frame,
)
from ..venues import resolve_venue

# Stablecoin mints are USD 1:1 for sizing purposes.
STABLE_MINTS: frozenset[str] = frozenset(
    {
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  # USDT
    }
)

SOL_MINTS: frozenset[str] = frozenset(
    {
        "So11111111111111111111111111111111111111112",  # wSOL
        "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
        "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    }
)

LAMPORTS_PER_SOL = 1_000_000_000

# Activity rows that change a Polymarket position's share balance. REDEEM is
# how a winning position actually closes; without it winners look permanently
# open and the labelled set collapses to losers.
_PM_CLOSE_TYPES = {"REDEEM", "MERGE", "CONVERSION"}


def _trade_id(*parts: object) -> str:
    """Content-addressed trade id — the dedupe key.

    Deterministic across re-runs, so re-normalizing the same raw file inserts
    nothing new.
    """
    payload = "|".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(payload.encode()).hexdigest()[:32]


def _to_utc(epoch_seconds: Any) -> datetime | None:
    if isinstance(epoch_seconds, str):
        epoch_seconds = int(epoch_seconds) if epoch_seconds.isdigit() else None
    if not isinstance(epoch_seconds, (int, float)) or epoch_seconds <= 0:
        return None
    return datetime.fromtimestamp(float(epoch_seconds), tz=timezone.utc)


def _f(value: Any) -> float | None:
    """Coerce API numerics — which arrive as both strings and numbers."""
    if value is None or value == "":
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out else None  # drop NaN


# -----------------------------------------------------------------------------
# Polymarket
# -----------------------------------------------------------------------------


def normalize_polymarket(raw: pl.DataFrame) -> pl.DataFrame:
    """Map Polymarket activity rows onto the canonical schema.

    ``price`` here is an implied probability in [0,1], not a dollar price. A
    REDEEM settles at 1.0 per winning share by definition, which is what makes
    the position ledger balance.
    """
    if raw.is_empty():
        return empty_frame(CANONICAL_TRADE_SCHEMA)

    rows: list[dict[str, Any]] = []
    for row in raw.iter_rows(named=True):
        activity_type = (row.get("type") or "").upper()
        if activity_type != "TRADE" and activity_type not in _PM_CLOSE_TYPES:
            continue

        ts = _to_utc(row.get("timestamp"))
        if ts is None:
            continue

        size = _f(row.get("size")) or 0.0
        usdc_size = _f(row.get("usdcSize"))
        price = _f(row.get("price"))

        if activity_type == "TRADE":
            side = SIDE_BUY if (row.get("side") or "").upper() == "BUY" else SIDE_SELL
            if usdc_size is None and price is not None:
                usdc_size = size * price
        else:
            # A redemption/merge removes shares and returns cash: an exit.
            side = SIDE_SELL
            # Per the Data API spec, on a REDEEM row ``usdcSize`` *is* the payout
            # for that row's outcome, and it is exactly **0** for a losing
            # outcome (one row is emitted per outcome). So the payout is
            # authoritative and the price must be derived from it.
            #
            # Defaulting to 1.0 when the payout is zero — which a truthiness
            # check does, since `0 and size` is falsy — would price every
            # redeemed loser at a full $1 payout and turn losses into
            # break-evens. That is exactly the label corruption `/activity` was
            # chosen to avoid, so the check is explicitly `is not None`.
            if usdc_size is not None and size:
                price = usdc_size / size
            elif price is None:
                # The API gave us neither a payout nor a price. A winning share
                # settles at $1; this is the only branch where that is a guess.
                price = 1.0
            if usdc_size is None:
                usdc_size = size * price

        tx_ref = row.get("transactionHash")
        market_id = row.get("conditionId")

        rows.append(
            {
                "trade_id": _trade_id(
                    "polymarket",
                    tx_ref,
                    market_id,
                    row.get("asset"),
                    activity_type,
                    side,
                    size,
                    row.get("timestamp"),
                ),
                "chain": "polymarket",
                "kol_address": row.get("_kol_address"),
                "kol_handle": row.get("_kol_handle"),
                "ts": ts,
                "venue": (
                    "polymarket-clob"
                    if activity_type == "TRADE"
                    else f"polymarket-{activity_type.lower()}"
                ),
                "market_id": market_id,
                "market_label": row.get("title"),
                "outcome": row.get("outcome"),
                "side": side,
                "price": price,
                "qty": size,
                "size_usd": usdc_size,
                # The activity feed does not break out fees per row. Left null
                # rather than guessed — the backtester applies its own fee model.
                "fee_usd": None,
                "tx_ref": tx_ref,
                "raw_file": row.get("_raw_file"),
            }
        )

    if not rows:
        return empty_frame(CANONICAL_TRADE_SCHEMA)
    return conform(pl.DataFrame(rows), CANONICAL_TRADE_SCHEMA)


# -----------------------------------------------------------------------------
# Solana
# -----------------------------------------------------------------------------


def _instructions(payload: str | None) -> list[dict]:
    """Decode the stored instruction list; an unusable payload yields nothing.

    A missing or malformed payload must not raise: `resolve_venue` falls back to
    the Helius source label, so the row survives with a coarser venue rather
    than being dropped.
    """
    if not payload:
        return []
    try:
        decoded = json.loads(payload)
    except (TypeError, ValueError):
        return []
    return decoded if isinstance(decoded, list) else []


def _swap_legs(events_json: str | None) -> tuple[list[dict], list[dict]] | None:
    """Pull (inputs, outputs) out of a Helius parsed swap event."""
    if not events_json:
        return None
    try:
        events = json.loads(events_json)
    except (TypeError, ValueError):
        return None
    swap = (events or {}).get("swap")
    if not isinstance(swap, dict):
        return None

    inputs: list[dict] = [
        leg for leg in (swap.get("tokenInputs") or []) if isinstance(leg, dict)
    ]
    outputs: list[dict] = [
        leg for leg in (swap.get("tokenOutputs") or []) if isinstance(leg, dict)
    ]

    # Native SOL legs use a different shape and a different unit (lamports).
    native_in = swap.get("nativeInput")
    if isinstance(native_in, dict) and native_in.get("amount"):
        inputs.append({"_native": True, "amount": native_in.get("amount")})
    native_out = swap.get("nativeOutput")
    if isinstance(native_out, dict) and native_out.get("amount"):
        outputs.append({"_native": True, "amount": native_out.get("amount")})

    if not inputs and not outputs:
        return None
    return inputs, outputs


def _leg_mint_amount(leg: dict) -> tuple[str, float] | None:
    """Normalize a swap leg to (mint, human-readable amount)."""
    if leg.get("_native"):
        amount = _f(leg.get("amount"))
        if amount is None:
            return None
        return ("So11111111111111111111111111111111111111112", amount / LAMPORTS_PER_SOL)

    mint = leg.get("mint")
    if not mint:
        return None

    raw = leg.get("rawTokenAmount")
    if isinstance(raw, dict):
        amount = _f(raw.get("tokenAmount"))
        decimals = raw.get("decimals")
        if amount is not None and isinstance(decimals, int):
            return (mint, amount / (10**decimals))

    amount = _f(leg.get("tokenAmount"))
    if amount is None:
        return None
    return (mint, amount)


def _aggregate(pairs: list[tuple[str, float]]) -> dict[str, float]:
    """Sum per mint — a route can touch the same mint several times."""
    out: dict[str, float] = {}
    for mint, amount in pairs:
        out[mint] = out.get(mint, 0.0) + amount
    return out


def normalize_solana(
    raw: pl.DataFrame, *, sol_usd: dict[str, float] | None = None
) -> pl.DataFrame:
    """Map Helius swap transactions onto the canonical schema.

    One swap yields exactly one canonical row, describing what happened to the
    *non-quote* asset: swapping USDC into a memecoin is a BUY of that coin;
    swapping it back out is a SELL. Quote-to-quote swaps are dropped — they are
    treasury management, not directional trades, and would otherwise pollute
    every sizing and timing statistic.

    ``sol_usd`` maps ``YYYY-MM-DD`` to a SOL/USD close. Absent an entry, a
    SOL-quoted swap gets a null ``size_usd`` rather than a fabricated one.
    """
    if raw.is_empty():
        return empty_frame(CANONICAL_TRADE_SCHEMA)

    sol_usd = sol_usd or {}
    rows: list[dict[str, Any]] = []

    for row in raw.iter_rows(named=True):
        legs = _swap_legs(row.get("events_json"))
        if legs is None:
            continue
        inputs, outputs = legs

        in_pairs = [p for p in (_leg_mint_amount(leg) for leg in inputs) if p]
        out_pairs = [p for p in (_leg_mint_amount(leg) for leg in outputs) if p]
        if not in_pairs or not out_pairs:
            continue

        in_by_mint = _aggregate(in_pairs)
        out_by_mint = _aggregate(out_pairs)

        in_quote = {m: a for m, a in in_by_mint.items() if m in SOLANA_QUOTE_MINTS}
        out_quote = {m: a for m, a in out_by_mint.items() if m in SOLANA_QUOTE_MINTS}
        in_base = {m: a for m, a in in_by_mint.items() if m not in SOLANA_QUOTE_MINTS}
        out_base = {m: a for m, a in out_by_mint.items() if m not in SOLANA_QUOTE_MINTS}

        if out_base and in_quote:
            side = SIDE_BUY
            base_mint, base_qty = max(out_base.items(), key=lambda kv: kv[1])
            quote_mint, quote_qty = max(in_quote.items(), key=lambda kv: kv[1])
        elif in_base and out_quote:
            side = SIDE_SELL
            base_mint, base_qty = max(in_base.items(), key=lambda kv: kv[1])
            quote_mint, quote_qty = max(out_quote.items(), key=lambda kv: kv[1])
        else:
            # Quote-to-quote, or base-to-base with no quote leg to value it by.
            continue

        if base_qty <= 0 or quote_qty <= 0:
            continue

        ts = _to_utc(row.get("timestamp"))
        if ts is None:
            continue

        day = ts.strftime("%Y-%m-%d")

        # Value the quote leg in USD.
        if quote_mint in STABLE_MINTS:
            size_usd: float | None = quote_qty
        elif quote_mint in SOL_MINTS:
            rate = sol_usd.get(day)
            size_usd = quote_qty * rate if rate else None
        else:
            size_usd = None

        # Network fee is in lamports and paid in SOL.
        fee_lamports = _f(row.get("fee")) or 0.0
        sol_rate = sol_usd.get(day)
        fee_usd = (
            (fee_lamports / LAMPORTS_PER_SOL) * sol_rate if sol_rate and fee_lamports else None
        )

        signature = row.get("signature")
        # Venue from program ids, not from Helius's `source` label: the label
        # collapses every routed order to "JUPITER" and cannot tell a bonding
        # curve from an AMM. The choice-set builder needs that distinction to
        # know which board to reconstruct.
        venue, router = resolve_venue(
            _instructions(row.get("instructions_json")),
            helius_source=row.get("source"),
        )
        rows.append(
            {
                "trade_id": _trade_id("solana", signature, base_mint, side),
                "chain": "solana",
                "kol_address": row.get("_kol_address"),
                "kol_handle": row.get("_kol_handle"),
                "ts": ts,
                "venue": venue,
                "router": router,
                "market_id": base_mint,
                "market_label": None,  # token symbol resolved later, if at all
                "outcome": None,  # a token has no outcome
                "side": side,
                "price": (size_usd / base_qty) if size_usd else None,
                "qty": base_qty,
                "size_usd": size_usd,
                "fee_usd": fee_usd,
                "tx_ref": signature,
                "raw_file": row.get("_raw_file"),
            }
        )

    if not rows:
        return empty_frame(CANONICAL_TRADE_SCHEMA)
    return conform(pl.DataFrame(rows), CANONICAL_TRADE_SCHEMA)


def normalize_file(
    path: Path | str, chain: str, sol_usd: dict[str, float] | None = None
) -> pl.DataFrame:
    """Normalize one raw Parquet file, tagging rows with their provenance."""
    from ..config import CHAINS, confined_path, get_settings

    if chain not in CHAINS:
        raise ValueError(f"Unknown chain: {chain}")
    path = confined_path(Path(path), root=get_settings().raw_dir)
    df = pl.read_parquet(path)
    if df.is_empty():
        return empty_frame(CANONICAL_TRADE_SCHEMA)
    df = df.with_columns(pl.lit(str(path)).alias("_raw_file"))
    if chain == "polymarket":
        return normalize_polymarket(df)
    if chain == "solana":
        return normalize_solana(df, sol_usd=sol_usd)
    raise ValueError(f"Unknown chain: {chain}")
