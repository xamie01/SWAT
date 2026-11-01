# ADR-0005 — Single-master mirroring, not cluster consensus

- **Status:** Accepted
- **Date:** 2026-08-19
- **Replaces:** the cluster-consensus trade thesis implemented by the four pattern
  detectors in `apps/signal-engine/src/index.ts`. Those detectors survive as
  *discovery* inputs; they stop being trade triggers.
- **Rewrites:** `S4-13` (eligible-user enumeration), `S4-P4` (per-user slippage
  becomes per-user sizing too), `S3-6` / `S3-9` ordering (Trojan retirement is
  pulled forward), `S4-P15` (relayer-cap behaviour gains a fairness rule)
- **Does not touch:** ADR-0003's authority model. Mirroring changes *what* we
  execute and *when*, not *by what right*.

## Decision

A user copies **one master wallet per chain**, chosen by them or from our
suggestions. When that wallet buys, they buy; when it sells, they sell. Cluster
detection is demoted from trade trigger to two supporting roles: surfacing
candidate masters, and warning that a wallet is not an independent actor.

## §1 Why the cluster model had to go

The previous thesis was: find a cluster of related wallets, wait for N of them to
buy the same token, copy. Four defects, the first of which is structural rather
than a tuning problem.

**1.1 The grouping predicate and the signal predicate are the same statement.**
`behavioral` clusters are built from `sync_pairs` — wallet pairs that bought the
same tokens synchronously more than three times (`clustering-queries.ts:125`). The
snipe detector then fires when ≥ 3 members of a cluster buy the same token inside
five minutes (`signal-engine/src/index.ts:299`). So:

- Grouped **because** these wallets buy together.
- Signalled **when** these wallets buy together.

The signal is a restatement of the grouping criterion at a shorter time scale. It
is close to guaranteed to fire on any active cluster and carries almost no
information beyond "this group is doing the thing that defines it."

The confidence formula compounds it: behavioral confidence is
`0.50 + sync_count × 0.05` (`:148`), so **confidence rises with dependence** — the
more likely these wallets are one actor, the more we trusted the signal. And snipe
scores start at base 82 against a trade gate of `>= 80` (`:213`), so every snipe
signal cleared the gate before any bonus. The score never discriminated.

**1.2 The inference runs backwards.** Every real-world consensus strategy —
insider cluster buys, 13F consensus cloning, analyst revision breadth — depends on
the group being defined **exogenously** to the predicted behaviour, so that
co-movement is evidence of a shared *fact*. Ours groups on co-movement, so
co-movement is evidence of shared *control*. `funding` clusters make this explicit:
the code comment at `clustering-queries.ts:28` calls a funding hub "the
Sybil/coordination signal", and the detector at `:292-294` does not filter by
`cluster_type` at all, so Sybil groups and behavioural groups fed the same trigger.

Consequence: a coordinated group buying one token in five minutes is the signature
of a pump, and that group's next action is to sell into the flow their buying
attracted. Following them made us their exit liquidity structurally, not
occasionally. Note the asymmetry against the insider analogue — insiders cannot
legally dump on followers at scale; for the entity we were following, that is the
business model.

**1.3 Horizon mismatch.** Insider cluster buys and 13F cloning are multi-month
anomalies where a 45-day filing lag is immaterial. We ported that shape onto a
five-minute window in markets whose entire lifecycle is minutes.

**1.4 No hub cap.** `HAVING COUNT(DISTINCT wr.wallet_b) >= 2`
(`clustering-queries.ts:44`) sets a minimum and no maximum, and there is no
exchange exclusion. A CEX hot wallet funds millions of addresses and becomes one
enormous "Funding Group" whose members trivially satisfy "3 wallets bought this in
5 minutes" for anything trending — systematically firing on whatever is already
popular.

## §2 Most of the new model already exists

This is a demotion and a completion, not a rewrite.

