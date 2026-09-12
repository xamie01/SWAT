# Pattern ML

Trade-pattern discovery over KOL (Key Opinion Leader) wallet history on Solana
and Polymarket. Self-contained: it never reads or writes the main SWAT
Postgres.

## Status

| Stage | Command | State |
|---|---|---|
| Check Bitquery schema | `pattern-ml solana-probe` | ready |
| Find unmapped venues | `pattern-ml venue-audit` | ready |
| Source trade history | `pattern-ml pull` | ready |
| Normalize both venues | `pattern-ml index` | ready |
| Reconstruct positions | `pattern-ml positions` | ready |
| Build choice sets | `pattern-ml choice-sets` | ready |
| Train the ranker | `pattern-ml rank` | ready |
| Score live candidates | `pattern-ml score` | ready |
| Backtest with frictions | `pattern-ml validate` | ready |
| Archive a run | `pattern-ml archive` | ready |

Nothing here has run against real data. Syntax and imports are verified; first
contact will surface runtime issues.

## The question this asks

Not *"was this trade good?"* — that is answerable only after the KOL has already
acted, which makes you a follower who arrives late. Instead:

> Of the assets competing for this trader's attention at time *t*, why did they
> pick **this** one?

That is a **discrete choice** problem. Each KOL buy becomes a group: the token
they chose, plus the alternatives that were on screen at the same instant. A
learning-to-rank model (LightGBM `lambdarank`) learns to put the chosen one on
top. At serve time you rank today's candidates and act on the leader — before
anyone has traded.

Labels are graded, not binary: **2** for the asset bought at *t*, **1** for one
bought within 24h (attractive, just not first), **0** for a genuine rejection.
Assets the KOL traded within ±5 minutes are dropped entirely — three buys in
ninety seconds is one decision about three assets, and scoring two as rejections
would teach the model to reject exactly what this trader likes.

### Where the negatives come from is the whole ballgame

A KOL buying one Solana token did not evaluate 100,000 alternatives. They looked
at a screen holding maybe 10–30 names. Draw negatives uniformly from all tokens
and the model learns "is this a real token with volume" — trivially true of
every KOL buy, and worth nothing. The `Screen` object *is* the modelling
assumption, and `screen_coverage` measures whether it is the right one.

**Read screen coverage before reading any NDCG number.** It reports what
fraction of real KOL buys the screen would have surfaced. Above ~0.7 the screen
describes the trader; below ~0.4 it does not, and no amount of model tuning
fixes a mis-specified choice set — that KOL is sourcing from somewhere
unobservable and should be excluded.

## Setup

Requires Python ≥ 3.11, a Helius API key (Solana sourcing) and a Bitquery OAuth
token (Solana opportunity-set reconstruction). Polymarket's Data API is public.
Designed to run on a server — at 1–2M trades the pull is long and rate-limited.

```bash
cd pattern-ml
./scripts/setup-server.sh
```

That creates an isolated `.venv`, installs everything, seeds `.env` and
`config/kols.yaml` from the examples, and runs the tests. It pulls no data.

Then add your keys to `.env` (the repo-root `../.env` is read as a fallback, so
an existing key need not be duplicated) and list the traders you care about in
`config/kols.yaml`:

```yaml
solana:
  - address: 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1
    handle: some-kol
    tags: [memecoin]

polymarket:
  - address: "0x1111111111111111111111111111111111111111"
    handle: some-predictor
```

Addresses are bare — no `solana:` / `polygon:` prefix, though a prefix pasted
from the main SWAT database is stripped rather than rejected. The Polymarket
address is the trader's proxy wallet, from `polymarket.com/profile/<address>`.

## Running it

```bash
pattern-ml solana-probe          # FIRST: check every Bitquery query is accepted
pattern-ml pull                  # network; long; resumable
pattern-ml index                 # normalize raw dumps into the trade table
pattern-ml venue-audit           # which execution venues aren't recognised yet
pattern-ml positions             # pair entries with exits, produce win/loss labels

pattern-ml choice-sets --chain polymarket --max-decisions 50   # trial run
pattern-ml choice-sets --chain solana --max-decisions 50
pattern-ml rank
pattern-ml rank --drop-kol-features
pattern-ml score --chain solana --venue pump-bonding-curve --top 10

pattern-ml validate              # backtest copying the roster, after frictions
pattern-ml stats                 # what's in the warehouse
```

