# Previous architectural findings — disposition and closure plan

Date: 2026-11-06. Source: the preceding authorized architectural review in this conversation, rechecked by the current module reports. No exploitation or live transaction was performed. **These are findings and proposed fixes, not fixes already applied.**

## Incorrect or unverified premises

1. **Per-user Solana vault execution is not established by having an Anchor program.** The adapter factory defaults user authority to the operator signer (`apps/trade-executor/src/execution-authority-adapters.ts:604-618`), production wiring supplies no user-vault resolver (`apps/trade-executor/src/index.ts:1125-1161`), and the runtime builds ordinary Jupiter swaps (`apps/trade-executor/src/jupiter-jito-runtime.ts:238-245`). Current module 07 owns revalidation. A live user-PDA debit or deployed bypass was **NOT VERIFIED**.
2. **CLOB L2 credentials are not order-signing authority.** Stored registration payload is an API credential tuple (`apps/api/src/routes/me.ts:617-622`); operator CLOB initialization separately binds wallet signer/funder (`apps/trade-executor/src/polymarket.ts:305-358`). Theft of L2 credentials alone does not establish a wallet-float drain. User Polygon authority is denied (`apps/trade-executor/src/execution-authority-adapters.ts:585-593`).
3. **User ERC-4337/EIP-7702 execution is not an implemented protection in this checkout.** The user Robinhood adapter denies authority (`apps/trade-executor/src/execution-authority-adapters.ts:462-467`). External chain support/contract deployment assertions are **NOT VERIFIED**.
4. **Live configuration is gated, not assumed.** Both operator enablement and evidence certification are required (`packages/db/src/execution-config.ts:120-159`). Polygon's evidence document is NOT CERTIFIED (`docs/certification/polygon-polymarket.md:2-4,50-52`). Runtime settings and external audit sign-off are **NOT VERIFIED**.
5. **Privacy and ordering are different properties.** Single-sequencer assertions and 'no exposure' wording are in `docs/adr/0006-robinhood-sequencer-trust.md:41-63,218-231`; the document itself records unprobed pending visibility. Private follower submission cannot hide the public master trade and deterministic fan-out (`apps/signal-engine/src/fanout-enqueue.ts:204-255`). No independently observed sequencer abuse is alleged.
6. **Owner-role RLS bypass is not a proven tenant exploit on its own.** Configured owner identity, live role privileges and remote database behavior are **NOT VERIFIED**; module 02 distinguishes schema policy/caller evidence from deployment assumptions.

## OLD-01 — predictable copy flow and adverse selection

**Severity: High. Confidence: Likely (economic magnitude requires isolated market testing).** The code path exposing correlated flow is verified; profitability for a specific adversary is not.

Evidence: source notifications/polling `apps/signal-engine/src/index.ts:693-723`; ordered fan-out `apps/signal-engine/src/fanout-enqueue.ts:204-255`; TVL-based usable-liquidity estimate `packages/db/src/master-capacity.ts:174-198`; fill accrual warns on undercount `apps/trade-executor/src/index.ts:1318-1338`.

### Abuse, at most three conceptual steps
1. Observe a genuine master's public trade before the follower cohort has finished.
2. Infer future directional demand from historical copy timing/volume.
3. Adjust market liquidity/inventory so followers incur adverse fills or misses while transactions remain locally valid.

### Step-by-step fixes
1. In `packages/db/src/master-capacity.ts`, add an atomic pre-enqueue reservation for projected aggregate notional keyed to master/asset/window plus canonical execution identity. Include operator flow. Retain reservations through unknown submission states; release only on definitive failure or reconciled consumption.
2. In `apps/signal-engine/src/capacity-inputs.ts`, separate incomplete balance evidence from a valid zero balance; new entries must not treat unknown aggregate risk as zero. Use executable route/tick depth with observation timestamp rather than TVL alone. Check caller behavior for uniform cohort skip and avoid dropping necessary exits (`apps/signal-engine/src/capacity-inputs.ts:331-332`).
3. In fan-out and worker admission, derive an immutable maximum mode/price/slippage/age intent. Revalidation can narrow it, never increase permitted risk.
4. In the execution pre-sign boundary, compare current execution against a bounded master-relative price and fresh source timestamp. A new quote is not proof that the master's intent remains economically valid.
5. Introduce per-stage monotonic timing and cohort rank. Evaluate p50/p95/p99 source-to-land and tracking deviation before any latency claim. Production measurements are **NOT VERIFIED**.

