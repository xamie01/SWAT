# WAKE — Execution Authority Design Decisions
**Companion to ADR-0003 (Delegated Execution Authority) and AUDIT-FIX-CHECKLIST.md §7.1**
Date: 2026-08-11 · Status: Decided (pending implementation) unless marked Open

This report closes out the open decision points flagged in ADR-0003 and the
S4-P10/P12/P15/P16 checklist items, plus the Jito tip-handling gaps identified
during design review. Each item below states the decision, the reasoning
behind it, and what's still open.

---

## 1. DG-9 — Polymarket custody while a user is offline

**Decision: Fork (b) — hold the key, scoped and disclosed.**

WAKE will hold an encrypted copy of each user's Polymarket signer key, scoped
*only* to their Polymarket wallet — never their Solana or EVM funds. This is
custodial for that one venue, by necessity: Polymarket requires a signature
from the user's own key for every order, and there is no restricted or
delegated version of that key available. The alternative (fork a, defer live
execution) was rejected in favor of keeping copy-trading functional on this
venue.

**Required before this ships:** an explicit consent/disclosure step at
Polymarket-wallet setup, stating plainly that WAKE holds this key and what
that means if WAKE is compromised. This is a UX/legal deliverable, not an
engineering one — copy should be reviewed alongside DG-2.

**Open:** DG-2's underlying legal question (money-transmitter exposure from
holding user funds, even venue-scoped) has not been reviewed by counsel. This
decision assumes that review clears it; if it doesn't, DG-9 needs revisiting.

---

## 2. DG-3 / S4-P10 — EVM session-key permission policy

**Decision: Use a vendor for wallet infrastructure; build the permission
check ourselves regardless of what the vendor claims to support.**

Vendors (Privy, Alchemy, ZeroDev) will be evaluated and used for wallet
creation, UX, and bundler/paymaster infrastructure. But the assumption going
in is that none of them restrict `approve` calls by *spender address* — only
by function name — which is the actual security-critical check (a session
key scoped to "may call `approve`" can still approve an attacker's address
directly, bypassing any router-level restriction). WAKE will build and own
this argument-level check as a policy layer sitting in front of signing,
independent of vendor answers.

**Open:** which vendor, and the exact schema for the policy layer (target
contract + function selector + allowed argument values per delegation). This
is the natural fit for the planned `047_user_execution_grants` migration's
`scope_policy` column — not yet designed in detail.

---

## 3. S4-P12 — Solana delegated execution (non-custodial vault)

**Decision: Build a custom Anchor program**, using a program-owned vault
account (Program Derived Address) per user rather than any form of held key
or session key. Key properties, as designed:

- **No private key exists for the vault** — it's a PDA, mathematically
  keyless. There's nothing to steal or store.
- **`execute_swap`** is signed by WAKE's operator key, but that key only
  authenticates the request. The instruction independently checks that the
  swap's source and destination token accounts both belong to the vault
  itself, and that the CPI target is the verified Jupiter program ID — so a
  compromised operator key can trigger swaps but cannot redirect funds
  anywhere else.
- **`withdraw`** requires the *original depositor's own signature* —
  never the operator's. This is the actual kill switch: even a fully
  compromised WAKE backend cannot move funds out arbitrarily.
- **`revoke_executor`** is an immediate, user-signed, on-chain kill switch —
  not a database flag WAKE promises to honor.
- **Vault `owner` is set once, at `initialize_vault`, and is permanent.**
  Decision confirmed: no recovery path if a user loses access to their
  wallet — same trade-off as any self-custody product. This was deliberate,
  not an oversight: an editable owner field would reintroduce the exact
  attack surface (redirect withdrawals) the design exists to remove.

A design skeleton (`wake-vault-skeleton.rs`) was produced covering the vault,
config, and swap-forwarding logic. It is a scaffold, not deployable code —
Jupiter's program ID and CPI account shape still need verification against
current docs before any devnet work begins.

**Open / next steps, in order:**
1. Quick sanity check on whether Squads V4 already covers this (low-cost,
   worth doing before committing engineering time, even though it isn't
   blocking anything today).
2. Formalize the spec above into an ADR-0004-style document before writing
   real Rust.
3. Budget audit lead time (multiple weeks, real cost) the same way Polymarket
   Verified status is budgeted — not something scheduled after the build is
   "basically done."

---

## 4. S4-P16 — Geo-eligibility staleness

**Decision: 7-day staleness window.**

A user's location is checked at signup and re-verified whenever they log in.
If more than 7 days pass without a fresh, verified login, WAKE stops
automated Polymarket execution for that account until they return and
re-verify. This closes the gap where the compliance check was reading WAKE's
server location instead of the user's.

**Open:** this is implemented as a policy default, not yet reviewed by
counsel as part of DG-2. Treat 7 days as provisional until that review
happens.

---

## 5. S4-P15 — Polymarket relayer capacity

**Decision: alert and skip, no queuing.**

