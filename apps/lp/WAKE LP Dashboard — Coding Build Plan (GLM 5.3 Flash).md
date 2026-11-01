# WAKE LP Dashboard — Coding Build Plan (for GLM 5.3 Flash)

*A step-by-step, function-level task list grouped into build tracks. Each task should be built, tested, and confirmed working before moving to the next — don't batch multiple tasks into one pass.*

## How to use this doc

Work through tracks roughly in this order: A first (shared models, nothing else depends-free of it), then B and C (can run in parallel), then D, then E (depends on A + C), then F (depends on E), then G (depends on A + E + F), then H last (depends on everything). Within a track, tasks are already ordered — don't skip ahead. Each task should end with a passing test before the next one starts; that's the main lever for keeping a flash-tier model's output reliable across a build this size.

## MCP tools worth connecting before starting

- **A GitHub MCP server** — lets the agent create a branch and commit per finished task instead of one giant diff at the end. With a "one function at a time" approach, a commit boundary per task is the natural checkpoint, and makes a bad step easy to isolate and revert.
- **A Postgres MCP server** (or whichever database WAKE runs on) — Track A defines new tables/types for positions, pools, and risk scores. Letting the agent inspect and migrate the schema directly avoids it guessing column names that drift from what the rest of WAKE already uses.
- **A Solana RPC MCP server** — Tracks B, D, E, and F all have a Solana/Meteora path. Live devnet queries while building beat hand-written fixtures, especially for bin-math edge cases.
- **An EVM RPC MCP server pointed at Robinhood Chain** — same reasoning as above for the Uniswap v3/v4 path (Tracks B, D, E, F).
- **A web-search or docs-fetch MCP tool** — Meteora's Zap SDK and Uniswap v4's hooks are both young and still moving; having the agent pull current docs mid-task instead of relying on training data saves real debugging time, specifically on Tracks E and F.

## Track A — Shared data models

1. **Position model** — fields: id, user id, chain, pool address, strategy type (spot/curve/bidask), range bounds, per-rung allocation array, deposit amount + token, status enum (`building → active → near_edge → out_of_range → rebalancing → closed`), opened-at/closed-at timestamps.
2. **Pool model** — fields: chain, pool address, pair, TVL, active TVL, 24h volume, fee tier, realized fee APR, risk score, last-scanned timestamp.
3. **Risk guardrail config model** — per-user settings: max % of deployed capital per pool (default 50%), profit-bank % on realized gains (default 50%), reserve sub-vault reference.
4. **Net LP Result calculator** — pure function: `(feesEarned, impermanentLoss, gasCost, rebalanceCost, inventoryChange) → netResult`. No chain calls, no side effects — this gets reused by Tracks D, E, and F, so get the signature right here before building anything that depends on it.

## Track B — Pool scanner

1. **Solana/Meteora pool-list fetcher** — calls Meteora's pool endpoint, returns raw pool list for a given pair or "all pairs."
2. **Robinhood Chain pool-list fetcher** — same for Uniswap v3/v4 pools (subgraph query or direct RPC enumeration, whichever Robinhood Chain tooling supports better right now).
3. **Active-TVL calculator** — per chain: for Meteora, sum liquidity in bins near the active bin; for Uniswap v3/v4, sum liquidity in ticks near the current tick. Two implementations behind one interface.
4. **Realized fee APR calculator** — shared pure function: trailing 24h/7d fees ÷ TVL, taking normalized pool data from either fetcher.
5. **Volume/active-liquidity ranking function** — sorts a pool list by volume-to-active-liquidity ratio; shared across chains since it only needs the normalized Pool model from Track A.
6. **Scan job** — wires 1–5 into a single scheduled job that writes results into the Pool model table, tagged by chain.

## Track C — Token/wallet risk filter

