# Low-latency execution and adverse-ordering review

2026-11-06. This document preserves the static latency assessment. Subsequent bounded public requests and local single-worker queue samples are in [runtime verification](04-runtime-verification.md); they do not establish end-to-end latency distributions, deployed routes or provider guarantees. No fixes applied. NOT RUN statements below refer to the named proposed benchmarks/regressions, not all later application tests.

## Incorrect premises first

- **Every event does not wait fifteen seconds.** Pub/sub triggers immediate processing; 15-second DB polling is the authoritative fallback. Poll phase/outages add jitter, not a universal fixed delay (`apps/signal-engine/src/index.ts:693-724`).
- **Current user Solana copying is not proven vault execution.** Production supplies the operator signer, user authority invents a settlement identity, and Jupiter builds an ordinary signer-account transaction (`apps/trade-executor/src/index.ts:1125-1162`; `apps/trade-executor/src/execution-authority-adapters.ts:546-568,604-618`; `apps/trade-executor/src/jupiter-jito-runtime.ts:238-244`). Downstream synthetic-address acceptance and live user-PDA debits **NOT VERIFIED**.
- **Private submission is not immunity to predictable flow.** Operator-first sequential fan-out remains correlated with source activity (`apps/signal-engine/src/fanout-enqueue.ts:225-255,349-359`). Solana must not be described using Ethereum's global public-mempool model. Actual pending visibility/relay behavior **NOT VERIFIED**; the Robinhood ADR itself leaves visibility probes open (`docs/adr/0006-robinhood-sequencer-trust.md:41-63,218-231`).
- **TVL is not executable depth.** Current capacity derives usable liquidity from half the deepest reported pair TVL (`packages/db/src/master-capacity.ts:174-198`). It cannot guarantee the price of a cohort-sized executable route.
- **Freshness checks are not entirely absent.** Source eligibility is checked before the canonical claim, and that claim checks signal expiry (`apps/trade-executor/src/index.ts:1626-1658`; `packages/db/src/copy-trade-lifecycle.ts:1864-1897`). Polymarket additionally performs resolution-aware source-age checks before order creation (`apps/trade-executor/src/polymarket.ts:797-843`). These do not establish a universal final-sign freshness check for other venues.
- **Timeouts are not measured latency or an SLA.** PM's reported latency covers POST only; RHC's begins after quote/approval/simulation (`apps/trade-executor/src/polymarket.ts:878-881,910-919`; `apps/trade-executor/src/robinhood.ts:881-944`). No p50/p95/p99 is supported by this review.

## Fix order: safety before speed

1. **Keep user execution fail-closed until identity is real.** Remove operator fallback and synthetic addresses; preserve explicit operator execution and current unsupported user RHC/PM denials. Thread `userId` through every claim/write before tuning throughput (`apps/trade-executor/src/execution-authority-adapters.ts:462-467,546-568,585-618`; `apps/trade-executor/src/index.ts:1179-1217`; `packages/db/src/trades.ts:179`).
2. **Reserve the whole cohort atomically.** Reserve account/mode exposure and master/asset route capacity before enqueue/submit. Include pending/unknown work and operator flow; release only on proven outcomes. Current cap is a confirmed-trade sum plus a non-atomic comparison, and capacity accrual failure logs/continues (`packages/db/src/trades.ts:423-433`; `apps/trade-executor/src/index.ts:1551-1565,1319-1338`). Handle reducing exits through their own bounded recovery path, not by widening entry admission.
3. **Add a last-sign economic deadline.** Freeze maximum source age, quote age, master-relative adverse price, user slippage and fee/tip budget into immutable intent. Revalidation may tighten, never widen. Requote/resimulate after approval waits; RHC computes its deadline before waiting for approval (`apps/trade-executor/src/robinhood.ts:795-851`). Reject stale entries before signing; make exit escalation explicit.
4. **Preserve private routing without blind retries.** Jito does not fall back to public broadcast on ambiguous failure; retain this behavior. Persist signed transaction/order identity and ownership *before* transport, then reconcile unknown state without rebuild (`apps/trade-executor/src/jupiter-jito-runtime.ts:311-342`; `apps/trade-executor/src/polymarket.ts:878-884,986-989`). Lower transport timeouts without this repair increases uncertainty, not safety.
5. **Instrument before optimizing.** Record source observed/occurred, parsed, persisted, eligible, enqueued, dequeued, quote requested/ready, built, simulated, inspected, signed, transport sent/returned, landed and receipt-accounted. Store monotonic durations plus wall-clock event stamps, trace/tenant/intent/cohort rank, mode and route. Existing `submittedAt` starts before actual network submission (`apps/trade-executor/src/index.ts:1761,2277`); do not rename it without preserving historical semantics.
6. **Then remove unnecessary serialized work.** Measure queue age and fan-out rank bias. Use bounded concurrent *enqueueing* after a single atomic cohort reservation; preserve stable per-user identities/policy. Cache reviewed tip metadata within existing bounds and share quote/build/simulation context, but never cache balances or consent as indefinitely fresh. Tip/blockhash requests currently add serial work (`apps/trade-executor/src/jupiter-jito-runtime.ts:282-311`; `apps/trade-executor/src/solana-signer.ts:80`). Do not remove simulation or intent inspection for speed.

## Static latency inventory

| Stage | Source-configured behavior | Evidence |
|---|---|---|
| Signal detection fallback | 15 seconds, alongside immediate pub/sub | `apps/signal-engine/src/index.ts:693-724` |
| Fan-out | Sequential operator-first queue adds | `apps/signal-engine/src/fanout-enqueue.ts:225-255,349-359` |
| Quote/build deadlines | 8 seconds each by default | `packages/shared/src/jupiter.ts:23-25`; `packages/shared/src/jupiter-swap.ts:25` |
| Simulation/Jito deadlines | 5 / 10 seconds by default | `apps/trade-executor/src/solana-simulation.ts:376`; `apps/trade-executor/src/jupiter-jito-config.ts:114` |
| Pending resolution | 10-minute Jito TTL; 60-second reconciliation | `apps/trade-executor/src/jupiter-jito-config.ts:28`; `apps/trade-executor/src/index.ts:2916-2924` |
| PM settlement observation | Up to 30 seconds by default, separate from POST latency | `apps/trade-executor/src/polymarket.ts:910-919` |

These are configuration bounds, not additive estimates. Queue waiting, network/provider behavior and chain inclusion are unmeasured.

## Acceptance gate

Use synthetic offline fixtures and a dedicated localhost validator/fork only after fixing test-isolation constraints (`vitest.integration.config.ts:1-22`; `tests/integration/chaos.integration.test.ts:53-61,343-345`). Assert: no stale/out-of-price signing; two users remain isolated; pending/unknown reservations prevent oversubscription; dropped responses never produce a second rebuilt effect; late cohort ranks do not receive widened tolerance; reducing exits remain recoverable; final receipts update accounting exactly once. Benchmark p50/p95/p99 source-to-land, queue age and master-relative realized deviation under representative bursts before claiming improvement. **All tests and benchmarks NOT RUN.**

Related: [executor review](security-review/07-trade-executor.md), [signal/exit review](security-review/06-signals-scorer.md), [ranked remediation](02-synthesis-and-remediation.md).
