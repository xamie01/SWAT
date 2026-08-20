# ADR-0006 — No EVM MEV protection; the sequencer is the disclosed trust assumption

- **Status:** Accepted
- **Date:** 2026-08-20
- **Scope:** **Robinhood Chain (chain ID 4663) only.** This is a chain-scoped
  decision that happens to cover all of our EVM swap execution today, not a
  general position on EVM MEV.
- **Closes:** `S4-M14`. Supplies the document `RHC-2` (`docs/PRD.md` §Robinhood
  Chain) asks for, and records the reasoning behind `RHC-1`'s "by decision".
- **Expands:** ADR-0005 §7.2 bullet 1, which states this in three lines. Nothing
  here contradicts it.
- **Does not touch:** Solana. The Jito bundle path *is* MEV protection and is
  load-bearing there for exactly the reason it is unnecessary here — Solana has a
  public mempool and Robinhood Chain does not. See `packages/shared/src/jito.ts`
  and `S3-5`. Do not read this ADR as "WAKE does not do MEV protection."

## Context

`S4-M14` was raised as a gap: the executor has front-running protection on Solana
(Jito bundles, never public RPC) and none on the EVM path. Symmetry suggests
something is missing. It is not, and the reason is a property of the chain rather
than a decision we made — which is precisely why it needs writing down. A gap that
is closed by a fact rather than by code gets re-opened by the next reviewer who
notices the asymmetry.

Two scoping facts first.

**Robinhood Chain is our only EVM swap venue.** Polygon is not a swap venue in
this system: every `chain === 'polygon'` branch is Polymarket, and the
`liveTokenSell` predicate in `apps/trade-executor/src/index.ts` (line 1221 at time
of writing) excludes polygon from token sells outright. So "EVM MEV protection"
reduces entirely to Robinhood Chain via Uniswap V3. There is no second EVM venue
whose answer might differ.

> ADR-0005 §7.2 cites this as `index.ts:1189`. That line number has drifted and now
> lands on the auto-execute gate; the predicate itself is unchanged. Cited by symbol
> here so it does not rot again.

**Robinhood Chain runs a single sequencer.** This is the confirmed fact the whole
decision rests on, and it is the only one it rests on.

## §1 There is nothing to front-run

Every generalised EVM MEV attack we would build protection against — sandwiching,
backrunning, generalised frontrunning — requires a **pre-inclusion observation
channel**: some way for a third party to see our transaction after we sign it and
before it is ordered. That channel is the public mempool. Private relays,
encrypted mempools, and order-flow auctions all exist to close it.

A single sequencer means there is no such pool. One party orders transactions and
no third party observes pending ones. The channel we would be paying to close is
already closed by the chain's architecture. Building protection here buys a
property we already have.

## §2 What replaces it: the single sequencer monopolises MEV rather than removing it

This is the part that matters, and stating §1 without it would be misleading.

A single sequencer does not eliminate the extractable value in transaction
ordering. It concentrates the ability to extract it in one party — one with
*complete and exclusive* visibility of pending transactions and unilateral control
over their order and inclusion. Everything a searcher could have done with mempool
visibility, the sequencer can do with strictly better information and no
competition for it.

Three exposures follow. We accept all three and defend against none:

**2.1 Reordering.** Our swap can be placed after a transaction that moves the pool
price against us. Our only bound is the per-user `max_slippage_bps` ceiling
(`packages/db/sql/049_user_execution_settings.sql:89`), which is a **loss limit,
not a protection** — it caps what an adverse ordering costs, and does nothing to
make one less likely.

**2.2 Censorship and delay.** A mirror can be withheld or delayed. Under
single-master mirroring a delayed buy is a worse fill or a skipped one, which is
survivable. A delayed or withheld **sell** is the serious case: the exit is the leg
the user is relying on, and ADR-0005 §7.3 already treats "never leave a user
silently holding a position their master has left" as a hard requirement. On this
chain that requirement is contingent on the sequencer's cooperation, and no amount
of our code changes that.