Start every `choice-sets` run with `--max-decisions 50` and read the screen
coverage table before committing to a full run.

`--drop-kol-features` on `rank` excludes `prior_kol_entries` and
`seconds_since_first_kol_entry`. Those columns are strongest precisely when you
are *latest*. If the model only beats its baselines with them, it learned to
follow, not to anticipate — which is the exact failure this project exists to
avoid. Run it both ways and compare.

## What the pipeline actually does

**Sourcing.** Solana goes through Helius's Enhanced Transactions API — up to
100 pre-parsed swaps per request, roughly 100× fewer calls than the
per-signature RPC walk the main indexer uses. Polymarket uses `/activity`
rather than `/trades`, which matters: a *winning* Polymarket position usually
closes by redeeming shares at resolution, which emits no trade. Sourcing fills
alone would leave every winner permanently open and bias the labels toward
losers. (`/trades` also defaults to `takerOnly=true`, silently dropping maker
fills.)

**Normalization.** Both venues map onto one trade schema. `price` means
different things per venue — USD per token on Solana, implied probability on
Polymarket — so anything comparing them must rank-transform rather than use the
raw number. Raw API responses stay immutable in Parquet, so re-running a
normalization rule over 2M trades is free rather than another multi-hour crawl.

**Venue resolution.** Every Solana swap is resolved to the program that held the
market, from the outer and inner instructions. Helius's own `source` label is
not enough: it says "JUPITER" for every routed swap, and cannot distinguish a
Pump.fun bonding curve from PumpSwap. That distinction decides which board gets
reconstructed, so the program id wins and the aggregator is recorded separately
as `router`. `venue-audit` counts program ids in your own data that
`venues.py` does not recognise — that is how the registry gets extended, by
observation rather than guesswork.

**Positions.** Trades are folded into round trips using average-cost,
flat-to-flat matching: a position opens on the first buy from zero inventory
and closes when inventory returns to ~zero. This is what produces `is_win` —
a single trade has no outcome. Positions still holding inventory are labelled
null and excluded, because the bags a KOL still holds are disproportionately
losers and counting them would inflate every win rate.

**Choice sets.** The core stage. For each KOL buy, the provider reconstructs the
opportunity set as of that instant — never later. The two venues have opposite
cost shapes:

| | Polymarket | Solana |
|---|---|---|
| Method | enumerate a catalogue | aggregate a time window |
| Source | Gamma + CLOB + Data API | Bitquery Solana GraphQL |
| Cost | 2 requests **per candidate** per decision | 2 queries **per decision** |
| Routing | one order book | per venue: curve board vs AMM board |

On Solana the venue picks the question. A bonding-curve buy queries curves live
in the window ranked by completion; an AMM buy queries tokens by volume on that
protocol. A Jupiter route into an unrecognised pool widens to all AMMs — losing
precision beats dropping the decision.

**Validation.** The backtest models *you copying them*, not them trading: 150
bps slippage per leg, 30 bps fees per side, and positions held under 60 seconds
dropped as un-copyable. It also runs a random-selection null — if picking
trades at random from the same roster returns nearly the same, the edge is your
list of traders, not any pattern.

## Lookahead bias

The failure mode this codebase is built against. A leak does not crash anything
— it produces an excellent NDCG, a confident model, and losses in production,
with nothing upstream to indicate why. Three defences:

1. **Every query is bounded at the decision instant.** `endTs` on Polymarket
   price history, `end` on its trades, `till` on every Bitquery query. Tests
   intercept every outbound request and assert none ever asks past *t*.
2. **Returned rows are re-filtered anyway.** Never trust a boundary you did not
   enforce yourself.
