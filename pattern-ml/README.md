# Pattern ML

Trade-pattern discovery over KOL (Key Opinion Leader) wallet history on Solana
and Polymarket. Self-contained: it never reads or writes the main SWAT
Postgres.

## Status

| Stage | Command | State |
|---|---|---|
| Source trade history | `pattern-ml pull` | ready |
| Normalize both venues | `pattern-ml index` | ready |
| Reconstruct positions | `pattern-ml positions` | ready |
| Mine patterns | `pattern-ml mine` | **not built — approach under review** |
| Backtest with frictions | `pattern-ml validate` | ready |
| Archive a run | `pattern-ml archive` | ready |

The mining layer is deliberately absent rather than half-built. The open
question is whether the model should learn from **KOL behaviour** (a follower:
"given this trader entered, will it win?") or from **token state at the moment
a KOL buys** (a learner that can fire on a token before anyone else does).
Those need different features, different labels, and — critically — the second
needs negative sampling, which the first does not. Building one and retrofitting
the other would waste more than it saves.

Everything upstream is independent of that choice, which is why it is finished:
sourcing, normalization, position reconstruction, and the backtest harness are
shared by both designs.

## Setup

Requires Python ≥ 3.11 and a Helius API key for Solana. Polymarket's Data API
is public. Designed to run on a server — at 1–2M trades the pull is long and
rate-limited, and mining is memory-hungry.

```bash
cd pattern-ml
./scripts/setup-server.sh
```

That creates an isolated `.venv`, installs everything, seeds `.env` and
`config/kols.yaml` from the examples, and runs the tests. It pulls no data.

Then add your `HELIUS_API_KEY` to `.env` (the repo-root `../.env` is read as a
fallback, so an existing key need not be duplicated) and list the traders you
care about in `config/kols.yaml`:

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
pattern-ml pull        # network; long; resumable
pattern-ml index       # normalize raw dumps into the trade table
pattern-ml positions   # pair entries with exits, produce win/loss labels
pattern-ml validate    # backtest copying the roster, after frictions
pattern-ml stats       # what's in the warehouse
```

`pattern-ml run-all` chains every available stage.

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

**Positions.** Trades are folded into round trips using average-cost,
flat-to-flat matching: a position opens on the first buy from zero inventory
and closes when inventory returns to ~zero. This is what produces `is_win` —
a single trade has no outcome. Positions still holding inventory are labelled
null and excluded, because the bags a KOL still holds are disproportionately
losers and counting them would inflate every win rate.

**Validation.** The backtest models *you copying them*, not them trading: 150
bps slippage per leg, 30 bps fees per side, and positions held under 60 seconds
dropped as un-copyable. It also runs a random-selection null — if picking
trades at random from the same roster returns nearly the same, the edge is your
list of traders, not any pattern.

## Reading the output

Artefacts land in `artifacts/` and are overwritten each run. `pattern-ml
archive` snapshots them to `reports/<UTC-timestamp>/` with a readable
`REPORT.md`, so a past run's claims survive to be checked against what happened
next. `pattern-ml runs` lists archives.

Parquet is compressed binary — `cat` gives you nothing useful:

```python
import polars as pl
pl.read_parquet("artifacts/equity_curve.parquet")
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
│   ├── storage.py        # DuckDB warehouse + Parquet staging
│   ├── stats.py          # FDR correction, Wilson bounds, bootstrap
│   ├── prices.py         # SOL/USD daily series, cached
│   ├── report.py         # run archival + Markdown reports
│   ├── sources/          # Helius + Polymarket pullers
│   ├── index/            # normalization + position reconstruction
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

Nothing here has been executed against real data yet — syntax and imports are
verified, but first contact will surface runtime issues, most likely in the
DuckDB Arrow registration in `storage.py` and the Polymarket paging loop.

## On multiple testing

Any mining layer added here must correct for how many hypotheses it tested.
`stats.py` provides Benjamini–Hochberg FDR control and Wilson confidence
bounds for that reason. Testing thousands of candidate patterns at p < 0.05
and keeping the winners manufactures roughly 100 "significant" findings from
2,000 candidates with no real edge anywhere. A pattern is only reportable when
its whole confidence interval clears the baseline, not just its point estimate.
