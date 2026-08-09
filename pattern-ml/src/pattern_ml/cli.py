"""Pattern-ML command line.

    pull → index → positions → [mine] → validate → archive

Each stage persists its output, so stages can be re-run independently. Only
``pull`` touches the network; everything after it is local and cheap, which is
what makes iterating on a normalization rule practical at 1-2M rows.

``mine`` is currently unavailable: the feature-engineering and model-training
approach is still being decided, so ``pattern_ml.features`` and
``pattern_ml.mine`` are intentionally absent rather than half-built. Every
other stage works today, and ``validate`` runs directly against positions, so
the roster-level backtest is available without any model.
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
# Stage 4 — mine (pending a decision on the modelling approach)
# ---------------------------------------------------------------------------


@app.command()
def mine(
    method: str = typer.Option("all", "--method", help="all | cluster | sequence | model"),
) -> None:
    """Hunt for patterns. Currently unavailable — approach under review."""
    try:
        from .mine import cluster  # noqa: F401
    except ImportError:
        _fail(
            "The mining layer is not built yet.\n\n"
            "The feature-engineering and model-training approach is still being "
            "decided — specifically whether the model learns from KOL behaviour "
            "(a follower) or from token state at the moment a KOL buys (a "
            "learner that can fire before anyone else does).\n\n"
            "Everything upstream works: `pull`, `index`, `positions`, and "
            "`validate` (which backtests the whole roster without needing a "
            "model)."
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
) -> None:
    """Run every stage that is currently available, end to end."""
    if not skip_pull:
        pull(kols=kols, chains="solana,polymarket")
        console.print()
    index()
    console.print()
    positions()
    console.print()
    validate(entry_slippage=150.0, exit_slippage=150.0, fee=30.0, kol=None)


if __name__ == "__main__":
    app()