### Acceptance tests
On a localhost AMM fork with synthetic assets/keys, interleave one master event, a cohort, delayed quotes and controlled price movement. Assert reservations never exceed the executable-depth budget, unknown outcomes keep capacity reserved, and late/out-of-bound copies cannot sign. For exits assert impact controls escalate safely rather than silently abandoning holdings. Tests **NOT RUN**.

### Impact/detection
Approximate follower execution loss is `sum(notional × adverse benchmark deviation) + fees`; this is not identical to adversary profit. Detect cohort-rank deterioration, source-to-land tails, capacity undercount, stale depth and reserved/realized divergence. Current closure: **open; module 06/07 own implementation evidence**.

## OLD-02 — compromised global trading authority and economic value bounds

**Severity: High. Confidence: Verified for caller-selected vault policy.** Severity is downgraded from the earlier conditional Critical rating because substantial live multi-vault deployment and reachable funds are **NOT VERIFIED**. Module 04 CHAIN-01 is the current authoritative disposition.

Evidence: arguments `programs/wake-vault/src/lib.rs:235-239`; zero `min_out` rejection `:251-252`; global executor constraint `:465-469`; selected account authority `:471-480`; minimal vault state `:506-515`; delta invariants `:569-580`. Output ownership, side-account restrictions and native-lamport preservation are genuine constraints (`:254-288,323-329`).

### Abuse
1. Obtain the already-authorized hot trading key.
2. Choose economically poor but permitted swaps/limits against assets within reachable authority.
3. Repeat before independently enforced budgets/revocation stop execution.

Actual operator-key custody is distinct from conditional intended-PDA economic exposure. Neither ownership-preserving swaps nor hot-key exposure proves an unauthorized withdrawal from a deployed user vault.

### Step-by-step fixes
1. Expand owner-approved vault policy to include allowed input/output assets/programs, expiry, per-trade maximum and cumulative epoch spend. Do not let the executor authenticate its own limit.
2. Enforce nonce/replay and policy checks in the handler before CPI. Policy change requires owner authorization; global executor rotation must not reset user budgets or widen scope.
3. Bind a separately authorized execution intent to vault identity, assets, limits, expiry and nonce. Use independent reference/approval logic appropriate to the traded market; the executor cannot invent an apparently 'fair' quote itself.
4. Separate upgrade/admin emergency authority from hot execution authority. An Anchor `Signer` is not intrinsically a multisig (`programs/wake-vault/src/lib.rs:358-366`); actual multisig deployment is **NOT VERIFIED**.
5. Move operator and future venue signer capability into a separate policy-enforcing signing service. An HSM/KMS that blindly signs still authorizes bad trades. Preserve owner withdrawal/revoke access independent of service availability.
6. Bind sealed secrets to full grant identity, not merely broad chain kind, and define rotation/revocation for future custodial signer keys (module 03). Do not misdescribe L2 credential rotation as signer-key revocation.

### Acceptance tests
Local validator using real handlers: zero output remains rejected; adverse nonzero output cannot bypass owner policy; spend accumulates across repeated swaps; rotation does not reset limits; expiry/revoke fails on-chain; output and extra-account restrictions continue to hold. Tests **NOT RUN**.

