# ADR-0003 — Scoped delegated authority, not master-key custody

- **Status:** Accepted (direction), with one open fork — see §6
- **Date:** 2026-08-09
- **Supersedes:** `docs/adr/0002-custody-key-store.md` **for user private keys only.** ADR-0002 survives, narrowed, for the operator keys and the SOPS age key — see §7.
- **Replaces:** `docs/plans/stage-4-design.md` §3–§4 (envelope-encrypted user private keys)
- **Rewrites:** `S4-3`, `S4-4`, `S4-P5`, `S4-P6`, `S4-18`

## Decision

WAKE never holds, wraps, or decrypts a user's root private key. Users grant
**scoped, revocable, expiring** authority to execute a narrow class of actions on
their behalf. Every chain enforces the scope at the protocol or contract layer, not
in our application code.

The property we are buying: *a total compromise of WAKE's infrastructure lets an
attacker make bad trades, not steal balances.* That is a bounded loss with a
recovery story, versus an unbounded one without.

Two consequences that are not security theatre:

- **No honeypot.** ADR-0002 accepted that root on the executor host loses every
  custodied key permanently, offline, after eviction. There is no such artefact now.
- **Licensing posture.** Never holding the means to move user funds is the fact that
  most directly bears on money-transmitter / VASP analysis. This ADR does not
  constitute legal advice and does not close `DG-2`; it changes the facts that
  opinion will be written about.

## §1 The cost model is the inverse of the intuitive one

The three legs were scoped on the assumption that Polymarket was cheapest (just
pass API credentials) and Solana was moderate (native delegation). Both are wrong.
Verified ordering, cheapest first:

| Leg | Mechanism | Cost | Blocking dependency |
| --- | --- | --- | --- |
| **Robinhood Chain** | ERC-4337 session key / EIP-7702 delegation | **Low** | none — infra exists today |
| **Solana** | custom Anchor program | **High** | our own program + audit |
| **Polymarket** | *unsolved* | **Unknown** | see §4 |

## §2 Robinhood Chain — infrastructure exists, build here first

Verified against `docs.robinhood.com/chain/account-abstraction/` (chain ID **4663**):

- **EntryPoint v0.6.0** `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`
- **EntryPoint v0.7.0** `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
- **EntryPoint v0.8.0** `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`
- **Safe 4337 Module v0.3.0** `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` (pairs with v0.7.0)
- Bundler + paymaster: Alchemy (`robinhood-mainnet.g.alchemy.com`), ZeroDev as
  documented alternative (Kernel v3.1, `rpc.zerodev.app/api/v3/…/chain/4663`)
- **EIP-7702 is supported.**

This removes the risk that mattered most. An Arbitrum Orbit L3 is *not* guaranteed
to have an EntryPoint, a bundler, or a paymaster; running our own bundler would
have been weeks of ops. All three are provided.

**EIP-7702 is preferable to a fresh 4337 smart account** for our shape: it lets a
user's *existing* EOA delegate to contract code, so they keep their address and
their existing token balances and approvals. A new 4337 account would require
users to move funds into a new address before copy-trading could begin — an
onboarding step with a real drop-off cost, and one that looks exactly like the
deposit flow we are trying not to need.

Pin the EntryPoint version explicitly in config. Paymaster interfaces and gas
accounting differ across v0.6/v0.7/v0.8, and three are deployed simultaneously.

### §2.1 The `approve` hole — the subtle part

A session key scoped to "the Uniswap router, swap selectors only" is **not** yet
safe. Any ERC-20 swap requires `approve(spender, amount)` on the *token*, so the
policy must permit `approve`. If `approve` is permitted with an unconstrained
`spender`, the session key can approve an attacker and the attacker drains the
token directly — never touching the router, never calling a swap function.

The permission policy must therefore constrain **`(target, selector, decoded
argument)** triples, not `(target, selector)` pairs:

- `approve` — only where `spender` ∈ {allowlisted routers}, and with a bounded
  amount, never `type(uint256).max`
- swap selectors — only where the recipient argument is the user's own account

This is also the reason "no `transfer` / no `withdraw`" is an incomplete
specification of the scope. Write the policy as an allowlist of argument-checked
calls; anything not explicitly permitted is denied.

