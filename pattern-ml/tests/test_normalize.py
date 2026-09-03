"""Tests for source normalization.

Two things must hold for cross-venue analysis to mean anything: a Polymarket
REDEEM has to close the position it belongs to, and a Solana swap has to
resolve to the right side of the right asset. Both are easy to get subtly
wrong and neither fails loudly.
"""

from __future__ import annotations

import json

import polars as pl
import pytest

from pattern_ml.index.normalize import normalize_polymarket, normalize_solana

USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
WSOL = "So11111111111111111111111111111111111111112"
MEME = "MEMEcoin1111111111111111111111111111111111"


def pm_rows(rows: list[dict]) -> pl.DataFrame:
    filled = []
    for row in rows:
        filled.append(
            {
                "type": row.get("type", "TRADE"),
                "timestamp": row.get("timestamp", 1_770_000_000),
                "conditionId": row.get("conditionId", "0xmarket"),
                "asset": row.get("asset", "token-yes"),
                "side": row.get("side", "BUY"),
                "size": row.get("size", 100.0),
                "usdcSize": row.get("usdcSize", 40.0),
                "price": row.get("price", 0.4),
                "outcome": row.get("outcome", "Yes"),
                "title": row.get("title", "Will X happen?"),
                "transactionHash": row.get("transactionHash", "0xabc"),
                "_kol_address": "0xkol",
                "_kol_handle": "predictor",
                "_raw_file": "raw.parquet",
            }
        )
    return pl.DataFrame(filled)


def sol_row(events: dict, **kwargs) -> pl.DataFrame:
    return pl.DataFrame(
        [
            {
                "signature": kwargs.get("signature", "sig1"),
                "timestamp": kwargs.get("timestamp", 1_770_000_000),
                "slot": 1,
                "fee": kwargs.get("fee", 5000),
                "source": kwargs.get("source", "JUPITER"),
                "type": "SWAP",
                "description": "",
                "feePayer": "KOL",
                "events_json": json.dumps(events),
                "token_transfers_json": "[]",
                "native_transfers_json": "[]",
                "instructions_json": json.dumps(kwargs.get("instructions", [])),
                "_kol_address": "KOL",
                "_kol_handle": "kol",
                "_raw_file": "raw.parquet",
            }
        ]
    )


SWAP_USDC_INTO_MEME = {
    "swap": {
        "tokenInputs": [
            {"mint": USDC, "rawTokenAmount": {"tokenAmount": "1000000", "decimals": 6}}
        ],
        "tokenOutputs": [
            {"mint": MEME, "rawTokenAmount": {"tokenAmount": "1000000", "decimals": 6}}
        ],
    }
}


