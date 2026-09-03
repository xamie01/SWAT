"""Tests for program-id venue resolution.

The thing being protected: Helius's ``source`` label says "JUPITER" for every
routed swap, which makes a Pump.fun bonding-curve buy and a Raydium buy look
identical. They are not the same decision, and reconstructing them against the
same board would invent alternatives the trader never saw.
"""

from __future__ import annotations

import json

import polars as pl

from pattern_ml.venues import (
    BY_VENUE,
    KIND_AGGREGATOR,
    KIND_BONDING_CURVE,
    VENUE_UNKNOWN,
    resolve_venue,
    unmapped_programs,
    venue_kind,
)

PUMP = BY_VENUE["pump-bonding-curve"].address
PUMPSWAP = BY_VENUE["pumpswap"].address
RAYDIUM = BY_VENUE["raydium-amm-v4"].address
JUPITER = BY_VENUE["jupiter-v6"].address
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"


def instruction(program_id: str, inner: list[str] | None = None) -> dict:
    return {
        "programId": program_id,
        "innerInstructions": [{"programId": p} for p in (inner or [])],
    }


class TestVenueResolution:
    def test_a_direct_pool_swap_resolves_to_that_pool(self) -> None:
        venue, router = resolve_venue([instruction(RAYDIUM)])
        assert venue == "raydium-amm-v4"
        assert router is None

    def test_a_routed_swap_reports_the_pool_not_the_router(self) -> None:
        """The whole point: Jupiter is how they got there, not where they went."""
        venue, router = resolve_venue([instruction(JUPITER, inner=[RAYDIUM])])
        assert venue == "raydium-amm-v4"
        assert router == "jupiter-v6"

    def test_a_bonding_curve_wins_over_an_amm_in_the_same_transaction(self) -> None:
        """A curve is the most specific signal available.

        If a buy touched a curve at all, the token was pre-migration — which is
        a different opportunity from the same token on an AMM, and the fact the
        route also passed through a pool does not change that.
        """
        venue, _ = resolve_venue(
            [instruction(JUPITER, inner=[RAYDIUM, PUMP])]
        )
        assert venue == "pump-bonding-curve"
        assert venue_kind(venue) == KIND_BONDING_CURVE

    def test_pump_curve_and_pumpswap_are_not_conflated(self) -> None:
        """Helius labels both "PUMP_FUN"; they are different markets."""
        curve, _ = resolve_venue([instruction(PUMP)])
        amm, _ = resolve_venue([instruction(PUMPSWAP)])
        assert curve != amm
        assert venue_kind(curve) == KIND_BONDING_CURVE
        assert venue_kind(amm) != KIND_BONDING_CURVE

    def test_an_aggregator_alone_reports_itself_as_both(self) -> None:
        """Routed into a pool we cannot name.

        Reporting the router is honest — it says "we know how, not where". The
        assembler widens to all AMMs for these rather than dropping the row.
        """
        venue, router = resolve_venue([instruction(JUPITER, inner=[TOKEN_PROGRAM])])
        assert venue == "jupiter-v6"
        assert router == "jupiter-v6"
        assert venue_kind(venue) == KIND_AGGREGATOR

    def test_an_unknown_program_falls_back_to_the_helius_label(self) -> None:
        """A venue the registry has not learned still produces a usable row."""
        venue, router = resolve_venue(
            [instruction("SomeNewDexProgram11111111111111111111111")],
            helius_source="METEORA",
        )
        assert venue == "meteora"
        assert router is None

    def test_no_instructions_and_no_label_is_unknown_not_a_crash(self) -> None:
        assert resolve_venue([]) == (VENUE_UNKNOWN, None)
        assert resolve_venue(None) == (VENUE_UNKNOWN, None)  # type: ignore[arg-type]

    def test_malformed_instructions_are_skipped(self) -> None:
        venue, _ = resolve_venue(["not a dict", None, instruction(RAYDIUM)])
        assert venue == "raydium-amm-v4"


class TestUnmappedPrograms:
    def test_known_and_infrastructure_programs_are_excluded(self) -> None:
        """Otherwise the SPL Token Program buries every real finding."""
        raw = pl.DataFrame(
            {
                "instructions_json": [
                    json.dumps([instruction(RAYDIUM, inner=[TOKEN_PROGRAM])]),
                ]
            }
        )
        assert unmapped_programs(raw).is_empty()

    def test_an_unknown_program_is_counted(self) -> None:
        unknown = "NewDexProgram1111111111111111111111111111111"
        raw = pl.DataFrame(
            {
                "instructions_json": [
                    json.dumps([instruction(JUPITER, inner=[unknown])]),
                    json.dumps([instruction(unknown)]),
                ]
            }
        )
        result = unmapped_programs(raw)
        assert result.row(0, named=True) == {
            "program_id": unknown,
            "transactions": 2,
        }

    def test_a_program_is_counted_once_per_transaction(self) -> None:
        """A program invoked in a loop must not outrank one used by every swap."""
        unknown = "LoopyProgram111111111111111111111111111111"
        raw = pl.DataFrame(
            {
                "instructions_json": [
                    json.dumps(
                        [instruction(unknown, inner=[unknown, unknown, unknown])]
                    )
                ]
            }
        )
        assert result_count(unmapped_programs(raw), unknown) == 1

    def test_missing_column_returns_an_empty_frame(self) -> None:
        """Raw files pulled before venue resolution existed have no column."""
        raw = pl.DataFrame({"signature": ["abc"]})
        assert unmapped_programs(raw).is_empty()

    def test_malformed_json_does_not_crash_the_audit(self) -> None:
        raw = pl.DataFrame({"instructions_json": ["{not json", None]})
        assert unmapped_programs(raw).is_empty()


def result_count(frame: pl.DataFrame, program_id: str) -> int:
    match = frame.filter(pl.col("program_id") == program_id)
    return int(match.row(0, named=True)["transactions"]) if not match.is_empty() else 0