3. **Unfillable fields are `None`, never zero.** A zero liquidity is a claim; a
   null is an admission. Screens reject nulls, so an unfillable field shrinks
   the opportunity set rather than poisoning it.

The subtlest case is `age_seconds` on Solana. A token that first traded before
the discovery window has a *censored* age, and clamping it to the window length
would manufacture novelty out of an old token — the most damaging error
available here, since novelty is exactly what a launchpad trader selects on. It
is recorded as null instead.

Consequently `SolanaScreen`'s age and liquidity gates, and `PolymarketScreen`'s
spread gate, all default to **off**. Gating on a field the reconstruction cannot
fill would reject every candidate; worse, gating on one that live scoring *can*
fill while historical assembly cannot would train and serve from two different
universes.

## Reading the output

Artefacts land in `artifacts/` and are overwritten each run. `pattern-ml
archive` snapshots them to `reports/<UTC-timestamp>/` with a readable
`REPORT.md`, so a past run's claims survive to be checked against what happened
next. `pattern-ml runs` lists archives.

`rank` prints per-fold NDCG@5 and hit@1 against two mandatory baselines: random
ordering and rank-by-volume. Absolute NDCG is unreadable in isolation — with 8
candidates per group, random ordering already scores ~0.6. Only the margin
matters, and the verdict requires clearing **both** baselines on **every** fold.
A model that cannot beat "pick the highest-volume candidate" has learned an
expensive sort.

Parquet is compressed binary — `cat` gives you nothing useful:

```python
import polars as pl
pl.read_parquet("artifacts/choice_candidates.parquet")
```

```bash
duckdb data/warehouse.duckdb "SELECT * FROM positions WHERE is_win LIMIT 10"
```

## Layout

```
pattern-ml/
├── src/pattern_ml/
│   ├── cli.py            # every pipeline stage
│   ├── config.py         # settings + KOL roster loader
│   ├── schema.py         # canonical trade + position schemas
│   ├── venues.py         # Solana program-id registry, venue resolution
│   ├── storage.py        # DuckDB warehouse + Parquet staging
│   ├── stats.py          # FDR correction, Wilson bounds, bootstrap
│   ├── prices.py         # SOL/USD daily series, cached
│   ├── report.py         # run archival + Markdown reports
│   ├── sources/          # Helius + Polymarket pullers, Bitquery client
│   ├── index/            # normalization + position reconstruction
│   ├── choice/           # the model
│   │   ├── schema.py     # choice-set tables, relevance grades, screens
│   │   ├── assemble.py   # KOL buys + snapshots → training groups
│   │   ├── snapshot.py   # provider protocol, minute cache, forward collector
│   │   ├── rank.py       # lambdarank + group-aware temporal validation
│   │   └── providers/    # polymarket.py, solana.py
│   └── validate/         # follower backtest + random-pick null
├── tests/
├── scripts/setup-server.sh
├── data/                 # raw Parquet + warehouse.duckdb (gitignored)
├── artifacts/            # latest run output (gitignored)
└── config/kols.yaml      # your roster (gitignored)
```

## Testing

```bash
source .venv/bin/activate
pytest
```

Nothing here has been executed against real data yet. The likeliest first
failures:

- **Bitquery query shape.** The GraphQL field names in `sources/bitquery.py`
  were written without network access and Bitquery's Solana schema has moved
  between versions. A renamed field returns an *empty result*, not an error —
  which at scale reads as "these KOLs had no alternatives". `solana-probe`
  exists to catch exactly this; run it first.
- DuckDB Arrow registration in `storage.py`.
- The Polymarket window-advance loop.
- Gamma's `clobTokenIds` shape (both string and list are handled).

## On multiple testing

Any pattern claim must correct for how many hypotheses it tested. `stats.py`
provides Benjamini–Hochberg FDR control and Wilson confidence bounds for that
reason. Testing thousands of candidate patterns at p < 0.05 and keeping the
winners manufactures roughly 100 "significant" findings from 2,000 candidates
with no real edge anywhere. A pattern is only reportable when its whole
confidence interval clears the baseline, not just its point estimate.