When the platform is at or near the daily relayer cap, trades that can't be
placed are **skipped with a logged reason** and the operator is alerted —
they are not deferred to the next day. This was a deliberate change from an
earlier "queue for tomorrow" answer: a queued trade executing a day later is
no longer actually copying the signal it was meant to copy — the tracked
wallet's position may have already changed, so a late fill risks acting on a
stale signal rather than the one it was supposed to mirror. Skip-and-alert
avoids that failure mode entirely.

**Decision: file for Verified relayer status once the platform hits the
100/day Unverified cap with sustained contention for 2 consecutive weeks.**
This will be tracked as a metric (consecutive days at cap with skipped
trades), not as an actual trade queue — purely to build a concrete usage
record to present to Polymarket's Builder team when applying.

**Open:** the specific metric/dashboard for "days at cap" doesn't exist yet
and needs to be built alongside the skip-and-alert logic — it's the trigger
for the 2-week filing decision, so it needs to exist before that clock can
start.

---

## 6. Jito tip handling (Solana, per-user execution)

Five separate issues, each addressed:

**Tip-as-attack-surface (paying tips means sending SOL to an address).**
Bounded by design: `pay_jito_tip` in the vault program enforces both a
per-call cap (`max_tip_lamports`) and an allowlist (`tip_accounts`), both
read from the shared `WakeConfig` account. Worst case on a compromised
operator key: tip-sized drains to Jito's own validators, capped per call —
vandalism, not theft, but still worth the cap.

**Hardcoded allowlist as a liveness risk.**
Resolved structurally: the allowlist lives in `WakeConfig`, a single
admin-updatable account, not baked into each user's vault grant. Rotating
Jito's tip addresses becomes one config update instead of a
re-consent flow for every user. **This same fix should be applied today,
independent of the Solana vault timeline** — `JITO_TIP_ACCOUNTS` in
`packages/shared/src/jito.ts` is currently a hardcoded constant and has the
identical liveness problem right now, for the single-operator path.

**Per-user SOL minimum: calculated per user**, based on their position size
and expected trade frequency — not a flat platform-wide number, and not left
to the user to self-determine. Checked at onboarding and before each trade,
with a clear "add SOL" error rather than a generic execution failure.

**Open:** the actual formula (how position size and trade frequency map to a
SOL minimum) hasn't been specified yet — this needs a first pass before it
can be implemented.

**Tip fairness: hybrid — platform sets a floor, users can add more on top.**
This avoids the worst version of pay-to-win (nobody can buy their way below
the floor), but it's worth being direct about the trade-off: users who choose
to add more than the floor will still get systematically better inclusion
odds than users who don't, on the same signal, inside the same product. The
original recommendation was a strict uniform tip specifically to avoid this.
The hybrid is a reasonable middle ground, but it's a deliberate reopening of
a smaller version of the same fairness question — worth revisiting if it
becomes a visible complaint once real users are on Solana.

**Tips must enter P&L.** Not a preference decision — a fix. `tipLamports` is
already computed in `jupiter-jito-runtime.ts` but discarded; `persistTrade()`
already has an unused `feeUsd` parameter for exactly this. The fix is to
thread the lamport amount through `JupiterJitoResolution`, convert it to USD,
and pass it into the existing parameter — only when a bundle actually lands,
since atomic bundles mean a missed trade is never charged a tip.

---

## Summary table

| ID | Item | Decision |
|---|---|---|
| DG-9 | Polymarket custody | Hold key, scoped + disclosed |
| DG-3 / S4-P10 | EVM permission policy | Vendor for infra, build spender-check ourselves |
| S4-P12 | Solana delegation | Custom Anchor vault, immutable owner, no recovery path |
| S4-P16 | Geo staleness | 7-day window since last verified login |
| S4-P15 | Relayer cap behavior | Alert + skip, no queuing |
| S4-P15 | Verified filing trigger | 100/day cap + 2 weeks sustained contention |
| Jito #1 | Tip attack surface | Capped + allowlisted in vault program |
| Jito #2 | Allowlist liveness | Central config, not baked into grants (fix now in `jito.ts` too) |
| Jito #3 | Per-user SOL minimum | Calculated per user (formula: open) |
| Jito #4 | Tip fairness | Hybrid floor + optional user boost (residual pay-to-win noted) |
| Jito #5 | Tip P&L accounting | Thread into existing `feeUsd` param, only on landed bundles |

## Open items carried forward

- DG-2 legal review (money-transmitter exposure, staleness-window sign-off) — not yet done, gates DG-9 and S4-P16.
- Squads V4 evaluation for S4-P12 — not yet done, do before committing to custom-program build.
- Vendor selection for DG-3 (Privy vs Alchemy vs ZeroDev).
- `047_user_execution_grants.scope_policy` schema design.
- Per-user SOL minimum formula.
- "Days at cap" metric/dashboard build for the Verified filing trigger.
- Audit vendor + timeline for the Solana vault program.