1. **Holder-concentration checker** — top-10 holder percentage, using chain-specific token account queries.
2. **Bundled/connected-wallet volume detector** — heuristic pass: flag wallets funded from a common source within a short time window around launch.
3. **Liquidity-lock verifier** — checks whether LP tokens sit in a locked contract or burn address versus a freely-movable wallet.
4. **Mint-authority/permission checker** — can the deployer mint more supply, pause trading, or blacklist addresses.
5. **Risk score combiner** — folds 1–4 into a single score plus a pass/fail gate against the thresholds from the Track A guardrail config.
6. **Wire into scanner** — attach the risk score to every pool the Track B scan job writes, so nothing reaches the Discover feed without one.

## Track D — LP wallet indexer

1. **Solana LP-position reader** — reads a given wallet's DLMM position accounts.
2. **Robinhood Chain LP-position reader** — reads a given wallet's Uniswap v3/v4 position NFTs.
3. **PnL calculator per tracked wallet** — reuses the Track A Net LP Result function against indexed position history.
4. **Tracked-wallet storage layer** — which wallets are being watched, polling cadence, last-indexed timestamp.
5. **Leaderboard query** — sorts tracked wallets by realized PnL, win rate, and dominant strategy type for the LP Wallets screen.

## Track E — Ladder / position builder

1. **Meteora zap-in wrapper** — single-token deposit → auto-split via the Zap SDK → opens a position.
2. **Meteora ladder builder** — given a range, rung count, and Spot/Curve/Bid-Ask distribution, computes per-rung bin allocations and calls the zap-in wrapper per rung (check whether the SDK supports batching before assuming one call per rung).
3. **Uniswap v3/v4 zap-in wrapper** (Robinhood Chain) — single-token deposit → swap/split → mints a position.
4. **Uniswap v3/v4 ladder builder** — same per-rung logic as E2, using tick ranges instead of bins.
5. **Strategy-template resolver** — maps a named preset (tight-Spot scalp, deep Bid-Ask accumulation, wide-range dump-capture, passive majors auto-compound) to concrete ladder parameters for either chain.
6. **Build-position entrypoint** — single function taking `{chain, pool, template-or-custom-params, deposit}`, returning a signed-and-ready transaction bundle. This is what the "Deploy Ladder" button in the UI actually calls.

## Track F — Position monitor + rebalancer

1. **Active-bin/active-tick poller** — per chain, checks current price position against each open position's range on a schedule.
2. **Range-state classifier** — labels a position `active / near_edge / out_of_range` based on the poll result.
3. **Rebalance economic-check function** — pure function: expected extra fees vs. (IL + gas + repositioning cost). Build and test this against mock data before wiring it to anything live.
4. **Meteora rebalance executor** — wraps `rebalanceDlmmPosition` from the Zap SDK.
5. **Uniswap v3/v4 rebalance executor** — close position, swap if needed, remint around the new range.
6. **Scheduled wiring** — runs 1–2 on a cadence per open position, calls 3 when a position is near\_edge or out\_of\_range, fires 4 or 5 only when 3 returns a positive result.

## Track G — Risk guardrail enforcement

1. **Pool-exposure-cap check** — runs before Track E's build-position entrypoint commits; blocks or caps size if it would exceed the per-pool % limit from the Track A config.
2. **Profit-banking sweep** — triggered on position close or fee harvest; moves the configured % of realized gain to the user's reserve sub-vault.
3. **Reserve sub-vault model** — a separate PDA on Solana, a separate address on Robinhood Chain, reusing WAKE's existing non-custodial vault pattern rather than inventing a new custody path.
4. **State machine wiring** — folds 1–3 into the same order lifecycle state machine already used for trade execution, rather than running a parallel one.

## Track H — API / dashboard wiring

1. **Discover feed endpoint** — paginated, sortable, serves Track B+C output.
2. **LP Wallets leaderboard endpoint** — serves Track D output.
3. **Position manager endpoint** — open positions, live PnL, rebalance-recommendation flag, serves Track F output.
4. **Strategy template list endpoint** — serves the Track E5 resolver's available presets.
5. **Deploy-ladder action endpoint** — calls Track E6, gated by Track G1.