### Impact/detection
`operator hot balance + sum(exposed vault value × traded fraction × economic haircut)` bounds the modeled loss, subject to actual reachable funds/routes. Alert on cross-vault bursts, unusual mints/minimum-output ratios and policy-rejection spikes. Current closure: **open; module 03/04/07 separate implemented and planned authority**.

## OLD-03 — tenant execution and actual signer/contract mismatch

**Severity: High. Confidence: Verified for static production wiring.** The earlier conditional Critical rating is downgraded: live funding and downstream acceptance of synthetic settlement addresses are **NOT VERIFIED**. Modules 03/07 retain the authority-isolation defect without alleging a demonstrated user-PDA debit.

Evidence: factory `apps/trade-executor/src/index.ts:1125-1161`; synthetic settlement/operator signer `apps/trade-executor/src/execution-authority-adapters.ts:546-567,604-618`; fresh global mode resolution `apps/trade-executor/src/index.ts:1462-1470`; dispatch `:1782-1795`; ordinary Jupiter build/sign `apps/trade-executor/src/jupiter-jito-runtime.ts:238-245,297-325`.

### Abuse
1. A user-labelled copy intent enters the queue.
2. Worker/adapters resolve operator signing capability rather than a real owner vault/grant and may widen earlier admission.
3. Operator assets fund execution while records name a user settlement target.

### Step-by-step fixes
1. Make user Solana authority deny by default until canonical on-chain PDA ownership, execution-grant state and correct settlement are resolved. Delete synthetic address and operator signer fallback, not merely hide it behind a feature flag.
2. Separate operator and user execution entrypoints/types. An operator authority cannot satisfy a user principal; no `null`/missing user value may silently change principal.
3. Construct the actual vault instruction and pass only approved CPI accounts/data. Invoke the selected authority path, not a global runtime ignoring the grant.
4. Make queued mode/subscription scope immutable upper bounds; immediately re-read grant revocation, settings and subscription state before signing.
5. Validate full transaction intent, including lookup-table addresses, mints, destination, authorities, executable programs, spend, expiry and fees before any signature. Simulation is not an intent authorization substitute.
6. Reconcile actual debited/credited accounts before applying tenant/lot accounting. A claimed settlement string is not chain evidence.

### Acceptance tests
Two tenants plus separately funded operator on local validator: missing/revoked grants deny; tenant A cannot debit operator/B; queued paper remains paper after global live switch; lookup substitution denies; chain settlement and accounting agree. Exercise production factory/dispatch, not only an isolated safe adapter. Tests **NOT RUN**.

### Impact/detection
Operator losses and misattributed fills can undermine all risk/accounting controls. Alert on signer/principal/source-account/settlement divergence. Current closure: **open; primary live user-execution blocker in module 07**.

## OLD-04 — balance changes do not prove intentional swaps

**Severity: High. Confidence: Verified parser weakness; end-to-end poisoning impact Likely.**

Evidence: raw delta selection `apps/indexer/src/parse.ts:138-209,234-260`; enhanced event conversion `apps/indexer/src/webhook-helpers.ts:74-134`; routability error acceptance `apps/signal-engine/src/routability-probe.ts:127-159`; token safety warning/block distinctions `apps/signal-engine/src/safety.ts:177-206,225-272`.

### Abuse
1. Cause an accepted ambiguous balance-change pattern or submit untrustworthy provider evidence.
2. Parser treats it as master trading intent despite absent swap/signer provenance.
3. Downstream gates accept the interpretation and produce unwanted entry/reduction.

Not every transfer satisfies quote, source, liquidity and execution gates. No unrestricted 'airdrop drains followers' assertion is made.

### Step-by-step fixes
1. Preserve actual transaction status, signer/fee payer, instructions, event type and canonical slot/block in ingestion; do not synthesize master fee payment.
2. Verify successful protocol-aware swap evidence and master authorization/participation before interpreting side/amount.
3. Reject ambiguous multiple legs; never choose among unrelated assets using raw units with different decimal scales.
4. Distinguish transfers, rent, LP/staking/wrapping and unsupported token extensions. Require actual sellability/control checks for entries rather than warnings that become permission.
5. Fail closed for unknown routability/safety on new entries; isolate bad events within a batch while preserving retry/idempotency for valid events.
6. Independently verify finality/rollback and canonical immutable event identity. Provider header authentication does not prove chain success/finality.

