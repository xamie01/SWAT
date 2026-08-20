"""Tests for the KOL roster loader.

The roster is the one file a user hand-edits, so its failure modes should be
loud and specific rather than a downstream crash three stages later.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from pattern_ml.config import KolRosterError, load_kols

SOL_ADDR = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
EVM_ADDR = "0x1111111111111111111111111111111111111111"


def write(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "kols.yaml"
    path.write_text(body)
    return path


class TestLoading:
    def test_loads_both_chains(self, roster_file: Path) -> None:
        kols = load_kols(roster_file)
        assert len(kols) == 2
        assert {k.chain for k in kols} == {"solana", "polymarket"}

    def test_key_is_chain_qualified(self, roster_file: Path) -> None:
        assert f"solana:{SOL_ADDR}" in {k.key for k in load_kols(roster_file)}

    def test_label_prefers_handle(self, roster_file: Path) -> None:
        kol = next(k for k in load_kols(roster_file) if k.chain == "solana")
        assert kol.label == "sol-kol"

    def test_label_falls_back_to_a_truncated_address(self, tmp_path: Path) -> None:
        path = write(tmp_path, f"solana:\n  - address: {SOL_ADDR}\n")
        assert "…" in load_kols(path)[0].label

    def test_tags_and_notes_are_preserved(self, tmp_path: Path) -> None:
        path = write(
            tmp_path,
            f"solana:\n"
            f"  - address: {SOL_ADDR}\n"
            f"    tags: [memecoin, fast]\n"
            f'    note: "watch this one"\n',
        )
        kol = load_kols(path)[0]
        assert kol.tags == ("memecoin", "fast")
        assert kol.note == "watch this one"


class TestAddressHandling:
    def test_evm_addresses_are_lowercased(self, tmp_path: Path) -> None:
        path = write(tmp_path, f'polymarket:\n  - address: "{EVM_ADDR.upper()}"\n')
        assert load_kols(path)[0].address == EVM_ADDR.lower()

    def test_solana_addresses_keep_their_case(self, tmp_path: Path) -> None:
        """Base58 is case-sensitive; folding it produces a different wallet."""
        path = write(tmp_path, f"solana:\n  - address: {SOL_ADDR}\n")
        assert load_kols(path)[0].address == SOL_ADDR

    def test_chain_prefixes_pasted_from_the_main_db_are_stripped(
        self, tmp_path: Path
    ) -> None:
        path = write(tmp_path, f"solana:\n  - address: solana:{SOL_ADDR}\n")
        assert load_kols(path)[0].address == SOL_ADDR

    def test_evm_address_under_solana_is_rejected(self, tmp_path: Path) -> None:
        path = write(tmp_path, f'solana:\n  - address: "{EVM_ADDR}"\n')
        with pytest.raises(KolRosterError, match="EVM"):
            load_kols(path)

    def test_malformed_evm_address_is_rejected(self, tmp_path: Path) -> None:
        path = write(tmp_path, 'polymarket:\n  - address: "0xtooshort"\n')
        with pytest.raises(KolRosterError, match="42-char"):
            load_kols(path)


class TestErrors:
    def test_missing_file_explains_how_to_create_one(self, tmp_path: Path) -> None:
        with pytest.raises(KolRosterError, match="cp "):
            load_kols(tmp_path / "nope.yaml")

    def test_empty_roster_is_rejected(self, tmp_path: Path) -> None:
        path = write(tmp_path, "solana:\npolymarket:\n")
        with pytest.raises(KolRosterError, match="no KOLs"):
            load_kols(path)

    def test_duplicate_addresses_are_rejected(self, tmp_path: Path) -> None:
        path = write(
            tmp_path, f"solana:\n  - address: {SOL_ADDR}\n  - address: {SOL_ADDR}\n"
        )
        with pytest.raises(KolRosterError, match="Duplicate"):
            load_kols(path)

    def test_entry_without_an_address_is_rejected(self, tmp_path: Path) -> None:
        path = write(tmp_path, "solana:\n  - handle: no-address\n")
        with pytest.raises(KolRosterError, match="address"):
            load_kols(path)

    def test_same_address_on_two_chains_is_allowed(self, tmp_path: Path) -> None:
        """A trader can legitimately run the same EVM address on both."""
        path = write(
            tmp_path,
            f'polymarket:\n  - address: "{EVM_ADDR}"\nsolana:\n  - address: {SOL_ADDR}\n',
        )
        assert len(load_kols(path)) == 2
