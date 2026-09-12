"""Snapshot providers, one per venue.

Each implements ``choice.snapshot.MarketSnapshotProvider``: given an instant,
return the assets that were plausibly on screen, with every feature computed
strictly as-of that instant.

The two differ in shape, not just in vendor:

* **Polymarket** enumerates. The live universe is hundreds of markets, so the
  provider walks a catalogue and prices each candidate individually — two
  requests per candidate per decision.
* **Solana** aggregates. There is no enumerable universe, so the provider asks
  Bitquery a question about a time window and gets back both the candidate set
  and its features — two queries per *decision*, whatever the candidate count.

The Solana path is venue-routed: a Pump.fun bonding-curve buy and a Raydium buy
at the same instant were made in front of different boards, so
``candidates_at`` takes the venue resolved from the trade's program ids.
"""

from .polymarket import PolymarketMarket, PolymarketSnapshotProvider
from .solana import SolanaSnapshotProvider, curve_completion

__all__ = [
    "PolymarketMarket",
    "PolymarketSnapshotProvider",
    "SolanaSnapshotProvider",
    "curve_completion",
]
