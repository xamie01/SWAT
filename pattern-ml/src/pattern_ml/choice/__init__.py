"""Discrete-choice modelling of KOL entries.

The question this package asks
-----------------------------
Not *"was this trade good?"* — that is a follower's question, answerable only
after the KOL has already acted. Instead:

    Of the assets competing for this trader's attention at time t,
    why did they pick THIS one?

Framing it as a choice among simultaneously-available alternatives is what
makes the model usable *before* anyone trades: score today's candidates, act on
the top of the ranking.

Why the opportunity set matters more than the model
---------------------------------------------------
A KOL buying one Solana token did not evaluate 100,000 alternatives. They
looked at a screen — DexScreener trending, a Pump.fun bonding-curve board, a
Telegram feed — holding maybe 10-30 names. The negatives must come from *that*
set. Draw them uniformly from all tokens and the model learns "is this a real
token with volume", which is trivially true of every KOL buy and worth nothing.
Hard negatives from the same screen force it to learn the actual differential.

This makes ``Screen`` the highest-leverage object here: it *is* the modelling
assumption. ``screen_coverage`` measures whether it is the right one, by
checking what fraction of real KOL buys the screen would even have surfaced. A
trader whose buys mostly fail the screen is sourcing elsewhere, and no amount
of model tuning fixes a mis-specified choice set.

Modules
-------
``schema``    choice-set tables, graded relevance levels, the ``Screen`` contract
``assemble``  turn KOL buys + market snapshots into training groups
``snapshot``  the provider protocol, and a forward collector for clean ground truth
``rank``      LightGBM ``lambdarank`` with group-aware temporal validation
"""

from .schema import (
    CANDIDATE_SCHEMA,
    CHOICE_SET_SCHEMA,
    REL_CHOSEN,
    REL_IGNORED,
    REL_LATER,
    PolymarketScreen,
    PumpFunScreen,
    Screen,
    SolanaScreen,
    screen_coverage,
)

__all__ = [
    "CANDIDATE_SCHEMA",
    "CHOICE_SET_SCHEMA",
    "REL_CHOSEN",
    "REL_IGNORED",
    "REL_LATER",
    "PolymarketScreen",
    "PumpFunScreen",
    "Screen",
    "SolanaScreen",
    "screen_coverage",
]
