WAKE LP Dashboard — Coding Build Plan (for GLM 5.3 Flash)
A step-by-step, function-level task list grouped into build tracks. Each task should be built, tested, and confirmed working before moving to the next — don't batch multiple tasks into one pass.
How to use this doc
Work through tracks roughly in this order: A first (shared models, nothing else depends-free of it), then B and C (can run in parallel), then D, then E (depends on A + C), then F (depends on E), then G (depends on A + E + F), then H last (depends on everything). Within a track, tasks are already ordered — don't skip ahead. Each task should end with a passing test before the next one starts; that's the main lever for keeping a flash-tier model's output reliable across a build this size.
MCP tools worth connecting before starting
• A GitHub MCP server — lets the agent create a branch and commit per finished task instead of one giant diff at the end. With a "one function at a time" approach, a commit boundary per task is the natural checkpoint, and makes a bad step easy to isolate and revert.
• A Postgres MCP server (or whichever database WAKE runs on) — Track A defines new tables/types for positions, pools, and risk scores. Letting the agent inspect and migrate the schema directly avoids it guessing column names that drift from what the rest of WAKE already uses.
• A Solana RPC MCP server — Tracks B, D, E, and F all have a Solana/Meteora path. Live devnet queries while building beat hand-written fixtures, especially for bin-math edge cases.
• An EVM RPC MCP server pointed at Robinhood Chain — same reasoning as above for the Uniswap v3/v4 path (Tracks B, D, E, F).
• A web-search or docs-fetch MCP tool — Meteora's Zap SDK and Uniswap v4's hooks are both young and still moving; having the agent pull current docs mid-task instead of relying on training data saves real debugging time, specifically on Tracks E and F.
Track A — Shared data models
1. Position model — fields: id, user id, chain, pool address, strategy type (spot/curve/bidask), range bounds, per-rung allocation array, deposit amount + token, status enum (building → active → near_edge → out_of_range → rebalancing → closed), opened-at/closed-at timestamps.
2. Pool model — fields: chain, pool address, pair, TVL, active TVL, 24h volume, fee tier, realized fee APR, risk score, last-scanned timestamp.
3. Risk guardrail config model — per-user settings: max % of deployed capital per pool (default 50%), profit-bank % on realized gains (default 50%), reserve sub-vault reference.
4. Net LP Result calculator — pure function: (feesEarned, impermanentLoss, gasCost, rebalanceCost, inventoryChange) → netResult. No chain calls, no side effects — this gets reused by Tracks D, E, and F, so get the signature right here before building anything that depends on it.
Track B — Pool scanner
1. Solana/Meteora pool-list fetcher — calls Meteora's pool endpoint, returns raw pool list for a given pair or "all pairs."
2. Robinhood Chain pool-list fetcher — same for Uniswap v3/v4 pools (subgraph query or direct RPC enumeration, whichever Robinhood Chain tooling supports better right now).
3. Active-TVL calculator — per chain: for Meteora, sum liquidity in bins near the active bin; for Uniswap v3/v4, sum liquidity in ticks near the current tick. Two implementations behind one interface.
4. Realized fee APR calculator — shared pure function: trailing 24h/7d fees ÷ TVL, taking normalized pool data from either fetcher.
5. Volume/active-liquidity ranking function — sorts a pool list by volume-to-active-liquidity ratio; shared across chains since it only needs the normalized Pool model from Track A.
6. Scan job — wires 1–5 into a single scheduled job that writes results into the Pool model table, tagged by chain.
Track C — Token/wallet risk filter
1. Holder-concentration checker — top-10 holder percentage, using chain-specific token account queries.
2. Bundled/connected-wallet volume detector — heuristic pass: flag wallets funded from a common source within a short time window around launch.
3. Liquidity-lock verifier — checks whether LP tokens sit in a locked contract or burn address versus a freely-movable wallet.
4. Mint-authority/permission checker — can the deployer mint more supply, pause trading, or blacklist addresses.
5. Risk score combiner — folds 1–4 into a single score plus a pass/fail gate against the thresholds from the Track A guardrail config.
6. Wire into scanner — attach the risk score to every pool the Track B scan job writes, so nothing reaches the Discover feed without one.
Track D — LP wallet indexer
1. Solana LP-position reader — reads a given wallet's DLMM position accounts.
2. Robinhood Chain LP-position reader — reads a given wallet's Uniswap v3/v4 position NFTs.
3. PnL calculator per tracked wallet — reuses the Track A Net LP Result function against indexed position history.
4. Tracked-wallet storage layer — which wallets are being watched, polling cadence, last-indexed timestamp.
5. Leaderboard query — sorts tracked wallets by realized PnL, win rate, and dominant strategy type for the LP Wallets screen.
Track E — Ladder / position builder
1. Meteora zap-in wrapper — single-token deposit → auto-split via the Zap SDK → opens a position.
2. Meteora ladder builder — given a range, rung count, and Spot/Curve/Bid-Ask distribution, computes per-rung bin allocations and calls the zap-in wrapper per rung (check whether the SDK supports batching before assuming one call per rung).
3. Uniswap v3/v4 zap-in wrapper (Robinhood Chain) — single-token deposit → swap/split → mints a position.
4. Uniswap v3/v4 ladder builder — same per-rung logic as E2, using tick ranges instead of bins.
5. Strategy-template resolver — maps a named preset (tight-Spot scalp, deep Bid-Ask accumulation, wide-range dump-capture, passive majors auto-compound) to concrete ladder parameters for either chain.
6. Build-position entrypoint — single function taking {chain, pool, template-or-custom-params, deposit}, returning a signed-and-ready transaction bundle. This is what the "Deploy Ladder" button in the UI actually calls.
Track F — Position monitor + rebalancer
1. Active-bin/active-tick poller — per chain, checks current price position against each open position's range on a schedule.
2. Range-state classifier — labels a position active / near_edge / out_of_range based on the poll result.
3. Rebalance economic-check function — pure function: expected extra fees vs. (IL + gas + repositioning cost). Build and test this against mock data before wiring it to anything live.
4. Meteora rebalance executor — wraps rebalanceDlmmPosition from the Zap SDK.
5. Uniswap v3/v4 rebalance executor — close position, swap if needed, remint around the new range.
6. Scheduled wiring — runs 1–2 on a cadence per open position, calls 3 when a position is near_edge or out_of_range, fires 4 or 5 only when 3 returns a positive result.
Track G — Risk guardrail enforcement
1. Pool-exposure-cap check — runs before Track E's build-position entrypoint commits; blocks or caps size if it would exceed the per-pool % limit from the Track A config.
2. Profit-banking sweep — triggered on position close or fee harvest; moves the configured % of realized gain to the user's reserve sub-vault.
3. Reserve sub-vault model — a separate PDA on Solana, a separate address on Robinhood Chain, reusing WAKE's existing non-custodial vault pattern rather than inventing a new custody path.
4. State machine wiring — folds 1–3 into the same order lifecycle state machine already used for trade execution, rather than running a parallel one.
Track H — API / dashboard wiring
1. Discover feed endpoint — paginated, sortable, serves Track B+C output.
2. LP Wallets leaderboard endpoint — serves Track D output.
3. Position manager endpoint — open positions, live PnL, rebalance-recommendation flag, serves Track F output.
4. Strategy template list endpoint — serves the Track E5 resolver's available presets.
5. Deploy-ladder action endpoint — calls Track E6, gated by Track G1.
Revision — self-directed, not auto-managed
LP positions are user-built and user-managed through WAKE's own tools, the same way someone would use Meteora's DLMM interface directly — not an algorithm picking pool and range and executing on the user's behalf. Strategy templates and LP-wallet copying stay, but as starting points the user reviews and confirms, not auto-pilot actions. This changes a few pieces of the plan above and adds one new track.
What's unchanged
Tracks A through D, Track E's ladder-building mechanics (E1–E4, E6), Track H's endpoints, and the MCP tool list all stay exactly as written — none of that logic cares whether a human or an algorithm supplied the final range and distribution parameters.
What changes
• E5 (strategy-template resolver) no longer feeds E6 directly. It now pre-fills an editable builder state the user can adjust before confirming — add a small validation function that checks a user-edited (possibly template-seeded) set of parameters before the confirm action is allowed to call E6.
• F6 (scheduled wiring) no longer auto-fires the rebalance executor by default. F3's positive result now just flags a recommendation on the position record for the UI to surface. The rebalance executors (F4/F5) only run on an explicit user action, or when a position has the auto-rebalance opt-in flag set (see I4 below).
• Track G's guardrails are worth revisiting as confirmations rather than hard blocks in a self-directed product — flag this as an open decision rather than assuming either way.
New: Track I — Manual position builder
1. Live bin/tick-ladder fetch — given a selected pool, returns current price plus nearby bin/tick structure and liquidity depth, formatted for a visual range editor.
2. Range/distribution live-preview calculator — pure, read-only: given a user-set range, rung count, and Spot/Curve/Bid-Ask choice, computes the resulting per-rung allocation and the range-specific expected fee-capture zone, nothing submitted on-chain. Called on every drag/edit in the UI, so it needs to be fast.
3. Manual-build confirm handler — takes the user's final parameters (template-seeded or fully custom) and calls the existing E6 entrypoint. No new on-chain logic, just wiring from the new builder UI.
4. Auto-rebalance opt-in field — a per-position boolean added to the Position model from A1. Track F's scheduled wiring checks this flag before auto-firing; otherwise it only flags the recommendation.
5. Manual rebalance trigger endpoint — exposes F4/F5 as a user-callable action for a "Rebalance now" button, separate from any auto-path.
Revision 2 — reintroducing automation, suggested master wallets, and demo mode
The platform now ships four modes side by side: manual self-directed building (Track I, unchanged), LP-wallet copying (Track D, unchanged), a new fully-autonomous strategy mode for advanced users, and a demo/paper-trading mode scoped specifically to that autonomous mode — manual and copy modes don't need simulation since the user directly sees and controls what they're doing.
New: Track J — Ingestion layer upgrade (latency-sensitive paths)
Both the wallet-copy and automated-strategy modes need faster-than-polling data. Build this once, shared by both.
1. Solana Geyser stream listener — gRPC stream (Triton/Helius-class provider) against the Meteora DLMM program, filtering for addLiquidity / removeLiquidity / claimFee instructions. Replaces polling for any latency-sensitive path; Track D's indexer can still poll for the leaderboard/history views where latency doesn't matter.
2. EVM WebSocket event listener — subscribes to Mint / Burn / Collect events on Uniswap v3/v4 pool contracts via a WebSocket RPC connection (Alchemy/QuickNode-class provider), for Robinhood Chain.
3. Unified event schema — normalizes both listeners' output into one JSON shape (chain, masterWallet, action, poolAddress, token0/token1, positionId, strategyType, range bounds, raw amounts). Both Track D (copying) and the new Track K (automation) consume this schema rather than chain-specific payloads.
4. Proportional-sizing calculator — given a master wallet's absolute position size and a follower's allocated budget, computes the ratio and scales token inputs to match price bounds exactly at a different size. This is the actual math behind "copy," now made precise — feeds the existing Mirror flow (Screen 2) instead of leaving it as a vague scaling step.
New: Track K — Automated strategy engine (advanced/opt-in mode)
This is a second execution path, separate from Track I's manual builder — it runs without a per-action confirm step once a user has opted a position into it.
1. Strategy rule schema — a structured, storable definition of an automated strategy: trigger condition, pool-selection rule, liquidity-structuring rule (asset split, bound offsets from current price), monitoring cadence, exit-condition rule. Evil Panda becomes the first entry in this schema, not special-cased code.
2. Trigger evaluator — watches for a strategy's entry condition (e.g. volume/TVL ratio crossing a threshold, price pump over a set % in a set window) using Track J's normalized event stream.
3. Pool-selection resolver — given a trigger firing, queries Track B's scanner output for the matching pool per the strategy's rule (e.g. "highest fee tier available for this pair").
4. Autonomous ladder builder — computes bounds and asset split per the strategy rule and calls Track E's ladder-building primitives directly — no user confirm step, this is what distinguishes Track K from Track I.
5. Monitoring loop — runs on a short interval (not Track F's economic-gated cadence — this mode is meant to watch closely once committed) checking the exit-condition rule against live indicators (e.g. RSI(2), Bollinger Band position) sourced from a price-feed/indicator service.
6. Autonomous exit executor — when the exit condition fires, calls remove-liquidity and swap-back as one atomic action, converting back to the base asset. Reuses Track E/F's underlying transaction primitives; the difference from Track F is that this fires without a human approving the specific trade.
7. Strategy library storage — persists strategy rule definitions (Track K1) so they can be listed, selected, and (for advanced users) cloned/edited — feeds both the Strategy Templates screen and a new "Automated Strategies" surface.
New: Track L — Suggested master wallets
1. Wallet-quality scoring function — beyond Track D's raw PnL/win-rate, scores tracked wallets on consistency (PnL variance over time, not just total), track record length, and strategy-type diversity — feeds a "suggested for new users" subset rather than just the top of the raw leaderboard.
2. New-user onboarding query — serves a short curated list from L1's output specifically for users with no tracked wallets yet, surfaced during onboarding rather than requiring the user to find the leaderboard first.
New: Track M — Demo mode (scoped to automated strategies only)
Manual building and wallet-copying are not simulated — a user directly sees and controls those, so a demo layer adds little. Demo mode exists specifically so a user can trust an automated strategy before opting real capital into it.
1. Virtual balance ledger — a per-user demo balance, separate from any real vault, with its own deposit/reset actions (no real token transfer involved).
2. Simulated execution adapter — intercepts Track K's autonomous ladder builder (K4) and exit executor (K6) calls when a strategy is running in demo mode: computes the same fills, fees, and bound math against live real-time price/liquidity data, but writes results only to the virtual ledger — no transaction is ever built or signed.
3. Demo position state — reuses the Position model (A1) and the order lifecycle state machine, tagged isDemo: true, so demo positions appear in the same Position Manager views without polluting real PnL totals or triggering Track G's real-capital guardrails.
4. Demo-to-live promotion flow — a function that takes a demo strategy configuration a user is satisfied with and hands it to Track K's real executor path with the user's actual deposit — the strategy definition carries over unchanged; only the execution adapter and capital source change.
MCP tools — additions for this revision
• A price/indicator feed MCP tool (or wrapping an existing one like TAAPI or a DEX-data aggregator) — Track K5's exit-condition monitoring needs RSI/Bollinger Band-class indicators on short intervals; building that math from raw price ticks in-house is avoidable work.
• GoPlus Security / RugCheck API access (EVM / Solana respectively) — slot into Track C's risk filter as the actual token-safety check (mint-function detection, honeypot flags) rather than building equivalent heuristics from scratch; faster to ship, and this is exactly what Track K3's pool-selection resolver should gate on before an automated strategy ever deploys into a new pool.