| Piece | Status |
| --- | --- |
| Per-trade, per-wallet signal | **Built** — `processSourceTradeSignals` emits `patternType: 'source_trade'` carrying `sourceWallet`, `sourceQuantity`, `sourceAmountUsd`, `sourcePriceUsd`, `sourceEventAt`, `sourceWalletTier`, and it is the one detector on the Redis pub/sub fast path |
| User ↔ master subscription | **Built** — `044_user_wallet_subscriptions`, with `source IN ('manual','platform-signal','discovered')` already distinguishing user-chosen from suggested |
| Proportional exits | **Built and correct** — `computeCopySellProportion` (`copy-trade-lifecycle.ts:242`) is `min(1, sourceReductionQuantity / sourcePositionBeforeQuantity)` applied to the user's confirmed quantity, enforced on all three chains (`index.ts:1374`, `:1703`, `:1839`), each throwing `UnrecoverableError` rather than defaulting to `10_000` bps when position evidence is missing |
| Position ledger | **Built** — `copy_positions` with cost basis and `unmatched_reduction_quantity` |
| The four cluster detectors | **To be demoted** (§6) |

## §3 Mirroring semantics

**3.1 Buy sizing is hybrid.** `min(max_position_pct, master_fraction × scale)`,
`scale` default 1.0. Today sizing is purely `riskPct` of the user's own balance
(`index.ts:508`), which flattens the master's conviction — a 2% speculative punt
and a 40% core position produce the same allocation. The hybrid transmits
conviction while keeping the user's own risk ceiling binding.

`master_fraction` is computed over **the assets we index**. When portfolio coverage
falls below a threshold we fall back to flat `max_position_pct` and mark the trade
**sized-without-conviction**, rather than presenting a fraction derived from a
portfolio we cannot see.

**3.2 Mirrorable activity** is buys and sells above a minimum notional. Transfers,
LP, staking and dust are excluded. Tokens failing existing safety checks are
skipped.

**3.3 Max concurrent copied positions is a per-user setting**, exposed API → UI,
stored in `049`. Two guards: a platform hard ceiling, and a *derived* warning at
the point of configuration — beyond N positions at a given balance, each copy falls
below venue minimum order size and every trade would be skipped by §7.3. Better
said at the slider than discovered in a skip reason.

**3.4 Underfunded trades skip with a stated reason.** Never a silent partial.

**3.5 Multiple masters per chain are allowed**, with per-token exposure capped
across masters and deduplication when two masters buy the same token.

**3.6 Joining is forward-only.** A user subscribing to a master already holding
twelve tokens mirrors only trades from subscription onward. Buying into an existing
position at an unknown cost basis is how followers become exit liquidity.

**3.7 Unsubscribe means exits-only wind-down, not liquidation and not
abandonment.** Both obvious options are wrong. Auto-selling is a market action the
user did not request — taxable, fee-bearing, slippage-bearing, and at scale 500
users unsubscribing from one master is a coordinated sell *we* caused. But simply
stopping leaves those positions orphaned, because their exit was going to arrive as
the master's sell mirror. So: stop copying entries immediately, keep honouring the
master's sells against already-open positions until each closes, and offer an
explicit "close all now".

Schema implication, required from the start: a subscription has three states —
`active` / `winding_down` / `ended`. Retrofitting this means reconstructing which
open position came from which subscription.

**3.8 When a master sells more than the user holds** (a forward-only artefact), cap
at the user's holding and record the remainder in the existing
`unmatched_reduction_quantity`. Never sell what is not there.

**3.9 Inventory attribution under multiple masters** is specified by
[ADR-0007](./0007-master-attributed-inventory.md). The aggregate venue position
and the master-attributed accounting lots are intentionally separate: a master
sell reduces only that master's copied lot, while manual aggregate exits and
Polymarket redemption operate on the actual user position. No implementation may
apply a source sell fraction to the user's aggregate token quantity without first
resolving the source master's lot.

## §4 Capacity