## §3 Solana — no off-the-shelf primitive does this

Two candidate shortcuts fail:

- **Native SPL `approve` / delegate.** A delegate may transfer the approved amount
  to **any** destination. It bounds *how much*, never *to whom*. It does not give
  "withdrawal blocked to anywhere but the user's own wallet."
- **Gum Protocol session keys.** Effectively unmaintained. Not acceptable as a
  dependency for a component in the funds path.

**Squads V4** is real, audited, and worth evaluating — its spending limits carry a
destination list, which is closer to the requirement than native delegation. Treat
this as *to verify*, not as a decided dependency: the question is whether a
spending-limit member can be constrained to *swap via a program* rather than
*transfer to an address*, which is a different shape from what multisig spending
limits are built for.

Absent that, the requirement — a PDA that will sign a Jupiter swap but will not
sign a transfer to any address other than the depositor's own wallet — means
**writing and auditing our own Anchor program**. Budget it as such: implementation
plus an external audit, and the audit is not optional for a program holding user
funds. This is the long pole of the whole architecture, and it is longer than the
custodial design it replaces.

**Consequence for sequencing:** Solana is currently the primary live-execution
chain (`solana-signer.ts`, Jupiter + Jito). Under this ADR it becomes the *last*
chain to get per-user execution. Do not read `S3-1`…`S3-6` as nearly-done for
fan-out; they are done for the **operator** account only.

## §4 Polymarket — the premise does not hold

The proposed model was: users hand over CLOB API key / secret / passphrase, scoped
to placing and cancelling orders but not withdrawals. **CLOB credentials cannot
place an order.** From `docs.polymarket.com/getting-started/api`:

> Order placement uses L2 to authenticate the request **and a wallet signature to
> authorize the order itself.**

`trading/place-orders` makes it concrete: every order carries an EIP-712 `Order`
struct — `salt`, `maker`, `signer`, `tokenId`, `makerAmount`, `takerAmount`,
`side`, `signatureType`, `timestamp`, `metadata`, `builder` — signed by the account
signer, with a fresh `salt` per order. L2 HMAC credentials authenticate the *HTTP
request*; the signature authorizes the *trade*.

So placing orders for a user who is offline requires their signer key. The
credentials are not the security boundary, and "scoped to orders, not withdrawals"
describes a property they do not have.

Two further corrections:

- **`@polymarket/clob-client-v2` is deprecated.** It appears in the docs only in
  the migration guide's uninstall instructions. Current is `@polymarket/client` +
  `viem`, which is already what this repo depends on. Adopting `clob-client-v2`
  would be a regression.
- **Wallet types are dated.** Every Polymarket account wallet deployed on or after
  **May 4 2026** is a **Deposit Wallet** (`signatureType` 3, ERC-7739-wrapped
  signatures). ERC-1967 Proxy (`1`, Magic Link / Google) and Safe (`2`, external
  signer) are **legacy** — accounts created before that date. Building for
  proxy/Safe targets wallets most new users will not have.

`signatureType` 1 and 2 do separate `signer_address` from `maker_address`, which is
the shape delegation would need. But for a Safe, an authorized signer is a Safe
*owner*, and owners can move funds; EIP-1271 signature validation is not gated by
Safe transaction guards, so a guard does not reliably fence it. That path grants
more authority than it appears to.

### §4.1 The Builder Program — what it does and does not give us

The **Builder Program** (`programs/builders/overview`) is the sanctioned path for
"a platform that routes orders from users to Polymarket", and we should enrol in it.
It delivers one thing the original proposal wanted outright:

- **Gasless is confirmed.** Builder relayer access covers "gas-free wallet
  deployment, approvals, order execution and CTF operations." No paymaster to fund
  and no gas budget to cap on this venue — unlike Robinhood Chain (`S4-P8`).
- Plus order attribution, a volume leaderboard, and `listBuilderTrades` /
  `GET /builder/trades`, which is a **builder-wide reconciliation feed** — one call
  covering every account we serve, rather than per-user polling. That is directly
  useful to `reconciliation-coordinator.ts`.