**2.3 Non-detectability.** From our vantage point an adverse ordering is
indistinguishable from ordinary block composition. We cannot measure this exposure,
so we cannot alert on it, bound it empirically, or report its magnitude to a user.

**This is a chain-level trust assumption, not a vulnerability in our code.** It is
not mitigable at the application layer; the only mitigation is not using the chain.
We do use the chain, so the correct treatment is disclosure — and the honest
content of that disclosure is that a user trading on Robinhood Chain is trusting
the chain operator's ordering, not trusting WAKE's execution code.

## §3 No mempool cuts both ways

The absence of a public mempool also removes *our* in-flight visibility. We cannot
watch our own transaction pend before inclusion the way we could on a
public-mempool chain, and the code already reflects this: a null receipt is
"indistinguishable from 'dropped from the mempool' without the original blockhash
window", so the attempt stays `pending`
(`apps/trade-executor/src/reconciliation-venues.ts:57-64`).

So the confirmation model carries **more** weight here, not less. `RHC-6`'s
three-way confirmation — landed / definitively not / unobserved — is what stands in
for the observability we do not have, and `unobserved` must never be collapsed into
either of the other two states. That is a consequence of this ADR, not an
independent nicety.

## §4 Why this is not the §4.4 generic-message case

ADR-0005 §4.4 says the user-facing message for a capacity limit is generic while
the internal reason code is specific. That rule does not transfer here, and reusing
it would be a mistake.

A capacity limit is ours, temporary, and actively being worked on — "scaling
infrastructure" is true. A chain-level trust assumption is none of those: it is
permanent for as long as the chain is single-sequencer, it is not ours to fix, and
there is no work in progress that will remove it. Disclosing it generically, as
"network conditions", would understate it into meaninglessness.

It belongs in the risk disclosures reviewed under `DG-2` / `D13`
(`S4-1 (ext)`), alongside the fan-out fill-degradation text, and it should **name
the sequencer**. Counsel reviews the wording; this ADR fixes the substance.

## Options considered

**A. Do not trade on Robinhood Chain.** The only option that actually removes the
§2 exposure. Out of scope for this ADR — which chains WAKE supports is a product
decision made elsewhere, and it is listed here only so nobody mistakes §2's "the
only mitigation is not using the chain" for a recommendation smuggled in as an
observation.

**B. Build EVM MEV protection — private submission, bundle-style or via a
protected relay.** Rejected on two independent grounds. First, there is no public
mempool to hide from, so the mechanism has nothing to protect against (§1).
Second, it would require a private-order-flow counterparty on chain 4663; none is
known to exist, and standing one up would route user trades through an **additional**
trusted party in order to defend against a risk that is not present — adding a
trust assumption to remove one that does not exist, and adding a dependency on the
money path. Cost with no corresponding risk reduction.

**C. Tighten slippage and describe it as MEV protection.** Rejected. It conflates
two things: slippage bounds the loss from *any* adverse price movement, ordinary
volatility included, and does nothing to reduce the sequencer's ability to reorder.
Calling it MEV protection would be a false claim of the kind `DG-2`'s disclosure
review exists to catch. Tightening it below what volatility requires also converts
adverse ordering into skipped mirrors, which under mirroring is its own failure
mode rather than a mitigation.

**D. Detect and alert on suspected sequencer reordering.** Rejected for now, on
§2.3: we cannot distinguish adverse ordering from ordinary block composition, so
the alert would be a guess wearing a confidence number. Telemetry that manufactures
certainty is worse than no telemetry. This becomes possible if the chain ever
publishes pre-inclusion ordering commitments, and only then.

**E. Do not build it; document the trust assumption and disclose it.**

## Decision

**Option E.**

No EVM MEV protection is built. The sequencer's ability to reorder, delay, or
withhold transactions is recorded as a chain-level trust assumption, disclosed to
users in the `DG-2`-reviewed risk disclosures, and not engineered around.

`RHC-1`'s ✅ is **conditional**, not permanent: it is correct only while the chain
remains single-sequencer with no public pending-transaction visibility. The
reversal triggers are in §5 and the ADR must be revisited if any of them fires —
without them written down, "no MEV protection needed" is the kind of conclusion
that outlives the fact that justified it.

