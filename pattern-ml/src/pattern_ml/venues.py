"""Solana program IDs: which protocol actually handled a swap.

Why this exists
---------------
Helius stamps every enriched transaction with a coarse ``source`` label
("JUPITER", "PUMP_FUN", "RAYDIUM", often "UNKNOWN"). That is not enough to
reconstruct an opportunity set, for two reasons:

1. **Aggregators hide the venue.** A Jupiter swap routes *through* Raydium,
   Meteora, or a Pump.fun curve. "JUPITER" tells you the router the KOL clicked,
   not the market they entered. The pool type is the decision-relevant fact: a
   token still on a bonding curve is a completely different opportunity from the
   same token after it migrates to an AMM.
2. **The candidate query depends on it.** "What else was on screen" is a
   different question on a Pump.fun board (curves nearing migration) than on
   Raydium (pools created, or pools whose volume spiked). Without the venue
   there is nothing to query *against*.

So the venue is resolved from the program IDs in the transaction's outer and
inner instructions, and the aggregator is recorded separately as ``router``.

Confidence
----------
The four addresses the roster spec named — Pump.fun bonding curve, PumpSwap,
Raydium AMM V4, Jupiter V6 — are treated as given. The rest are from general
knowledge and carry ``verified=False``. ``pattern-ml venue-audit`` counts
program IDs appearing in real pulled data that this table does not know about,
which is how the gaps get found: by observation, not by guessing harder.
"""

from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from typing import Any, Iterable

import polars as pl

# What kind of market a program operates. This is the axis that decides which
# candidate query runs, so it is deliberately coarse.
KIND_BONDING_CURVE = "bonding-curve"
KIND_AMM = "amm"
KIND_CLMM = "clmm"          # concentrated liquidity — still an AMM for our purposes
KIND_AGGREGATOR = "aggregator"


@dataclass(frozen=True)
class Program:
    """One on-chain program we can recognise."""

    address: str
    venue: str
    kind: str
    # False for addresses carried from general knowledge rather than confirmed
    # against this project's own data. Surfaced by `venue-audit`.
    verified: bool = False

    @property
    def is_aggregator(self) -> bool:
        return self.kind == KIND_AGGREGATOR


# --- The registry ----------------------------------------------------------
# Order matters only for readability; resolution priority is set by KIND_RANK.