But it does **not** grant signing authority over user wallets. From
`trading/wallets-auth`, on the builder account:

> It represents your integration and owns the builder profile and API credentials
> used to create Deposit Wallets for your users. **Each wallet remains controlled by
> its signer.**

And the provisioning call is `createSecureClient({ signer: privateKey(…), apiKey:
builderApiKey({…}) })` — the **builder credentials authorize provisioning and
relaying; the `signer` private key authorizes the trade.** Builder credentials are
an integration identity, not a delegation grant. They cannot place an order for a
wallet whose signer key we do not have.

### §4.2 What unattended execution actually requires

The full requirement set for trading on a user's behalf while they are offline.
Constraints 4 and 5 bind under *every* fork, including (a):

**1. The account signer private key.** Not only for orders. `redeemPositions()`,
`approveErc20()` and `approveErc1155ForAll()` all submit from the signer, so even a
"we only ever claim winnings" reading of custody still needs the key.

**2. One-time trading approvals, signer-required.** Before the first order: ERC-20
allowance on pUSD and ERC-1155 `setApprovalForAll` on Conditional Tokens, for the
exchange contracts (`setupTradingApprovals()`). Gasless for Deposit, Safe and Proxy
wallets. One-time per wallet — but it means onboarding cannot complete without the
signer. There is no "sign up now, authorize later" path.

**3. L2 API credentials.** Derived from an L1 EIP-712 signature. Notably there is
**no documented expiry or rotation** — unlike a 4337 session key these do not lapse,
so `S4-P9`'s expiry-monitoring problem does not arise on this venue. The inverse of
the tradeoff elsewhere: nothing to renew, and nothing that self-limits either.

**4. Relayer capacity — a hard scaling wall.** The Builder Program's daily relayer
transaction limit is **100/day at Unverified**, 10,000/day at Verified, unlimited at
Partner. Relayer transactions cover wallet deployment, approvals, order execution
and CTF operations — essentially every write. **100/day is not a copy-trading
platform**: one signal fanning out to 100 users exhausts the day. Verified requires
demonstrated volume plus manual approval on a few-business-days turnaround, so this
is a **lead-time dependency, not a config flag** — and the application wants volume
we can only generate after launching. Sequence around that circularity deliberately.

**5. Geoblocking — the genuinely hard one for unattended execution.** Polymarket
restricts order placement by geography and puts the duty on us:

> Builders are responsible for verifying user location before submitting orders.

The check is `GET https://polymarket.com/api/geoblock`, which evaluates **the
requesting IP address**. Under unattended execution the user is by definition
absent, so there is no user IP to present — the request originates from our server.
A naive integration therefore geo-checks *our datacentre* on every trade and always
passes: it satisfies the endpoint and fails the obligation.

Nothing in the API asserts a user's location at a moment when they are not making
the request. Mitigation must be ours: record eligibility at consent time,
re-verify on each interactive session, and halt automated execution for an account
that has not re-verified within some window. That is a policy we invent rather than
one the platform provides, and it belongs in `DG-2`'s legal scope rather than being
settled by engineering alone.

**6. Order type.** `GTC` rests until filled or cancelled, so an unattended order can
fill long after the signal that motivated it has decayed. `GTD` bounds that window —
and expires **one minute before** its stated time as a deliberate security buffer,
which any expiry arithmetic must account for. Prefer `GTD` for copied trades.

**7. Redemption has no deadline.** Winning tokens stay redeemable indefinitely, so
claiming is not latency-sensitive and can be batched — useful given constraint 4.

### §4.3 Conclusion: Polymarket cannot match the other two chains

There is no Polymarket primitive equivalent to a 4337 session key or a PDA program
delegate — no way to hold authority that trades but cannot withdraw. The Builder
Program's own shape presumes the integration either holds user signer keys or
prompts the user to sign. Polymarket's referral and taker-rebate FAQs both exclude
"third-party integrations using **omnibus wallets**", which is a tacit
acknowledgement that builders commonly do hold keys.

So the honest position: **fork (b) is the only option that preserves the product,**
and this venue is a deliberate, disclosed exception to this ADR rather than a
failure to implement it. Two facts make that exception narrower than the custody
model ADR-0002 described:

