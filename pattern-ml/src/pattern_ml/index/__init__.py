"""Indexing: raw source rows in, canonical trades and positions out.

Split from sourcing on purpose. Sourcing is expensive and rate-limited;
indexing is cheap and pure. Keeping them apart means a change to a
normalization or position-matching rule costs a local re-run, not another
1-2M-row pull.
"""

from . import normalize, positions

__all__ = ["normalize", "positions"]