## §5 What would reverse this decision

Any one of these, and this ADR is reopened:

1. **The chain decentralises sequencing** — a shared or rotating sequencer set, or
   a permissionless proposer market. Ordering stops being one party's discretion,
   third-party MEV becomes possible again, and option B stops being pointless.
2. **The chain exposes pre-inclusion transaction visibility to anyone other than
   the operator** — a public mempool, a pending-transaction feed, or a `pending`-tag
   RPC readable by non-privileged callers. This recreates the observation channel
   §1 relies on being absent.
3. **A private-order-flow or encrypted-mempool facility appears for chain 4663.**
   Then protection has both a purpose and a means.
4. **WAKE adds a second EVM swap venue on a chain with a public mempool.** The most
   likely of the four. This decision is chain-scoped, and a new venue must be given
   its own answer rather than inheriting this one — the metadata block at the top of
   this file says "Robinhood Chain only" for this reason.

## Consequences

**The `RHC-2` documentation obligation is met by this file, but the disclosure copy
is a separate deliverable.** This ADR fixes what must be said; the user-facing
wording is drafted and reviewed with the rest of the risk disclosures under
`S4-1 (ext)` / `DG-2`. `RHC-2` is not closed until that copy exists.

**`RHC-6` gains weight.** Three-way confirmation with an honest `unobserved` state
is the compensating control for §3's lost in-flight visibility. It should be
treated as such in review rather than as one item among six.

**Exit reliability on this chain has a ceiling we do not set.** §2.2 means the
mirroring promise on the sell leg is contingent on the sequencer. Anything that
makes exits more robust — escalation, retries, alerting on a failed exit
(ADR-0005 §7.3) — is still worth building, but it should not be described
internally or externally as removing this exposure. It bounds our own failures,
not the chain's.

**No code changes.** This ADR asserts nothing about the executor's behaviour that
is not already true. If implementing it seems to require a code change, that is a
signal the change belongs to `RHC-3`–`RHC-6`, not here.

## §6 What this ADR has not verified

Stated plainly so the unverified parts are not read as established.

**Confirmed.** Robinhood Chain runs a single sequencer (ADR-0005 §7.2,
`docs/PRD.md` `RHC-1`). Chain ID 4663; EVM; ERC-4337 EntryPoints v0.6/v0.7/v0.8 and
EIP-7702 supported, Alchemy bundler/paymaster — verified against
`docs.robinhood.com/chain/account-abstraction/` in ADR-0003 §2.

**Not verified, and not assumed either way:**

- **The rollup stack, and whether an L1 force-inclusion or escape-hatch path
  exists.** ADR-0003 §2 mentions Arbitrum Orbit L3s only as a comparison and does
  not state this chain's stack. This matters: a force-inclusion path would bound
  §2.2 to a *delay* rather than an indefinite withholding, which is materially
  better and worth knowing before the disclosure copy is written.
- **Whether the sequencer publishes or is contractually bound to any ordering
  policy** (FCFS, no self-preferencing, censorship-resistance commitment).
- **Whether pending-transaction visibility exists for any party other than the
  operator**, including via the documented Alchemy endpoint. §1 assumes not, on the
  basis of the single sequencer; it has not been probed directly.
- **Reorg and finality semantics**, and therefore whether a confirmation reported as
  `landed` can later be un-landed.

The **decision** does not depend on any of these — it follows from the single
sequencer alone, and each of the four would at most sharpen §2 or add a reversal
trigger. What they do affect is how §4's disclosure is worded and how `RHC-6` is
built. Treat them as open verification items owned by whoever writes the disclosure
copy, not as assumptions this ADR rests on.

## Follow-on tasks

- Risk-disclosure copy naming the sequencer trust assumption — `S4-1 (ext)`,
  reviewed with `DG-2`. Closes `RHC-2`.
- `RHC-6` three-way confirmation, with `unobserved` never collapsed.
- The four §6 verification items, before that copy is finalised.