1. **Custody is venue-scoped.** A user's Deposit Wallet holds only what they moved
   there to trade prediction markets — not their Solana balance, not their
   Robinhood Chain balance, both of which stay non-custodial under this ADR. The
   blast radius is one venue's trading float, not a portfolio.
2. **The key is per-user and revocable in practice.** A user can withdraw their
   Polymarket balance to exit our custody entirely, without abandoning the product
   on the other two chains.

The remaining decision is therefore not *how* to make Polymarket non-custodial —
that is settled, it cannot be — but whether the venue-scoped custody in fork (b) is
acceptable, or whether Polymarket live execution is deferred (fork (a)) until it is.

## §5 What is still a secret, and why custody work is not wasted

Non-custodial shrinks the blast radius; it does not remove secret storage. Session
keys, delegate keypairs, and CLOB credentials are all secrets that let an attacker
trade as the user. They must be encrypted at rest with the same care.

So `S4-3`'s envelope encryption and `S4-4`'s `KeyWrapper` seam **survive** — with a
changed threat model:

| | ADR-0002 (custodial) | ADR-0003 (delegated) |
| --- | --- | --- |
| Secret stored | user root private key | scoped session key / delegate key |
| Loss on host compromise | all funds, forever | scoped trades, until expiry |
| User remedy | none | revoke on-chain |
| Recovery if we lose it | funds unrecoverable | re-grant; funds never moved |

The last row is the one that retires the most work. Losing a master key no longer
means losing user funds, so **Shamir 3-of-5 escrow of the user-key master key is no
longer load-bearing** for user funds. Key loss degrades to a re-onboarding
inconvenience.

## §6 Open fork — Polymarket

Narrowed by §4.3. Non-custodial is **not achievable** on this venue, so the choice
is not *how* but *whether*:

- **(a) Defer** Polymarket per-user live execution. Signals, tracking, and paper
  stay; live fan-out waits. Costs the venue, keeps the architecture uniform.
- **(b) Venue-scoped custodial exception, disclosed.** ← **recommended.** Enrol in
  the Builder Program; provision a Deposit Wallet per user; hold that signer key
  under ADR-0002's envelope encryption, migration trigger, and escrow — scoped to
  Polymarket alone, with the trigger thresholds measured on Polymarket balances
  only. Solana and Robinhood Chain stay non-custodial.

**Withdrawn** after §4.1–§4.3: *(c) user-signs browser-side* removes copy-trading
for offline users, and *(d) research Deposit Wallet delegation* is answered — each
wallet remains controlled by its signer, and no scoped-signer facility is exposed.

Under either fork, **enrol in the Builder Program regardless**: attribution and the
`GET /builder/trades` reconciliation feed are useful in paper mode, and gasless
relayer access is a prerequisite for (b).

## §7 What remains of ADR-0002

Narrowed, not deleted:

- The **operator** Solana key (`SOLANA_PRIVATE_KEY`, `solana-signer.ts`) is still a
  live secret and still funds real trades.
- The **SOPS age key** (`D-S4-D`) is unaffected — losing it loses decryptable
  config, which no delegation model changes.
- `docs/runbooks/custody-key-shamir-split.md` therefore still applies, to those two
  secrets.
- `docs/runbooks/custody-vault-migration.md` is **parked**. Retain it: it becomes
  the procedure again under fork (b), and the separate-host argument still holds
  for the operator key.

## §8 Consequences

- `S4-3` / `S4-4` retargeted to session-key and credential storage (§5).
- `S4-P5` (migration trigger) **retired** unless fork (b), where it returns scoped
  to Polymarket balances.
- `S4-P6` (unwrapped data-key cache) **retired** as specified; the fan-out
  concern reappears as bundler/paymaster throughput and per-user nonce management.
- `S4-18` (hardened custody host) **downgraded** from a launch requirement.
- Adds: paymaster gas cost becomes an operating expense per copied trade, and a
  griefing surface. It needs a budget cap and per-user rate limiting before any
  live fan-out.
- Adds: session-key **expiry** is now a liveness dependency. A silently expired
  grant means a user stops copying with no error at trade time. Expiry monitoring
  and re-consent prompts are new, mandatory work.
