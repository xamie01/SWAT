"""Pattern-ML command line.

    pull → index → positions → choice-sets → rank → score

Each stage persists its output, so stages can be re-run independently. Only
``pull``, ``choice-sets``, ``score`` and the probes touch the network.

The modelling question is a *discrete choice*: of the assets competing for a
trader's attention at time t, why this one? That framing is what makes the
output usable before anyone trades — score today's candidates and act on the
top of the ranking, rather than waiting to copy a fill you will always be late
to.

Two diagnostics run before the pipeline rather than inside it:
``solana-probe`` checks the Bitquery queries against the live schema, and
``venue-audit`` reports execution venues the program registry cannot name. Both
fail loudly for problems that would otherwise show up as an empty result.

``validate`` is separate and answers a different question: what would copying
the whole roster have returned, after slippage and fees. It needs no model and
is the baseline any ranking must beat to be worth having.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import polars as pl
import typer
from rich.console import Console
from rich.table import Table

from .config import KolRosterError, get_settings, load_kols
from .storage import get_storage

app = typer.Typer(
    name="pattern-ml",
    help="Find and test trading patterns in KOL trade history.",
    no_args_is_help=True,
    add_completion=False,
)
console = Console()


def _fail(message: str) -> None:
    console.print(f"[bold red]✗[/bold red] {message}")
    raise typer.Exit(1)


def _roster(path: Path | None):
    try:
        return load_kols(path)
    except KolRosterError as exc:
        _fail(str(exc))
        raise  # unreachable; keeps type checkers happy


# ---------------------------------------------------------------------------
# Stage 0 — diagnostics
# ---------------------------------------------------------------------------


@app.command("solana-probe")
def solana_probe() -> None:
    """Check every Bitquery query against the live schema. Run this first.

    The GraphQL field names in `sources/bitquery.py` were written without
    network access and Bitquery's Solana schema has moved between versions. A
    renamed field returns an empty result rather than an error, which at scale
    looks like "these KOLs had no alternatives" rather than "the query is
    wrong". This surfaces the difference in one command.
    """
    from .sources.bitquery import BitqueryClient, BitqueryError

    settings = get_settings()
    if not settings.bitquery_token:
        _fail(
            "BITQUERY_TOKEN is not set. Add it to pattern-ml/.env.\n"
            "It must be an OAuth access token, not the legacy X-API-KEY."
        )

    console.print("[bold]Probing Bitquery Solana schema[/bold]")
    console.print("[dim]Each query runs once with a one-row limit.[/dim]\n")

    try:
        with BitqueryClient(max_rps=settings.bitquery_max_rps) as client:
            results = client.probe()
    except BitqueryError as exc:
        _fail(str(exc))
        return

    table = Table("Query", "Status", "Rows", "Detail")
    for result in results:
        status = "[green]ok[/green]" if result["ok"] else "[red]failed[/red]"
        table.add_row(
            result["query"], status, str(result["rows"]), result["detail"][:80]
        )
    console.print(table)

    failed = [r["query"] for r in results if not r["ok"]]
    if failed:
        console.print(
            f"\n[bold red]✗[/bold red] {len(failed)} quer(y/ies) rejected: "
            f"{', '.join(failed)}.\n"
            "Fix the query constants in `sources/bitquery.py` before running "
            "`choice-sets --chain solana` — a rejected query produces empty "
            "choice sets, not an error."
        )
        raise typer.Exit(1)

    empty = [r["query"] for r in results if r["ok"] and r["rows"] == 0]
    if empty:
        console.print(
            f"\n[yellow]![/yellow] Accepted but empty: {', '.join(empty)}. "
            "The schema is right; the window may just have been quiet. Re-run, "
            "and if it stays empty for long-past windows only, add "
            "`(dataset: archive)` to the queries."
        )
    console.print("\n[bold green]✓[/bold green] Schema accepted.")


@app.command("venue-audit")
def venue_audit(
    top: int = typer.Option(25, "--top", help="How many unmapped programs to show"),
) -> None:
    """Find execution venues the program registry does not recognise.

    Counts program ids appearing in the KOLs' own pulled transactions that
    `venues.py` has no entry for. A program near the top of this list is a board
    the choice-set builder is currently blind to — those decisions fall back to
    the broad AMM universe, which is a weaker approximation of what the trader
    was looking at.
    """
    from .venues import unmapped_programs

    settings = get_settings()
    raw_files = sorted((settings.raw_dir / "solana").glob("*.parquet"))
    if not raw_files:
        _fail("No raw Solana data. Run `pattern-ml pull --chains solana` first.")

    frames = []
    for path in raw_files:
        frame = pl.read_parquet(path)
        if "instructions_json" in frame.columns:
            frames.append(frame.select("instructions_json"))
    if not frames:
        _fail(
            "No `instructions_json` column in the raw files — they predate venue "
            "resolution. Re-run `pattern-ml pull --chains solana` to capture it."
        )

    unmapped = unmapped_programs(pl.concat(frames), top=top)
    if unmapped.is_empty():
        console.print(
            "[bold green]✓[/bold green] Every program in the pulled data is "
            "recognised."
        )
        return

    console.print("[bold]Unmapped programs[/bold]")
    console.print(
        "[dim]Present in KOL transactions, absent from the registry. Look each "
        "up on Solscan and add it to `venues.py` if it is a DEX.[/dim]"
    )
    table = Table("Program ID", "Transactions")
    for row in unmapped.iter_rows(named=True):
        table.add_row(row["program_id"], f"{row['transactions']:,}")
    console.print(table)


# ---------------------------------------------------------------------------
# Stage 1 — pull
# ---------------------------------------------------------------------------


@app.command()
def pull(
    kols: Path = typer.Option(
        None, "--kols", help="Roster YAML (default config/kols.yaml)"
    ),
    chains: str = typer.Option("solana,polymarket", "--chains", help="Comma-separated"),
) -> None:
    """Fetch raw trade history for every KOL into data/raw/."""
    from .sources import polymarket, solana

    settings = get_settings()
    storage = get_storage()
    wanted = {c.strip() for c in chains.split(",") if c.strip()}
    roster = [k for k in _roster(kols) if k.chain in wanted]
    if not roster:
        _fail(f"No KOLs in the roster match chains: {sorted(wanted)}")

    if any(k.chain == "solana" for k in roster) and not settings.helius_api_key:
        _fail("HELIUS_API_KEY is not set — required for Solana. See .env.example.")

    console.print(f"[bold]Pulling {len(roster)} KOL(s)[/bold]")

    async def run() -> dict:
        results: dict = {}
        results.update(await polymarket.pull_all(roster))
        results.update(await solana.pull_all(roster))
        return results

    results = asyncio.run(run())

    table = Table("KOL", "Chain", "Rows", "Requests", "File")
    total = 0
    problems: list[str] = []
    for kol in roster:
        frame, stats = results.get(kol.key, (None, None))
        if frame is None or frame.is_empty():
            table.add_row(
                kol.label, kol.chain, "0", str(stats.requests if stats else 0), "—"
            )
            if stats:
                problems.extend(stats.errors)
            continue
        path = storage.write_raw_parquet(kol.chain, kol.address, frame)
        total += frame.height
        table.add_row(
            kol.label, kol.chain, f"{frame.height:,}", f"{stats.requests:,}", path.name
        )
        problems.extend(stats.errors)

    console.print(table)
    for problem in problems:
        console.print(f"[yellow]![/yellow] {problem}")
    console.print(f"[bold green]✓[/bold green] Pulled {total:,} raw rows")


# ---------------------------------------------------------------------------
# Stage 2 — index
# ---------------------------------------------------------------------------


@app.command()
def index() -> None:
    """Normalize raw dumps into the canonical trade table."""
    from .index.normalize import normalize_file
    from .prices import coverage, load_sol_usd

    storage = get_storage()
    files = storage.list_raw_parquet()
    if not files:
        _fail("No raw files. Run `pattern-ml pull` first.")

    console.print(f"[bold]Indexing {len(files)} raw file(s)[/bold]")

    # Without SOL/USD, every SOL-quoted swap gets a null size_usd, which nulls
    # most sizing signal on the Solana half.
    sol_usd = load_sol_usd()
    if sol_usd:
        console.print(f"[dim]Loaded {len(sol_usd)} days of SOL/USD rates[/dim]")
    else:
        console.print(
            "[yellow]![/yellow] Could not fetch SOL/USD rates. "
            "Solana trades quoted in SOL will have a null size_usd."
        )

    settings = get_settings()
    inserted = 0
    for path in files:
        try:
            chain = path.relative_to(settings.raw_dir).parts[0]
        except (ValueError, IndexError):
            console.print(f"[yellow]![/yellow] Skipping unrecognised path {path}")
            continue
        frame = normalize_file(path, chain, sol_usd=sol_usd)
        if frame.is_empty():
            continue
        inserted += storage.insert_trades(frame)

    console.print(
        f"[bold green]✓[/bold green] {inserted:,} new trades "
        f"({storage.count_trades():,} total)"
    )

    if sol_usd:
        sol_trades = storage.get_trades(chain="solana")
        if not sol_trades.is_empty():
            first = sol_trades.select(pl.col("ts").min()).item()
            last = sol_trades.select(pl.col("ts").max()).item()
            if first and last:
                console.print(
                    f"[dim]SOL/USD coverage: {coverage(sol_usd, first, last):.1%} "
                    "of Solana trade days[/dim]"
                )


# ---------------------------------------------------------------------------
# Stage 3 — positions
# ---------------------------------------------------------------------------


@app.command()
def positions() -> None:
    """Reconstruct round-trip positions from the trade table."""
    from .index.positions import label_coverage

    storage = get_storage()
    if storage.count_trades() == 0:
        _fail("No trades. Run `pattern-ml index` first.")

    count = storage.rebuild_positions()
    stats = label_coverage(storage.get_positions())

    table = Table("Metric", "Value")
    table.add_row("Positions", f"{stats['positions']:,}")
    table.add_row("Closed", f"{stats['closed']:,}")
    table.add_row("Labelled (win/loss)", f"{stats['labelled']:,}")
    table.add_row("Closed rate", f"{stats['closed_rate']:.1%}")
    console.print(table)

    if stats["closed_rate"] < 0.3:
        console.print(
            "[yellow]![/yellow] Under 30% of positions are closed. The labelled "
            "set skews toward trades the KOLs chose to exit, so treat win rates "
            "as optimistic."
        )
    console.print(f"[bold green]✓[/bold green] Built {count:,} positions")


# ---------------------------------------------------------------------------
# Stage 4 — discrete choice: what would this KOL have bought?
# ---------------------------------------------------------------------------


@app.command("choice-sets")
def choice_sets(
    chain: str = typer.Option("polymarket", "--chain", help="polymarket | solana"),
    min_volume: float = typer.Option(
        50_000.0,
        "--min-volume",
        help="Screen floor: 24h volume (polymarket) or 5m volume (solana)",
    ),
    min_completion: float = typer.Option(
        0.70,
        "--min-curve-completion",
        help="Solana launchpads: minimum bonding-curve progress, 0-1",
    ),
    max_candidates: int = typer.Option(20, "--max-candidates"),
    max_decisions: int = typer.Option(
        None, "--max-decisions", help="Cap decisions processed (useful for a trial run)"
    ),
    same_category: bool = typer.Option(
        True, "--same-category/--any-category",
        help="Polymarket: only markets in the chosen market's category compete",
    ),
    fetch_liquidity: bool = typer.Option(
        False,
        "--fetch-liquidity",
        help="Solana: extra query per program per decision to fill liquidity_usd",
    ),
) -> None:
    """Assemble ranked choice sets: each KOL entry against its alternatives.

    Every candidate's features are computed strictly as-of the decision instant.
    Start with `--max-decisions 50` to sanity-check the screen before committing
    to a full run — and on Solana, run `pattern-ml solana-probe` first.
    """
    from .choice.assemble import build_choice_sets
    from .choice.schema import screen_coverage
    from .choice.snapshot import CachingProvider

    if chain not in ("polymarket", "solana"):
        _fail(f"No snapshot provider for {chain!r}.")

    settings = get_settings()
    storage = get_storage()
    trades = storage.get_trades(chain=chain)
    if trades.is_empty():
        _fail(f"No {chain} trades. Run `pattern-ml pull` and `index` first.")

    console.print(f"[bold]Assembling choice sets for {chain}[/bold]")

    if chain == "polymarket":
        from .choice.providers.polymarket import PolymarketSnapshotProvider
        from .choice.schema import PolymarketScreen

        screen = PolymarketScreen(
            min_volume_24h_usd=min_volume,
            max_candidates=max_candidates,
            same_category_only=same_category,
        )
        console.print(
            f"[dim]Screen: {screen.name} · 24h volume ≥ ${min_volume:,.0f} · "
            f"top {max_candidates}[/dim]"
        )
        provider_ctx = PolymarketSnapshotProvider()
    else:
        from .choice.providers.solana import SolanaSnapshotProvider
        from .choice.schema import PumpFunScreen, SolanaScreen
        from .venues import KIND_AMM, KIND_BONDING_CURVE, KIND_CLMM

        if not settings.bitquery_token:
            _fail(
                "BITQUERY_TOKEN is not set — Solana reconstruction cannot run.\n"
                "Add it to pattern-ml/.env, then verify the schema with "
                "`pattern-ml solana-probe`."
            )

        # One screen per kind of board. A launchpad watcher ranks by how close a
        # curve is to migrating; an AMM watcher ranks by volume. Forcing one
        # screen across both would describe neither.
        amm_screen = SolanaScreen(
            min_volume_5m_usd=min_volume, max_candidates=max_candidates
        )
        curve_screen = PumpFunScreen(
            min_completion=min_completion, max_candidates=max_candidates
        )
        screen = {
            KIND_BONDING_CURVE: curve_screen,
            KIND_AMM: amm_screen,
            KIND_CLMM: amm_screen,
            "*": amm_screen,  # unresolved venue: widen rather than drop
        }
        console.print(
            f"[dim]Screens: {curve_screen.name} (completion ≥ "
            f"{min_completion:.0%}) · {amm_screen.name} (5m volume ≥ "
            f"${min_volume:,.0f}) · top {max_candidates}[/dim]"
        )
        provider_ctx = SolanaSnapshotProvider(
            min_curve_completion=min_completion,
            fetch_liquidity=fetch_liquidity,
            candidate_limit=max(max_candidates * 3, 50),
        )

    with provider_ctx as raw_provider:
        provider = CachingProvider(raw_provider)
        candidates, groups = build_choice_sets(
            trades,
            provider,
            screen,
            chain=chain,
            max_decisions=max_decisions,
        )

    if groups.is_empty():
        _fail(
            "No choice sets could be built. Either no KOL entries fell inside "
            "the snapshot coverage, or every group had too few candidates."
            + (
                "\n\nOn Solana the usual cause is a schema mismatch — run "
                "`pattern-ml solana-probe` to check every query is accepted."
                if chain == "solana"
                else ""
            )
        )

    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)
    candidates.write_parquet(settings.artifacts_dir / "choice_candidates.parquet")
    groups.write_parquet(settings.artifacts_dir / "choice_sets.parquet")

    table = Table("Metric", "Value")
    table.add_row("Decisions", f"{groups.height:,}")
    table.add_row("Candidate rows", f"{candidates.height:,}")
    table.add_row(
        "Median candidates/decision",
        f"{groups['n_candidates'].median():.0f}",
    )
    console.print(table)

    # Which boards the decisions came from — a run that is 95% one venue is a
    # single-venue model wearing a multi-venue label.
    if "venue" in groups.columns and groups["venue"].null_count() < groups.height:
        venues = (
            groups.group_by("venue")
            .agg(decisions=pl.len())
            .sort("decisions", descending=True)
        )
        venue_table = Table("Venue", "Decisions")
        for row in venues.iter_rows(named=True):
            venue_table.add_row(str(row["venue"] or "—"), f"{row['decisions']:,}")
        console.print(venue_table)

    # The diagnostic that decides whether any of this is valid.
    coverage = screen_coverage(groups)
    console.print("\n[bold]Screen coverage[/bold]")
    console.print(
        "[dim]What fraction of real KOL buys the screen would have surfaced. "
        "Low coverage means the negatives come from a universe the trader "
        "never looked at.[/dim]"
    )
    cov_table = Table("KOL", "Decisions", "Passed", "Coverage")
    for row in coverage.iter_rows(named=True):
        value = row["coverage"]
        colour = "green" if value >= 0.7 else "yellow" if value >= 0.4 else "red"
        cov_table.add_row(
            row["kol_address"][:16],
            f"{row['decisions']:,}",
            f"{row['passed']:,}",
            f"[{colour}]{value:.1%}[/{colour}]",
        )
    console.print(cov_table)

    worst = coverage.head(1)
    if not worst.is_empty() and worst.row(0, named=True)["coverage"] < 0.4:
        console.print(
            "[yellow]![/yellow] At least one KOL is under 40% coverage — they "
            "are sourcing trades the screen cannot see (a private group, a "
            "direct tip). Loosen the screen or exclude them; no amount of model "
            "tuning fixes a mis-specified choice set."
        )

    console.print(f"\n[bold green]✓[/bold green] Wrote {settings.artifacts_dir}")


@app.command()
def rank(
    n_splits: int = typer.Option(4, "--splits"),
    drop_kol_features: bool = typer.Option(
        False,
        "--drop-kol-features",
        help="Exclude prior-KOL-entry columns to measure true early-entry skill",
    ),
) -> None:
    """Train the candidate ranker and check it against the naive baselines."""
    import pickle

    from .choice.rank import train_ranker

    settings = get_settings()
    path = settings.artifacts_dir / "choice_candidates.parquet"
    if not path.exists():
        _fail("No choice sets. Run `pattern-ml choice-sets` first.")

    candidates = pl.read_parquet(path)
    if drop_kol_features:
        # These are strongest precisely when you are latest. Dropping them
        # measures whether the model can find candidates on market state alone.
        candidates = candidates.drop(
            [c for c in ("prior_kol_entries", "seconds_since_first_kol_entry")
             if c in candidates.columns]
        )
        console.print("[dim]Roster-presence features excluded[/dim]")

    try:
        result = train_ranker(candidates, n_splits=n_splits)
    except (ValueError, ImportError) as exc:
        _fail(str(exc))
        return

    for note in result.notes:
        console.print(f"[yellow]![/yellow] {note}")

    console.print(
        f"\n[bold]{result.n_groups:,} choice sets[/bold] · "
        f"{result.mean_candidates:.1f} candidates each"
    )

    table = Table("Fold", "Test groups", "NDCG@5", "Hit@1", "vs random", "vs volume")
    for fold in result.folds:
        table.add_row(
            str(fold.fold),
            f"{fold.test_groups:,}",
            f"{fold.ndcg_at_5:.3f}",
            f"{fold.hit_at_1:.1%}",
            f"{fold.lift_over_random:+.1%}",
            f"{fold.lift_over_volume:+.1%}",
        )
    console.print(table)

    if result.beats_baselines:
        console.print(
            f"[bold green]✓[/bold green] Beats both baselines on every fold "
            f"(mean hit@1 {result.mean_hit_at_1:.1%}, "
            f"{result.mean_lift_over_volume:+.1%} over rank-by-volume)."
        )
    else:
        console.print(
            "[bold red]✗[/bold red] Does not beat both naive baselines on every "
            "fold. Absolute NDCG is not evidence — random ordering already "
            "scores highly with few candidates. This model has learned nothing "
            "beyond an expensive sort."
        )

    if not result.importance.is_empty():
        imp = Table("Feature", "Gain")
        for row in result.importance.head(10).iter_rows(named=True):
            imp.add_row(row["feature"], f"{row['gain']:,.0f}")
        console.print(imp)
        result.importance.write_parquet(
            settings.artifacts_dir / "rank_importance.parquet"
        )

    with (settings.artifacts_dir / "ranker.pkl").open("wb") as handle:
        pickle.dump(
            {"model": result.model, "features": result.features_used},
            handle,
            protocol=pickle.HIGHEST_PROTOCOL,
        )
    console.print(f"[dim]Model → {settings.artifacts_dir / 'ranker.pkl'}[/dim]")


@app.command()
def score(
    chain: str = typer.Option("polymarket", "--chain"),
    venue: str = typer.Option(
        None, "--venue",
        help="Solana: which board to score (e.g. pump-bonding-curve, raydium-amm-v4)",
    ),
    top: int = typer.Option(10, "--top", help="How many to show"),
) -> None:
    """Rank today's candidates by how KOL-like they look.

    Scores are ordinal within one snapshot — only their order is meaningful,
    and comparing across snapshots is not valid.
    """
    import pickle
    from datetime import datetime, timezone

    from .choice.rank import RankerResult, score_candidates

    settings = get_settings()
    model_path = settings.artifacts_dir / "ranker.pkl"
    if not model_path.exists():
        _fail("No trained ranker. Run `pattern-ml rank` first.")

    if chain not in ("polymarket", "solana"):
        _fail(f"No snapshot provider for {chain!r}.")

    with model_path.open("rb") as handle:
        bundle = pickle.load(handle)

    now = datetime.now(timezone.utc)

    if chain == "polymarket":
        from .choice.providers.polymarket import PolymarketSnapshotProvider
        from .choice.schema import PolymarketScreen

        screen = PolymarketScreen()
        with PolymarketSnapshotProvider() as provider:
            universe = provider.candidates_at(now, limit=100)
    else:
        from .choice.providers.solana import SolanaSnapshotProvider
        from .choice.schema import PumpFunScreen, SolanaScreen
        from .venues import KIND_BONDING_CURVE, venue_kind

        if not settings.bitquery_token:
            _fail("BITQUERY_TOKEN is not set.")
        # The screen must match the board being scored, exactly as in training:
        # scoring a launchpad universe through the AMM screen would filter on a
        # field the curve query never fills.
        screen = (
            PumpFunScreen()
            if venue_kind(venue or "") == KIND_BONDING_CURVE
            else SolanaScreen()
        )
        with SolanaSnapshotProvider() as provider:
            universe = provider.candidates_at(now, limit=100, venue=venue)

    passing = [c for c in universe if screen.passes(c)]
    if not passing:
        _fail(
            "No candidates passed the screen right now."
            + (
                f" (venue={venue or 'all AMMs'})"
                if chain == "solana"
                else ""
            )
        )

    frame = pl.DataFrame(passing, infer_schema_length=None, strict=False)
    for column in bundle["features"]:
        if column not in frame.columns:
            frame = frame.with_columns(pl.lit(None, dtype=pl.Float64).alias(column))

    result = RankerResult(
        model=bundle["model"],
        features_used=bundle["features"],
        folds=[],
        importance=pl.DataFrame(),
        n_groups=0,
        mean_candidates=0.0,
    )
    ranked = score_candidates(result, frame)

    console.print(f"[bold]Top {top} candidates — {now:%Y-%m-%d %H:%M UTC}[/bold]")
    table = Table("Rank", "Market", "Price", "24h vol", "Score")
    for i, row in enumerate(ranked.head(top).iter_rows(named=True), start=1):
        label = (row.get("market_label") or row["market_id"])[:52]
        price = row.get("price")
        volume = row.get("volume_24h_usd")
        table.add_row(
            str(i),
            label,
            f"{price:.3f}" if price is not None else "—",
            f"${volume:,.0f}" if volume is not None else "—",
            f"{row['score']:.3f}",
        )
    console.print(table)
    console.print(
        "\n[dim]A ranking, not a recommendation. Nothing here has been tested "
        "forward on decisions that had not yet happened.[/dim]"
    )


# ---------------------------------------------------------------------------
# Stage 5 — validate
# ---------------------------------------------------------------------------


@app.command()
def validate(
    entry_slippage: float = typer.Option(150.0, "--entry-slippage-bps"),
    exit_slippage: float = typer.Option(150.0, "--exit-slippage-bps"),
    fee: float = typer.Option(30.0, "--fee-bps"),
    kol: str = typer.Option(None, "--kol", help="Restrict to one KOL address"),
) -> None:
    """Backtest as a follower, with frictions, against a random-pick null.

    Runs directly against the position table, so it works without a model: this
    measures what copying the roster itself would have returned.
    """
    from .validate import backtest as bt

    settings = get_settings()
    storage = get_storage()

    everything = storage.get_positions(labelled_only=True)
    if everything.is_empty():
        _fail("No labelled positions. Run `pattern-ml positions` first.")

    selection = everything
    if kol:
        selection = everything.filter(pl.col("kol_address") == kol)
        if selection.is_empty():
            _fail(f"No labelled positions for {kol}.")
        console.print(f"[bold]Backtesting {kol}[/bold]")
    else:
        console.print("[bold]Backtesting every labelled position[/bold]")

    frictions = bt.Frictions(
        entry_slippage_bps=entry_slippage,
        exit_slippage_bps=exit_slippage,
        fee_bps_per_side=fee,
    )
    console.print(
        f"[dim]Frictions: {entry_slippage:.0f}/{exit_slippage:.0f} bps slippage, "
        f"{fee:.0f} bps fee per side "
        f"({frictions.round_trip_cost:.2%} round trip)[/dim]"
    )

    result = bt.backtest(selection, frictions=frictions)
    for note in result.notes:
        console.print(f"[yellow]![/yellow] {note}")

    if result.n_positions == 0:
        _fail("Nothing left to backtest after filtering.")

    null = bt.null_baseline(everything, result.n_positions, frictions=frictions)
    verdict = bt.significance_vs_null(result, null)

    table = Table("Metric", "Value")
    table.add_row("Positions", f"{result.n_positions:,}")
    table.add_row("Win rate (after costs)", f"{result.win_rate:.1%}")
    table.add_row("Mean ROI", f"{result.mean_roi:+.2%}")
    table.add_row("Median ROI", f"{result.median_roi:+.2%}")
    table.add_row("ROI 95% CI", f"{result.roi_ci[0]:+.2%} … {result.roi_ci[1]:+.2%}")
    table.add_row("Total return", f"{result.total_return:+.1%}")
    table.add_row("Max drawdown", f"{result.max_drawdown:.1%}")
    if result.sharpe is not None:
        table.add_row("Sharpe (per position)", f"{result.sharpe:.2f}")
    if kol:
        table.add_row("Random-pick mean ROI", f"{null['mean_roi']:+.2%}")
        table.add_row("Edge over random", f"{verdict['edge']:+.2%}")
    console.print(table)

    if result.is_profitable:
        console.print(
            "[bold green]✓[/bold green] Profitable after follower frictions."
        )
    else:
        console.print(
            "[bold red]✗[/bold red] Not profitable once follower frictions are "
            "applied. Copying this roster as-is loses money."
        )

    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)
    result.equity_curve.write_parquet(settings.artifacts_dir / "equity_curve.parquet")


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


@app.command()
def stats() -> None:
    """Show what is currently in the local warehouse."""
    storage = get_storage()
    settings = get_settings()

    table = Table("Item", "Count")
    table.add_row("Raw files", f"{len(storage.list_raw_parquet()):,}")
    table.add_row("Trades", f"{storage.count_trades():,}")
    for chain in ("solana", "polymarket"):
        count = storage.count_trades(chain=chain)
        if count:
            table.add_row(f"  {chain}", f"{count:,}")

    frame = storage.get_positions()
    table.add_row("Positions", f"{frame.height:,}")
    if not frame.is_empty():
        closed = int(frame.select(pl.col("is_closed").sum()).item() or 0)
        table.add_row("  closed", f"{closed:,}")
    console.print(table)
    console.print(f"[dim]{settings.db_path}[/dim]")


@app.command()
def archive(
    include_model: bool = typer.Option(
        False, "--include-model", help="Also snapshot model.pkl (megabytes per run)"
    ),
) -> None:
    """Snapshot the current artefacts and write a readable report.

    Runs overwrite `artifacts/`, so without this a previous run's claims are
    gone — and comparing what a pattern claimed last month against what it did
    this month is the only test that isn't purely retrospective.
    """
    from .report import new_run_id, snapshot_run, write_report

    run_id = new_run_id()
    destination = snapshot_run(run_id, include_model=include_model)
    if destination is None:
        _fail("Nothing to archive yet.")

    report = write_report(destination, run_id=run_id)
    write_report(get_settings().artifacts_dir, run_id=f"{run_id} (latest)")

    console.print(f"[bold green]✓[/bold green] Archived run [bold]{run_id}[/bold]")
    console.print(f"[dim]{destination}[/dim]")
    console.print(f"[dim]Report: {report}[/dim]")


@app.command()
def runs() -> None:
    """List archived runs."""
    from .report import list_runs

    archived = list_runs()
    if not archived:
        console.print("[yellow]No archived runs.[/yellow] Run `pattern-ml archive`.")
        return

    table = Table("Run", "Patterns", "Survivors", "Report")
    for directory in archived:
        patterns = directory / "sequence_patterns.parquet"
        tested = survivors = "—"
        if patterns.exists():
            frame = pl.read_parquet(patterns)
            tested = f"{frame.height:,}"
            survivors = f"{frame.filter(pl.col('survives_fdr')).height:,}"
        table.add_row(
            directory.name,
            tested,
            survivors,
            "yes" if (directory / "REPORT.md").exists() else "no",
        )
    console.print(table)


@app.command("run-all")
def run_all(
    kols: Path = typer.Option(None, "--kols"),
    skip_pull: bool = typer.Option(False, "--skip-pull", help="Reuse data/raw/"),
    with_choice_sets: str = typer.Option(
        None,
        "--with-choice-sets",
        help="Also assemble + train for these chains, e.g. 'polymarket,solana'.",
    ),
    max_decisions: int = typer.Option(
        None, "--max-decisions", help="Cap decisions per chain. Strongly advised."
    ),
) -> None:
    """Run the deterministic stages end to end.

    Choice-set assembly is **opt-in** rather than part of the default chain. It
    is the one stage whose cost scales with your data rather than being bounded
    by the roster: Bitquery bills points per query on Solana, and Polymarket
    costs two requests per candidate per decision. A `run-all` that silently
    burned a quota would be a bad default, so it is requested explicitly.
    """
    if not skip_pull:
        pull(kols=kols, chains="solana,polymarket")
        console.print()
    index()
    console.print()
    positions()
    console.print()

    chains = [c.strip() for c in (with_choice_sets or "").split(",") if c.strip()]
    for chain in chains:
        # Every parameter is passed explicitly. Calling a Typer-decorated
        # function directly leaves any omitted argument as an `OptionInfo`
        # sentinel rather than its default value, which fails deep inside the
        # stage instead of here.
        choice_sets(
            chain=chain,
            min_volume=50_000.0,
            min_completion=0.70,
            max_candidates=20,
            max_decisions=max_decisions,
            same_category=True,
            fetch_liquidity=False,
        )
        console.print()
    if chains:
        rank(n_splits=4, drop_kol_features=False)
        console.print()
    else:
        # Say what was skipped. A stage missing from a run reads as "covered
        # everything" unless the omission is stated.
        console.print(
            "[dim]choice-sets/rank skipped — pass --with-choice-sets "
            "polymarket,solana to include them.[/dim]\n"
        )

    validate(entry_slippage=150.0, exit_slippage=150.0, fee=30.0, kol=None)


if __name__ == "__main__":
    app()