PROGRAMS: tuple[Program, ...] = (
    # Pump.fun — the bonding curve and the AMM tokens graduate onto.
    Program("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pump-bonding-curve",
            KIND_BONDING_CURVE, verified=True),
    Program("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "pumpswap",
            KIND_AMM, verified=True),
    # Raydium.
    Program("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "raydium-amm-v4",
            KIND_AMM, verified=True),
    Program("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "raydium-clmm", KIND_CLMM),
    Program("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", "raydium-cpmm", KIND_AMM),
    Program("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", "raydium-launchlab",
            KIND_BONDING_CURVE),
    # Meteora.
    Program("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "meteora-dlmm", KIND_CLMM),
    Program("Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", "meteora-pools", KIND_AMM),
    # Orca.
    Program("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "orca-whirlpool", KIND_CLMM),
    # Other launchpads.
    Program("MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG", "moonshot",
            KIND_BONDING_CURVE),
    # Aggregators — routers, never the venue itself.
    Program("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "jupiter-v6",
            KIND_AGGREGATOR, verified=True),
    Program("JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB", "jupiter-v4",
            KIND_AGGREGATOR),
    Program("6m2CDdhRgxpH4WjvdzxAYbGxwdGUz5MziiL5jek2kBma", "okx-dex", KIND_AGGREGATOR),
)

BY_ADDRESS: dict[str, Program] = {p.address: p for p in PROGRAMS}
BY_VENUE: dict[str, Program] = {p.venue: p for p in PROGRAMS}

# Infrastructure that appears in nearly every transaction. Excluded from the
# audit so a real unmapped DEX is not buried under 40,000 Token Program hits.
IGNORED_PROGRAMS: frozenset[str] = frozenset(
    {
        "11111111111111111111111111111111",              # System
        "ComputeBudget111111111111111111111111111111",   # Compute Budget
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   # SPL Token
        "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   # Token-2022
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  # Associated Token Account
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",   # Memo
        "Sysvar1nstructions1111111111111111111111111",   # Instructions sysvar
    }
)

# Which venue wins when a transaction touches several. A bonding curve is the
# most specific and most decision-relevant signal available: if a KOL's buy
# touched a curve at all, they were buying a pre-migration token, whatever else
# the route passed through. Aggregators rank last and are recorded as `router`.
KIND_RANK: dict[str, int] = {
    KIND_BONDING_CURVE: 0,
    KIND_CLMM: 1,
    KIND_AMM: 1,
    KIND_AGGREGATOR: 9,
}

# Venue used when no known program appears. Kept distinct from a null so the
# audit can separate "no instruction data captured" from "unrecognised program".
VENUE_UNKNOWN = "unknown"


def iter_program_ids(instructions: Iterable[Any]) -> list[str]:
    """Every program id in an instruction list, outer then inner, in order.

    Order is preserved because it is the tie-break when two venues of equal
    rank appear: the one that executed first is the one the route entered.
    """
    out: list[str] = []
    for instruction in instructions or ():
        if not isinstance(instruction, dict):
            continue
        program_id = instruction.get("programId")
        if isinstance(program_id, str) and program_id:
            out.append(program_id)
        for inner in instruction.get("innerInstructions") or ():
            if not isinstance(inner, dict):
                continue
            inner_id = inner.get("programId")
            if isinstance(inner_id, str) and inner_id:
                out.append(inner_id)
    return out


def resolve_venue(
    instructions: Iterable[Any], *, helius_source: str | None = None
) -> tuple[str, str | None]:
    """``(venue, router)`` for one transaction.

    ``venue`` is the protocol that held the market — a bonding curve or an AMM.
    ``router`` is the aggregator the KOL went through, if any, which is a fact
    about their tooling rather than about the opportunity.

    Falls back to Helius's ``source`` label when no known program is present, so
    a venue this registry has not learned yet still produces something usable
    downstream instead of a null that silently drops the row.
    """
    program_ids = iter_program_ids(instructions)

    router: str | None = None
    best: Program | None = None
    best_position = -1

    for position, program_id in enumerate(program_ids):
        program = BY_ADDRESS.get(program_id)
        if program is None:
            continue
        if program.is_aggregator:
            if router is None:
                router = program.venue
            continue
        rank = KIND_RANK.get(program.kind, 5)
        if best is None or rank < KIND_RANK.get(best.kind, 5):
            best, best_position = program, position

    if best is not None:
        return best.venue, router
    if router is not None:
        # Routed through an aggregator into a pool we do not recognise. The
        # router is the only thing known, and saying so beats claiming a venue.
        return router, router

    label = (helius_source or "").strip().lower()
    return (label or VENUE_UNKNOWN), None


def venue_kind(venue: str) -> str | None:
    """What kind of market a resolved venue is, or None if unrecognised."""
    program = BY_VENUE.get(venue)
    return program.kind if program else None


def unmapped_programs(raw: pl.DataFrame, *, top: int = 25) -> pl.DataFrame:
    """Program ids in pulled data that this registry does not recognise.

    The point of the whole module: rather than trusting a hand-written address
    list, count what actually shows up in the KOLs' own transactions. A program
    near the top of this table is a venue the choice-set builder is currently
    blind to.
    """
    schema = {"program_id": pl.Utf8, "transactions": pl.Int32}
    if raw.is_empty() or "instructions_json" not in raw.columns:
        return pl.DataFrame(schema=schema)

    counts: Counter[str] = Counter()
    for payload in raw["instructions_json"].to_list():
        if not payload:
            continue
        try:
            instructions = json.loads(payload)
        except (TypeError, ValueError):
            continue
        # Count once per transaction, not once per instruction — otherwise a
        # program invoked in a loop outranks one used by every swap.
        seen = {
            program_id
            for program_id in iter_program_ids(instructions)
            if program_id not in IGNORED_PROGRAMS and program_id not in BY_ADDRESS
        }
        counts.update(seen)

    if not counts:
        return pl.DataFrame(schema=schema)

    rows = [
        {"program_id": program_id, "transactions": count}
        for program_id, count in counts.most_common(top)
    ]
    return pl.DataFrame(rows).cast({"transactions": pl.Int32})
