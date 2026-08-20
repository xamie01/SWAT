# Testing Aspects — External Evidence Required

**Purpose:** This file tracks every checklist item marked `(ext)` — tasks that need funded wallets, production credentials, live canaries with real money, operator review, or human sign-off. The code supporting these aspects is built first; this file documents what remains to prove they work under real conditions.

**How to use:** When a testing aspect is satisfied (canary run, credential verified, sample reviewed, certification doc signed off), mark it `[x]` here **and** in `AUDIT-FIX-CHECKLIST.md`. Both must agree.

---

## Stage 3 — Venue Executors & Certification

### Solana (Retargeted to Jupiter + Jito)
- [ ] **S3-9** `G1-S1` — Measure webhook→signal→alert→execution latency over a real review window; hold Solana median signal-to-alert under 60 seconds. Requires live webhooks flowing and operator analysis of the timing distribution.

- [ ] **S3-9** Capped live canary recorded under `docs/certification/solana.md`. A tiny trade with real funds on the Jupiter+Jito path, demonstrating idempotency, truthful failure states, and chain-confirmed amounts. The certification doc exists but is correctly marked **NOT CERTIFIED** with every box unchecked; this item closes when the operator fills and signs it.

### Robinhood Chain
- [ ] **S3-13** `G2-R3` — Direction-classification accuracy **>95%** on an operator-reviewed production sample. Requires a sample of real Robinhood transactions with ground-truth labels (buy/sell) and the scorer's classifications compared.

- [ ] **S3-14** `G2-R4` — Ingestion completeness **>90%** on the certification sample. Requires defining a reference set of Robinhood blocks/transactions and measuring how many the indexer captured.

- [ ] **S3-16** `G2-R12` — Three real scenarios on Robinhood: a tiny successful buy with receipt-derived amounts, a forced failure with the claim correctly released (never wedged), and an orphaned receipt resolved after a restart (the sweeper's job). Requires funded wallet and live RPC access.

- [ ] **S3-17** `G2-R13` — Write and have reviewed `docs/certification/robinhood-chain.md`; only then add `robinhood-chain` to `LIVE_ENABLED_CHAINS`. **See S0-B1 — it is currently listed there without this gate, which is a config violation that must be corrected.** The file's existence and the review are both required; neither alone is sufficient.

### Polygon / Polymarket
- [ ] **S3-21** `G3-P3` — Authenticated production round trip to Polymarket: fetch positions, place an order (unfillable or immediately cancelled), verify no API keys or secrets logged. Requires Polymarket credentials and live API access.

- [ ] **S3-22** `G3-P5` — Operator account, jurisdiction, Polymarket venue terms, and wallet funding eligibility confirmed. A legal/compliance checklist that a human must verify and document.

- [ ] **S3-23** `G3-P11` — Three Polymarket scenarios: a tiny filled BUY, an unfillable order cancelling cleanly, and a duplicate order rejection. Requires funded wallet, live API, and real market conditions.

- [ ] **S3-24** `G3-P12` — `docs/certification/polygon-polymarket.md` reviewed and signed off. The file exists and is correctly marked **NOT CERTIFIED** with every box unchecked. This closes when the operator completes and signs the review.

### Cross-Chain Acceptance
- [ ] **S3-26** `F-ACC1` / `F-ACC2` — Simultaneous three-chain production-worker replay: prove one venue's RPC outage neither stalls nor corrupts the others. Requires live workers on Solana, Robinhood, and Polymarket with one deliberately degraded, and observation that the other two continue correctly.

- [ ] **S3-27** `F-ACC3` — Verify production prerequisites in the actual deployment environment: Postgres connectable, Redis reachable, Helius/Robinhood/Polymarket credentials valid, funded wallets provisioned. This is an ops runbook verification, not a code task.

---

## Stage 4 — Custody, Risk, Per-User Execution

### Legal and Compliance Gate — **Non-Negotiable**
- [ ] **S4-1** **`DG-2` / `D13`** — **Legal opinion on custodial funds and autonomous trading in the operating jurisdiction.** Counsel must review and approve. ToS and risk disclosures must be published. Cloudflare geo-blocks must be live. A stricter per-user Polymarket geo-gate inheriting venue restrictions must be in place.

  **Custody does not launch without this.** No code workaround exists. This is the single hardest gate in the plan and the only one that can block Stage 4 indefinitely regardless of code readiness.

---

## Stage 5 — Billing (Stripe)

*(Stage 5 has no `(ext)` items — Stripe test mode can close every task on the checklist. Real subscriptions and USDC lifetime purchases are a Stage 6 production concern, not a build gate.)*

---

## Stage 6 — Frontend Rebuild

*(Stage 6 has no `(ext)` items marked in the current checklist. The rebuild itself must be tested by a real user in a browser, but that is ordinary QA, not a compliance gate or a credential/funding requirement. If specific browser testing or device compatibility becomes a formal gate, add it here.)*

---

## Stage 7 — Custom Chains (Ultra Tier)

*(Stage 7 tasks are pull-based and Ultra-tier-only. External evidence will be required when an Ultra user adds a custom chain — RPC reachability, contract ABI verification, test transactions — but those are per-chain and on-demand, not build gates. Document them here when the feature ships and a testing protocol is defined.)*

---

## How This File Evolves

- **During build:** code supporting each `(ext)` item is written and unit/integration-tested against mocks, test fixtures, or paper mode. The code works; what remains is proving it works under real conditions.
- **During verification:** an operator or reviewer completes the external evidence (runs the canary, reviews the sample, signs the cert doc, confirms the credential) and marks the item `[x]` here **and** in the checklist.
- **At stage completion:** every `(ext)` item for that stage must be `[x]` here before the stage's exit gate is considered met. An unchecked external-evidence item is an open gate regardless of how green the code is.

**Principle:** Code can be correct in every test and still fail the first time real money touches it. This file is the reminder that correctness is necessary but not sufficient — the system must also be *proven* correct under the conditions it will actually face.