**4.1 The cap is denominated in price impact, not headcount.** Aggregate copy
notional per `(master, token, window)` as a fraction of usable liquidity. Follower
count is a proxy that fails exactly where it matters: 500 followers buying
SOL/USDC is harmless, 50 buying a fresh memecoin is not. A follower soft-cap
remains as a crude secondary so no single master becomes an operational
concentration risk regardless of what they trade.

**4.2 When any capacity limit binds, everyone is skipped uniformly.** This is the
fairest rule and it removes the need to choose winners by tier.

**4.3 One master must not be able to starve the platform.** A trader doing 400
trades a day copied by 25 users is 10,000 Polymarket orders — the entire daily
relayer budget, blanking the venue for users copying *other* masters. Therefore
per-master budget allocation *inside* the daily cap.

**4.4 User-facing message is generic; internal reason code is specific.** Users see
"at capacity, scaling infrastructure". Ops and telemetry get a reason code naming
the actual constraint. Nothing stated is false — it is a capacity limit and we are
scaling — but the venue's relayer quota is not itemised to users.

## §5 Suggestion engine

**5.1 Out-of-sample metrics only**, computed over **24h / 7d / 30d**: PnL net of
fees, max drawdown, hit rate, median hold time, capacity estimate. Explicitly not
raw ROI, which ranks the luckiest.

**5.2 Minimum trade count enforced per window.** A 30-day metric from three trades
is noise wearing a number; show "insufficient history" instead.

**5.3 Divergence across windows is itself the signal.** A master strong on 30d and
weak on 24h is decaying, and that is more actionable than either figure alone.

**5.4 Follower counts and popularity are not shown.** They create reflexive
crowding and tell a master precisely when farming their own followers is
profitable.

**5.5 A wallet inside a funding or behavioural cluster carries a warning.** This is
the highest-value surviving use of the clustering work.

**5.6 Un-indexed wallets are copyable immediately.** Backfill is not on the
critical path — live mirroring needs the wallet subscribed to the data stream, not
its history. History only populates the track record. Measured durations:

| Chain | Mechanism | Duration |
| --- | --- | --- |
| Solana | one `getSignaturesForAddress` (≤1000), then `getTransaction` in batches of 5 with a 150 ms sleep (`indexer/src/index.ts:527-529`), then sequential `processTransaction` | ~5 s quiet; **90 s – 2.5 min** at the 1000-signature cap |
| Robinhood Chain | `getLogs` in 2000-block chunks (`evm.ts:156`) | seconds |
| Polymarket | Data API, 500/page, windowed offset paging (`polymarket.ts:45-70`) | seconds |

Solana is slowest because Solana has no plural `getTransaction` RPC, making it 200
sequential round trips minimum. The user-facing copy is therefore *"copying now;
performance history still loading"* — true on every chain, and it avoids promising
"a few seconds" for precisely the active wallets users will actually add.

## §6 Disposition of the cluster model

**6.1 The four cluster detectors get `suppressTrade: true`.** They keep running,
they keep alerting, they stop trading. One-line change per detector, reversible,
and it removes the §1.2 exposure immediately.

**6.2 Behavioural clustering is retained as a dependence detector**, feeding
independence filtering and §5.5 warnings. Never as consensus.

**6.3 Funder degree is capped and exchange hubs excluded** — a bug under either
model.

## §7 Per-venue execution

**7.1 Solana — Jupiter+Jito, Trojan retired.** Ordering is non-negotiable:
certify (`S3-9`) → cut over `SOLANA_EXECUTOR` → delete Trojan (`S3-6`). Flipping
the flag first would put an uncertified path on the money path, inverting the
audit's own ordering. Jito-only to start, accepting that a missed bundle has no
second path. Priority fee stays `undefined` while Jito-only — the reasoning at
`jupiter-swap.ts:41-44` is correct that a tip and a priority fee inside a bundle
double-pay for inclusion — but becomes **mandatory** the moment we fan out, since
multi-path senders reject sends missing either. Add pre-trade simulation (currently
absent repo-wide). Slippage bounded by per-user `049.max_slippage_bps` as a
ceiling, route-aware within it. Verify `wrapUnwrapSOL` against a live response — a
renamed parameter would be silently ignored and SOL would stop unwrapping.