class TestPolymarket:
    def test_a_buy_maps_to_a_buy(self) -> None:
        row = normalize_polymarket(pm_rows([{"side": "BUY"}])).row(0, named=True)
        assert row["side"] == "buy"
        assert row["chain"] == "polymarket"
        assert row["price"] == pytest.approx(0.4)
        assert row["size_usd"] == pytest.approx(40.0)
        assert row["outcome"] == "Yes"

    def test_a_sell_maps_to_a_sell(self) -> None:
        frame = normalize_polymarket(pm_rows([{"side": "SELL"}]))
        assert frame.row(0, named=True)["side"] == "sell"

    def test_redeem_is_treated_as_an_exit(self) -> None:
        """The crux: winners close via REDEEM, not SELL.

        Without this, every winning Polymarket position stays open forever and
        the labelled set collapses to losers only.
        """
        frame = normalize_polymarket(
            pm_rows(
                [
                    {
                        "type": "REDEEM",
                        "side": None,
                        "price": None,
                        "usdcSize": 100.0,
                        "size": 100.0,
                    }
                ]
            )
        )
        row = frame.row(0, named=True)
        assert row["side"] == "sell"
        assert row["price"] == pytest.approx(1.0)
        assert row["venue"] == "polymarket-redeem"

    def test_redeem_derives_price_from_cash_when_absent(self) -> None:
        frame = normalize_polymarket(
            pm_rows([{"type": "REDEEM", "price": None, "size": 200.0, "usdcSize": 200.0}])
        )
        assert frame.row(0, named=True)["price"] == pytest.approx(1.0)

    def test_a_losing_redemption_settles_at_zero_not_one(self) -> None:
        """The label-corrupting case, and the reason `/activity` was chosen.

        Per the Data API spec, one REDEEM row is emitted per outcome and its
        ``usdcSize`` is that outcome's payout — exactly ``0`` for a loser. A
        truthiness check on the payout (`usdcSize and size`) treats 0 as absent
        and falls through to the $1 winning-share default, pricing every
        redeemed loser at a full payout.

        The damage is silent and total: a position bought at 0.40 and lost
        would book proceeds equal to its cost and label as a break-even instead
        of a -100% loss. Every win rate in the project would be inflated, and
        nothing would crash.
        """
        frame = normalize_polymarket(
            pm_rows(
                [
                    {
                        "type": "REDEEM",
                        "side": None,
                        "price": None,
                        "size": 100.0,
                        "usdcSize": 0.0,
                    }
                ]
            )
        )
        row = frame.row(0, named=True)
        assert row["side"] == "sell"
        assert row["price"] == pytest.approx(0.0)
        assert row["size_usd"] == pytest.approx(0.0)

    def test_a_partial_redemption_uses_the_real_payout(self) -> None:
        """Fractional resolutions exist — a voided market can pay 0.5/share."""
        frame = normalize_polymarket(
            pm_rows(
                [
                    {
                        "type": "REDEEM",
                        "price": None,
                        "size": 100.0,
                        "usdcSize": 50.0,
                    }
                ]
            )
        )
        assert frame.row(0, named=True)["price"] == pytest.approx(0.5)

    def test_redeem_falls_back_to_one_only_when_cash_is_truly_absent(self) -> None:
        """The $1 default is a guess, so it must be the last resort, not the first."""
        frame = normalize_polymarket(
            pm_rows(
                [{"type": "REDEEM", "price": None, "size": 100.0, "usdcSize": None}]
            )
        )
        assert frame.row(0, named=True)["price"] == pytest.approx(1.0)

    def test_merge_and_conversion_are_exits(self) -> None:
        frame = normalize_polymarket(pm_rows([{"type": "MERGE"}, {"type": "CONVERSION"}]))
        assert frame.height == 2
        assert set(frame["side"].to_list()) == {"sell"}

    def test_unrelated_activity_is_dropped(self) -> None:
        frame = normalize_polymarket(pm_rows([{"type": "DEPOSIT"}, {"type": "REWARD"}]))
        assert frame.is_empty()

    def test_size_usd_is_derived_when_missing(self) -> None:
        frame = normalize_polymarket(
            pm_rows([{"usdcSize": None, "size": 50.0, "price": 0.6}])
        )
        assert frame.row(0, named=True)["size_usd"] == pytest.approx(30.0)

    def test_rows_without_a_timestamp_are_dropped(self) -> None:
        assert normalize_polymarket(pm_rows([{"timestamp": None}])).is_empty()

    def test_trade_ids_are_deterministic(self) -> None:
        first = normalize_polymarket(pm_rows([{}])).row(0, named=True)
        second = normalize_polymarket(pm_rows([{}])).row(0, named=True)
        assert first["trade_id"] == second["trade_id"]

    def test_empty_input(self) -> None:
        assert normalize_polymarket(pl.DataFrame()).is_empty()