### Acceptance tests
Fixtures for failed tx, airdrop/transfer, third-party fee payment, rent, multi-leg route, mutable restrictions and conflicting provider payloads. Assert non-swaps/ambiguous evidence create no executable intent, source identity remains stable across feeds, and retries never duplicate exposure. Tests **NOT RUN**.

### Impact/detection
Wrong exposure loss is `sum(unintended notional × (1 − recoverable fraction)) + churn fees`; monitor ambiguity/probe errors, master/issuer links, conflicting finality and master-vs-follower profit divergence. Current closure: **open; module 05/06 own gates**.

## OLD-05 — treasury receipt can be claimed by the wrong tenant

**Severity: High for billing integrity, not custody loss. Confidence: Verified static endpoint/ledger path.**

Evidence: optional memo `apps/api/src/routes/billing.ts:273-286`; conditional memo-owner validation `:377-387`; verification credited to caller `:392-418`; Solana memo parameter not parsed `:159-225`; atomic entitlement write `packages/db/src/billing.ts:149-225`; global transaction uniqueness `packages/db/sql/063_crypto_billing.sql:31-34`.

### Abuse
1. Observe an uncredited qualifying public treasury payment.
2. Claim it under another authenticated tenant without a bound invoice reference.
3. First credit grants that tenant entitlement; global duplicate rejection later blocks the purchaser.

### Step-by-step fixes
1. Require a pending, unexpired invoice owned by the session and fixed to plan/chain/token/amount and unique payment reference. Omitted/unknown/expired intent must fail before verification or credit.
2. Prove the reference on-chain: exact memo on Solana or invoice-specific receiver/payment-contract event on EVM. A third-party payer may be valid when invoice binding is explicit.
3. Decode exact transfer/event semantics: token/program, event signature, recipient, amount, success and required finality. Public RPC failover is availability, not independent truth.
4. Canonicalize EVM transaction hashes once at input/ledger boundaries. Migrate case variants cautiously, reporting collisions rather than silently merging entitlements. Solana signatures are case-sensitive and must not be lowercased.
5. In one transaction lock/consume invoice, insert canonical payment identity and grant intended entitlement. Check caller and sweep races preserve correct tier/expiry without stale downgrade.
6. Return stable rightful-owner status without leaking invoice/user data to other claimants.

### Acceptance tests
Two tenants, one payment, simultaneous claims; absent/unknown/expired/wrong-plan intent; uppercase/lowercase EVM identity; partial/multiple transfers; reorged receipt; sweeper concurrent extension. Assert rightful invoice credited exactly once and no tier unlocked on incomplete/unbound evidence. Tests **NOT RUN**.

### Impact/detection
`stolen entitlement value + refund/support cost + unpaid service usage`; not a treasury debit. Alert on missing invoices, competing claimants and canonical identity collisions. Current closure: **open; module 01/02 own remediation**.

## Previous most dangerous compound risk

**OLD-02 + OLD-03:** a compromised operator signer with user-labelled accounting bypasses the intended per-owner authority boundary. Breaking fix: remove user/operator fallback, require actual independently enforced contract/grant policy in every signed operation, and reconcile real source/destination accounts before ledger application. Keep live user paths denied until those invariants are tested; this is a remediation recommendation, not a configuration change performed by this review.

## How to use this document

The current module reports are authoritative for new evidence, severity corrections and additional findings. Their detailed fix procedures are consolidated in `02-synthesis-and-remediation.md`. Closure requires code changes, safe local regression results and separately obtained deployment/certification evidence; a report, feature flag assertion or unit fixture does not close a financial boundary.