**7.2 EVM / Robinhood Chain.** Polygon is **not** a swap venue; every
`chain === 'polygon'` branch is Polymarket, and the `liveTokenSell` predicate in `index.ts` excludes polygon
from token sells. So EVM execution means Robinhood Chain via Uniswap V3.

- **Robinhood Chain runs a single sequencer**, so there is no public mempool and no
  sandwich exposure. **MEV protection is not built.** What replaces it: the
  sequencer can reorder or censor, which is a chain-level trust assumption to
  document rather than engineer around; and no mempool means no in-flight
  visibility, so the confirmation model matters more, not less.
- **Approvals:** Permit2 if the router supports it, otherwise a rolling bounded
  allowance. Today `robinhood.ts:683` tests `allowance !== amountIn` and approves
  the exact amount, so in practice it approves on every trade — two blocks of
  latency and 2× gas standing between the user and their fill. A bounded allowance
  to a pinned router is also the shape `S4-P10`'s policy layer wants.
- **Per-user nonce allocation is a correctness requirement, not an optimisation.**
  Today there is one operator key (`robinhood.ts:204`) and the flow is
  `getPendingNonce` then local `nonce++` (`:670`, `:722`). Under fan-out, two
  concurrent jobs for one user read the same pending nonce, both submit it, and one
  is silently replaced — one fill vanishes with no error anywhere. Fix: advisory
  lock on `(chain, account)` plus per-user queue concurrency.
- **Native gas minimum per user**, USD-denominated and priced live, mirroring
  `S4-P20`; skip-with-reason when unpriceable.
- **Confirmation is three-way** — landed / definitively not / unobserved — with
  replacement detection and no fabricated fills.

**7.3 Polymarket.** An order book, so a buy can partially fill or not fill at all —
the deepest divergence from the mirroring promise, since a master's fill at 0.62
does not mean 0.62 is available to us.

- **FAK with a maximum price bound derived from the master's fill.** A resting
  order is not mirroring, and a late fill on a resolving market is the stale-signal
  failure `S4-P15` already rejected queuing for.
- **Exit-order failure escalates then alerts.** Never leave a user silently holding
  a position their master has left.
- **Sub-minimum or off-tick orders skip with a reason.** Rounding to tick changes
  the user's price, which is not ours to choose.
- **negRisk representation is preserved, not normalised.** Buying NO on one outcome
  is not the same position as buying YES across the complement, even where the
  economics look similar.
- **Staleness is a fraction of remaining time-to-resolution**, not a constant. Six
  hours late on a market resolving in two days is a different risk from six hours
  late on a token buy.
- **Redemption is a first-class exit path.** If the master holds to resolution the
  sell mirror never fires.

## §8 Consequences

**8.1 Latency stops being arguable and becomes the product.** Under cluster
consensus, a 15 s authoritative tick was defensible because consensus takes seconds
to form. Under "when he buys, you buy" it is not. The `60_000` ms signal→alert
target at `solana-latency.ts:1` is no longer a target, it is a defect.

**8.2 The detection tier is now a launch dependency.** Helius's own documentation
places webhooks at the highest-latency tier, recommended for "low-volume
server-to-server work", and lists copy trading under preconfirmations → raw shreds
→ preprocessed transactions. First move is LaserStream gRPC at `processed`, which
also carries account state — shreds and preprocessed transactions carry transaction
data only, so anything reading a bonding curve or token balance needs the gRPC
path regardless. Preconfirmations later.

**8.3 The Polymarket relayer quota caps user count, not just trades.** 10,000/day
platform-wide. This is structural and cannot be engineered away — only allocated
(§4.3) and disclosed generically (§4.4).

**8.4 What this does not change.** ADR-0003's scoped-authority model, the
certification gate, the position ledger, idempotency keys, and the fail-closed
discipline throughout. Those are what make multi-tenant operation possible at all
and none of them are affected by which signal we act on.
