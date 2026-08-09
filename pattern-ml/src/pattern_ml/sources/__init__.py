"""Trade sourcing. Each module owns one venue's API and returns raw rows.

Normalization deliberately lives elsewhere (``pattern_ml.index.normalize``) so
the files on disk stay a faithful record of what each API actually said — if a
normalization rule turns out to be wrong, it can be re-run without re-pulling
1-2M trades.
"""

from . import polymarket, solana
from .base import HttpSource, PullStats, RateLimiter, SourceError

__all__ = [
    "HttpSource",
    "PullStats",
    "RateLimiter",
    "SourceError",
    "polymarket",
    "solana",
]