class TestSolana:
    def test_stable_into_token_is_a_buy(self) -> None:
        frame = normalize_solana(
            sol_row(
                {
                    "swap": {
                        "tokenInputs": [
                            {
                                "mint": USDC,
                                "rawTokenAmount": {
                                    "tokenAmount": "1000000000",
                                    "decimals": 6,
                                },
                            }
                        ],
                        "tokenOutputs": [
                            {
                                "mint": MEME,
                                "rawTokenAmount": {
                                    "tokenAmount": "5000000000",
                                    "decimals": 6,
                                },
                            }
                        ],
                    }
                }
            )
        )
        row = frame.row(0, named=True)
        assert row["side"] == "buy"
        assert row["market_id"] == MEME
        assert row["qty"] == pytest.approx(5000.0)
        # A stablecoin leg is USD directly.
        assert row["size_usd"] == pytest.approx(1000.0)
        assert row["price"] == pytest.approx(0.2)

    def test_token_into_stable_is_a_sell(self) -> None:
        frame = normalize_solana(
            sol_row(
                {
                    "swap": {
                        "tokenInputs": [
                            {
                                "mint": MEME,
                                "rawTokenAmount": {
                                    "tokenAmount": "5000000000",
                                    "decimals": 6,
                                },
                            }
                        ],
                        "tokenOutputs": [
                            {
                                "mint": USDC,
                                "rawTokenAmount": {
                                    "tokenAmount": "2000000000",
                                    "decimals": 6,
                                },
                            }
                        ],
                    }
                }
            )
        )
        row = frame.row(0, named=True)
        assert row["side"] == "sell"
        assert row["market_id"] == MEME
        assert row["size_usd"] == pytest.approx(2000.0)

    def test_sol_quoted_swap_needs_a_rate_to_be_priced(self) -> None:
        events = {
            "swap": {
                "nativeInput": {"amount": "1000000000"},  # 1 SOL
                "tokenOutputs": [
                    {
                        "mint": MEME,
                        "rawTokenAmount": {"tokenAmount": "1000000000", "decimals": 6},
                    }
                ],
            }
        }
        unpriced = normalize_solana(sol_row(events))
        assert unpriced.row(0, named=True)["size_usd"] is None

        # Timestamp 1_770_000_000 is 2026-02-02 UTC.
        priced = normalize_solana(sol_row(events), sol_usd={"2026-02-02": 200.0})
        assert priced.row(0, named=True)["size_usd"] == pytest.approx(200.0)

    def test_quote_to_quote_swaps_are_dropped(self) -> None:
        """USDC→SOL is treasury management, not a directional trade."""
        frame = normalize_solana(
            sol_row(
                {
                    "swap": {
                        "tokenInputs": [
                            {
                                "mint": USDC,
                                "rawTokenAmount": {
                                    "tokenAmount": "1000000",
                                    "decimals": 6,
                                },
                            }
                        ],
                        "tokenOutputs": [
                            {
                                "mint": WSOL,
                                "rawTokenAmount": {
                                    "tokenAmount": "1000000000",
                                    "decimals": 9,
                                },
                            }
                        ],
                    }
                }
            )
        )
        assert frame.is_empty()

    def test_transactions_without_a_swap_event_are_dropped(self) -> None:
        assert normalize_solana(sol_row({})).is_empty()
        assert normalize_solana(sol_row({"swap": {}})).is_empty()

    def test_venue_is_recorded_from_the_helius_source(self) -> None:
        frame = normalize_solana(
            sol_row(
                {
                    "swap": {
                        "tokenInputs": [
                            {
                                "mint": USDC,
                                "rawTokenAmount": {
                                    "tokenAmount": "1000000",
                                    "decimals": 6,
                                },
                            }
                        ],
                        "tokenOutputs": [
                            {
                                "mint": MEME,
                                "rawTokenAmount": {
                                    "tokenAmount": "1000000",
                                    "decimals": 6,
                                },
                            }
                        ],
                    }
                },
                source="RAYDIUM",
            )
        )
        assert frame.row(0, named=True)["venue"] == "raydium"

    def test_program_ids_override_the_helius_label(self) -> None:
        """Helius says "JUPITER" for every routed swap.

        The pool is what the KOL actually entered, and it is what decides which
        board gets reconstructed for that decision — so the program id has to
        win over the label.
        """
        from pattern_ml.venues import BY_VENUE

        frame = normalize_solana(
            sol_row(
                SWAP_USDC_INTO_MEME,
                source="JUPITER",
                instructions=[
                    {
                        "programId": BY_VENUE["jupiter-v6"].address,
                        "innerInstructions": [
                            {"programId": BY_VENUE["pump-bonding-curve"].address}
                        ],
                    }
                ],
            )
        )
        row = frame.row(0, named=True)
        assert row["venue"] == "pump-bonding-curve"
        assert row["router"] == "jupiter-v6"

    def test_malformed_instructions_fall_back_to_the_label(self) -> None:
        """A bad payload must degrade the venue, never drop the trade."""
        frame = normalize_solana(sol_row(SWAP_USDC_INTO_MEME, source="RAYDIUM"))
        frame_bad = normalize_solana(
            sol_row(SWAP_USDC_INTO_MEME, source="RAYDIUM", instructions=[])
        )
        assert frame.row(0, named=True)["venue"] == "raydium"
        assert frame_bad.row(0, named=True)["venue"] == "raydium"

    def test_empty_input(self) -> None:
        assert normalize_solana(pl.DataFrame()).is_empty()
