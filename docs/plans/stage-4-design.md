# Stage 4 Design — Custody & Per-User Execution

> **PARTIALLY SUPERSEDED 2026-08-09** by `docs/adr/0003-delegated-execution-authority.md`.
> WAKE no longer custodies user private keys; users grant scoped, revocable,
> expiring authority per chain. Read the ADR first — on any conflict it wins.
>
> | Section | Status under ADR-0003 |
> | --- | --- |
> | §0 Corrections, §1 Principles | valid |
> | §2 `packages/custody` | **renamed** `packages/authority`; boundary argument still holds |
> | §3 Envelope encryption | **retargeted** — seals session keys / delegate keys / CLOB creds, not root keys (ADR-0003 §5) |
> | §4 Master-key backup & DR | **largely dissolved** — key loss no longer costs user funds; survives for the operator key + SOPS age key (ADR-0002, narrowed) |
> | §5 Schema `047`–`050` | `047` **renamed** `user_execution_grants` + `scope_policy`/`expires_at`; rest valid |
> | §6 Deposit / withdraw | **only applies to Polymarket** under `DG-9` fork (b); the other two chains never take deposits |
> | §7 Fan-out & `DG-7` | valid — the strongest surviving section |
> | §8 `account` → user id inventory | valid, and still the best call-site map |
> | §9 Test plan, §10 Deferred | valid |
>
> Retained rather than rewritten: §7 and §8 are load-bearing and unaffected, and §3–§4
> become live again for Polymarket alone if `DG-9` resolves to fork (b).

**Scope:** `AUDIT-FIX-CHECKLIST.md` §7 tasks `S4-1` … `S4-18`. Migrations `047`–`050`.
**Depends on:** Stage 0 (canonical lifecycle, DB-resolved risk policy, breaker), Stage 2 (`forUser()`, subscriptions, tiers), `docs/adr/0001-tenancy-key.md`, `DG-1` (resolved).
**Blocked by:** `DG-2` / `D13` legal gate (`S4-1`) — **launch**, not build. Code proceeds; deployment does not.
**Open before `S4-13`:** `DG-7` fan-out market impact. §7 gives options and a recommendation; the decision is a human's.
**Delivers:** ~~a user deposits to a platform-managed custodial wallet~~ → *(ADR-0003)* a user **grants scoped authority over their own wallet**, sets risk, and has one signal fan out to N users with disjoint, individually-sized executions — with the granted secret never leaving `trade-executor`.

This is the construction spec the checklist deliberately does not carry. Where it
and the checklist disagree, the checklist's *task list* wins and this doc's
*detail* wins.

**This is the stage where a bug loses someone else's money.** Every other stage
fails by being unavailable or wrong; this one fails by being irreversible.

---

## 0. Corrections to the existing plans

Found by reading the plans against the code and against each other. Fix these
before writing any migration.

| Where | Says | Actual | Fix |
|---|---|---|---|
| `AUDIT-FIX-CHECKLIST.md` §7.2 heading | "Schema — migrations `046`–`049`" | `046` was taken by `046_polymarket_redemptions.sql` (Stage 3). §11 of the same file was corrected to `047`–`050`; the §7.2 heading was not. | Heading reads `047`–`050`. The task lines `S4-7`…`S4-10` already carry the right numbers; only the heading is stale. |
| `docs/adr/0001-tenancy-key.md` §"Migration sequencing" | "(Stage 4, migration `049`)" | `049` is `user_execution_settings`. The tenancy key is `050`. | Same off-by-one, inherited from the pre-correction ledger. |
| `docs/plans/saas-conversion-plan.md` §Phase 3 | "`target_account` already exists in 028 and maps to user id" | False — verified: `copy_executions.target_account` is `VARCHAR(128)` filled from `resolveLiveCopyTargetAccount(chain)` / `resolvePaperCopyTargetAccount(chain)` at `apps/trade-executor/src/index.ts:904`, a chain-prefixed wallet address. | Already superseded by ADR-0001. Recorded again because the plan text is still there. |
| `AUDIT-FIX-CHECKLIST.md` `S4-3` / D11 | Envelope encryption specified. | **Nothing anywhere specifies master-key backup, rotation, or recovery.** Losing the master key makes every user's funds unrecoverable, and there is no code that can fix it after the fact. | §4 of this doc. It is an **open gate needing a human**, not a design detail. |
| `AUDIT-FIX-CHECKLIST.md` `S4-16` | "ride the existing account-parameterized machinery **unchanged** — substitute the user key for `'operator'`." | The *signatures* are unchanged — verified, see §8. The *stored state* is not: `signal_stop_losses.account` and `copy_eligibility_rejections.account` are `VARCHAR(64) NOT NULL DEFAULT 'operator'`, and a UUID is 36 chars, so it fits — but `copy_positions`/`copy_executions.target_account` is `VARCHAR(128)` and stays a **wallet address**, not a user id. "Substitute the user key" is right for `account`, wrong for `target_account`. | §8 lists the exact call sites and which column each one lands in. |

---

## 1. Principles for this stage

1. **The master key exists in exactly one process.** `trade-executor` holds it.
   `api`, `web`, `indexer`, `scorer`, `signal-engine`, `alert-service`, and
   `discovery` do not, and must fail to start if they find it in their
   environment. An API compromise must yield ciphertext only.
2. **The API may request key *generation*, never key *decryption*.** Keygen is a
   write that produces an address and a wrapped blob; there is no route, queue
   message, or admin tool anywhere that returns plaintext key material. This is
   `S4-5`, and it is a structural property, not a review convention (§4.4).
3. **Fail closed, in the direction that loses opportunity rather than money.**
   Unknown balance → do not size. Unresolvable execution mode → paper.
   Unverifiable withdrawal destination → refuse. A missing certification →
   paper. Every ambiguity resolves toward *not moving funds*.
4. **Never fabricate a fill, a balance, or a payout.** Carried from Standing
   Rule 3, and it now applies to `user_balances`: a stale balance is labelled
   stale, never extrapolated. Stage 3 already set this precedent —
   `redeemedCollateral` is recorded as `0` rather than derived from a balance
   delta, because the venue returns no figure.
5. **A user's exposure is bounded by what *that user* deposited and agreed to.**
   No global pool, no cross-user netting, no shared position. Sizing reads that
   user's balance and that user's risk percentages, and nothing else.
6. **Platform gates clamp on top of user settings, never underneath.**
   `LIVE_ENABLED_CHAINS` ∧ `chain_certifications` is the ceiling; a user setting
   can only lower it. A user cannot opt into live on an uncertified chain, and
   the resolution order must make that structurally impossible rather than
   checked at the end.

### What must never happen

Stated as failures, because these are the assertions the test plan in §9 exists
to hold:

- A private key, wrapped or plaintext, appears in an API response, a log line, an
  error message, a Telegram alert, a `trades` row, or an audit-log `metadata`
  blob.
- A withdrawal lands at an address the user never proved control of.
- User A's balance funds user B's trade, or user A's loss debits user B.
- The master key is lost or rotated in a way that strands wrapped keys.
- A destructive migration statement ships in the same release as the code that
  stopped depending on it (Standing Rule 4).
- Fan-out sizes N users off one balance snapshot and collectively exceeds any
  one of them.

---

## 2. Package boundary — `packages/custody`

The package's whole job is that **the set of code able to produce plaintext key
material is small, named, and greppable.** Everything else is packaging.

```
packages/custody/src/
  index.ts          # public surface — deliberately narrow
  keypair.ts        # generateSolanaKeypair, generateEvmKeypair
  envelope.ts       # sealPrivateKey / openPrivateKey (AES-256-GCM)
  wrapper.ts        # KeyWrapper interface + EnvMasterKeyWrapper
  signer.ts         # CustodialSigner factories (the only consumers of openPrivateKey)
  errors.ts
```

Public exports, and nothing else:

```ts
export interface GeneratedWallet {
  readonly chainKind: 'evm' | 'solana';
  readonly address: string;          // the ONLY plaintext output of keygen
  readonly sealed: SealedKey;        // opaque; safe to store and to log a hash of
}

/** Callable from the API. Returns no plaintext key material, by construction. */
export function generateCustodialWallet(
  chainKind: 'evm' | 'solana',
  wrapper: KeyWrapper,
): Promise<GeneratedWallet>;

/** Callable ONLY from trade-executor. Guarded — see §4.4. */
export function createSolanaSigner(sealed: SealedKey, wrapper: KeyWrapper): Promise<SolanaSigner>;
export function createEvmSigner(sealed: SealedKey, wrapper: KeyWrapper): Promise<EvmSigner>;
```

`openPrivateKey` is **not exported from the package root.** It is module-private
to `signer.ts`. The signers return an object with `signTransaction` /
`signMessage` closures over the key — the same shape
`apps/trade-executor/src/solana-signer.ts` already uses for the operator wallet,
where "the private key is loaded once into a closure and never returned, logged,
or placed on a reachable object" (S3-1). Stage 3 built the seam deliberately: the
signer is a **parameter** in `jupiter-swap.ts`, `jupiter-jito-runtime.ts`, and
the Robinhood/Polymarket paths, so substituting a per-user custodial signer is a
value change at the call site, not a refactor.

**Why a package and not a directory inside `trade-executor`.** The API genuinely
needs `generateCustodialWallet` (a user signs up, we mint their wallets), and the
API genuinely must not be able to decrypt. A shared package with an export list
that omits the decrypt path makes "the API cannot decrypt" a compile-time fact.
If it lived inside `trade-executor`, the API would import it over an internal
route or a queue message, and the boundary would be a protocol convention that
the next handler forgets.

---

## 3. Envelope encryption (`S4-3`)

### 3.1 The scheme

Per key, not per user and not per platform:

1. Generate a 32-byte data key from `randomBytes(32)`.
2. `AES-256-GCM` encrypt the private key with the data key and a fresh 12-byte
   IV. Retain the 16-byte auth tag.
3. Wrap the data key with the `KeyWrapper` (§3.2). Store the wrapped blob.
4. Zero nothing and pretend nothing — Node cannot reliably zero a `Buffer` that
   the GC may have copied. Instead, minimise the number of places plaintext
   exists and the duration it exists for. Claiming "keys are wiped from memory"
   would be a false assurance in this runtime.

`SealedKey` is stored as one self-describing value, so a future format change is
detectable rather than a silent misparse:

```
v1.<wrapperId>.<b64(wrappedDataKey)>.<b64(iv)>.<b64(authTag)>.<b64(ciphertext)>
```

- **Version prefix first.** Migration from `v1` to `v2` (different cipher, or a
  wrapper that returns a different blob shape) is a parse-time branch, not a
  guess. Without it, a format change makes every existing key undecryptable with
  no way to tell which format a given row is.
- **`wrapperId` is embedded, not read from config.** A row wrapped by
  `env:v3` must not be handed to a KMS wrapper that would fail with a confusing
  auth error. The row states who can open it.
- **AAD.** The GCM additional-authenticated-data is
  `${userId}|${chainKind}|${keyVersion}`. This binds the ciphertext to its row:
  moving a sealed blob from user A's row to user B's row makes decryption fail
  with an auth-tag error rather than succeeding and letting the platform sign
  user B's trade with user A's key. Without AAD, a SQL-injection or a bad
  admin script that swaps two rows produces a working, wrong signer.

**Why per-key data keys rather than encrypting directly under the master key.**
Rotation. Rotating a master key that directly encrypts N private keys requires
decrypting and re-encrypting every private key, which means every user's
plaintext key transits memory in one batch job — the single worst moment to have
a crash, a core dump, or a log line. With envelope encryption, rotation
re-wraps N *data keys*: the private-key ciphertext is untouched and never
decrypted. That is the entire reason this design exists, and it is also why §4
is not optional.

### 3.2 `KeyWrapper` (`S4-4`, D11)

```ts
export interface KeyWrapper {
  /** Stable id embedded in every SealedKey this wrapper produces. */
  readonly id: string;
  wrap(dataKey: Buffer, context: WrapContext): Promise<Buffer>;
  unwrap(wrapped: Buffer, context: WrapContext): Promise<Buffer>;
}

export interface WrapContext {
  readonly userId: string;
  readonly chainKind: 'evm' | 'solana';
  readonly keyVersion: number;
}
```

Two implementations at Stage 4:

| Impl | `id` | Where the master key lives |
|---|---|---|
| `EnvMasterKeyWrapper` | `env:v<n>` | `CUSTODY_MASTER_KEY` in `trade-executor`'s SOPS-decrypted env, on the hardened host |
| `NullWrapper` | `null:v1` | Nowhere — **refuses to wrap**, used by staging and tests |

`NullWrapper` is not a stub that returns the key unchanged; it throws on both
`wrap` and `unwrap`. Staging is required by D2 to be structurally unable to move
money, and "no custody master key present" is one of its three locks. A
pass-through wrapper would silently satisfy the code path and turn staging into a
place where real custody bugs hide behind fake success.

`wrap`/`unwrap` are **async and take a context** even though the env
implementation needs neither. A KMS wrapper is a network call, and both AWS KMS
and Vault Transit take an encryption-context map that must match on unwrap. A
synchronous, context-free interface would make the KMS swap a signature change
propagating through every caller — exactly what D11 says this interface exists to
avoid.

A third implementation, **`VaultTransitWrapper`** (`vault:v<n>`), is the decided
migration target — **separate host**, master key held in `transit/keys/swat-custody`
and never transmitted. It is written and demonstrated on staging as part of the exit
gate, but is not the production default at Stage 4: per
`docs/adr/0002-custody-key-store.md`, production runs `EnvMasterKeyWrapper` until
**USD 50,000 custodied or 100 funded users**, a trigger enforced by `S4-P5` rather
than left to intent. An `AwsKmsWrapper` remains possible under the same interface
but is no longer the planned destination.

Cutover is `wrapperId`-driven: new keys seal under the new wrapper, old keys open
under the old one, both wrappers stay registered until a re-wrap sweep completes.
That is expand-and-contract applied to ciphertext, and it is why the migration needs
no flag day — see `docs/runbooks/custody-vault-migration.md`.

**Call frequency, which sizes the deployment.** The wrapper is invoked for
`unwrap` — once per user per trade — not per signature: signing happens locally, so
a Solana trade's swap and tip signatures share one unwrap. A signal fanning out to
500 users is a 500-unwrap burst on a 15s cadence, so Vault must be sized for
*concurrent* unwraps during fan-out rather than for trade volume, and the bounded
data-key cache in `S4-P6` is what keeps that practical.

---

## 4. Master-key backup, rotation, and disaster recovery — **the unspecified gap**

Neither `AUDIT-FIX-CHECKLIST.md` `S4-2`…`S4-6` nor D11 says anything about this.
D15 covers Postgres backups; the master key is not in Postgres, so **the
documented backup strategy explicitly does not cover the one secret without which
the backup is worthless.** D2 says staging holds no master key, which is correct
and also means the usual "staging restores nightly, so the backup is tested"
argument does not apply here — staging can restore the database and still be
unable to open a single key.

State it plainly: **if `CUSTODY_MASTER_KEY` is lost, every user's funds are
permanently unrecoverable.** Not degraded, not delayed. The wrapped data keys are
AES-256-GCM ciphertext; there is no recovery path, no support escalation, and no
code change that helps. The database backup restores perfectly and is useless.

This is the highest-severity single point of failure in the entire system, and it
is currently undesigned.

### 4.1 What is decided here

These are design decisions, made because leaving them open would leave the
default (a single env var on one box, backed up nowhere) in place:

**D-S4-A — the master key is versioned from day one.**
`CUSTODY_MASTER_KEY` becomes `CUSTODY_MASTER_KEY_V<n>` plus
`CUSTODY_MASTER_KEY_ACTIVE=<n>`. `EnvMasterKeyWrapper.id` is `env:v<n>`, and it
loads **every** version present, wrapping with the active one and unwrapping with
whichever version the `SealedKey` names. Retrofitting versioning after the first
rotation is not possible without a flag day where every key must be re-wrapped
atomically — which is a flag day that touches every user's funds at once.

**D-S4-B — rotation re-wraps data keys only, never private keys.**
A `rewrapCustodyKeys` job (in `trade-executor`, never the API) iterates
`user_trading_wallets`, unwraps the data key under its stated version, re-wraps
under the active version, and updates the row. `key_version` on the row is the
*keypair* version and does not change; the wrapper version lives in the
`SealedKey` string. **The private-key ciphertext is never decrypted during
rotation** — that is the property §3 bought, and it means a crash mid-rotation
leaves a mix of `env:v1` and `env:v2` rows that both still open, not a partially
decrypted set. The job is resumable and idempotent by construction: re-wrapping
an already-`v2` row is a no-op it can detect from the prefix without decrypting.

**D-S4-C — `key_version` on the wallet row means keypair rotation, which is a
different operation with a different cost.** Rotating a *keypair* means
generating a new address and moving funds on-chain, which costs gas, needs
reconciliation, and — per ADR-0001 — must not fork the user's execution history.
This is why `user_id` is the tenancy key and `target_account` is not. Keypair
rotation is deferred (§10); wrapper rotation is not.

**D-S4-D — the master key never enters git, a CI secret store, a container
image, or a log.** It lives in the SOPS-encrypted env file for
`trade-executor` only (D10), and the age private key lives on the host. This
means **two** secrets must survive for funds to be recoverable: the SOPS age key
and the encrypted file. Both need the same custody discipline, and losing either
is equivalent to losing the master key.

**D-S4-E — startup asserts the key is usable, not merely present.** On boot,
`trade-executor` seals and opens a known test vector under the active wrapper and
refuses to start if the round trip fails. A truncated, whitespace-padded, or
wrong-encoding master key otherwise presents as a per-trade auth-tag failure at
signing time — i.e. discovered when a user's trade fails, not when the process
starts. Every non-executor service asserts the **inverse**: if
`CUSTODY_MASTER_KEY_V*` is set in `api`, `web`, `indexer`, `scorer`,
`signal-engine`, `alert-service`, or `discovery`, that process refuses to start.
A misconfigured Compose file that leaks the key into the API's environment is a
loud boot failure rather than a silent widening of the blast radius.

### 4.2 What is NOT decided here — **open gate, needs a human**

**`DG-8` (new) — master-key escrow and recovery procedure.** Blocks Stage 4
launch along`DG-2`. The following require an operator decision, not a
code decision, and each has consequences code cannot mitigate:

| Question | Options | The tradeoff nobody can decide in code |
|---|---|---|
| Where is the offline backup? | ~~open~~ — **decided 2026-08-07** | **Shamir 3-of-5.** Any 3 shares reconstruct the secret; any 2 reveal *mathematically nothing* — not a partial key, zero information. That property is why it beats every "store N copies" scheme: copies make theft easier as they make loss harder, whereas raising the share count improves both at once. **Share locations are deliberately NOT recorded in this repository** — they are held by the operator out of band. Writing them here would put the map to the funds in the same place as the code. |
| Share format | ~~open~~ — **decided 2026-08-07** | **SLIP-39 mnemonic words** (`shamir-mnemonic`, SatoshiLabs), 33 words per share for a 256-bit secret. Chosen over hex/`ssss` because shares are transcribed by hand: SLIP-39 is checksummed, so a mis-copied word is caught **when the share is validated rather than when it is finally needed**, and its 1024-word list has no `0`/`O` or `1`/`l` ambiguity. **The tool name and version must be stored alongside the shares** — Shamir is not one interoperable format, and five envelopes with no record of what produced them are worth nothing. **Share indices must be labelled**; reconstruction fails without them even with all five in hand. |
| Who can reconstruct it? | Sole operator · 2-of-3 · 2-of-3 including one non-employee | Sole operator means the bus factor is 1 and every user's funds die with an accident. Multi-party means a quorum can collude, and needs a written procedure that exists before it is needed. **Still open** — 3-of-5 fixes the *threshold*, not *whose hands the shares are in*. |
| Is recovery ever *tested*? | Never · annually on a **separate** key + throwaway wallets | An untested recovery procedure is a hope. Testing it on the real key means the real key transits a laptop. The only safe test uses a distinct key and disposable funds, and that test must be scheduled or it will not happen. |
| Rotation cadence | On suspected compromise only · scheduled quarterly | Scheduled rotation exercises the machinery so it works when it matters. It also multiplies the number of key versions in existence and therefore the number of secrets to keep safe. |
| Balance ceiling before KMS | ~~undefined~~ — **decided 2026-08-07, `docs/adr/0002-custody-key-store.md`** | **USD 50,000 custodied, or 100 funded users, whichever first.** Migration target is separate-host **Vault Transit**, not AWS KMS. Same-host Vault was rejected: root on the box reads Vault's memory, storage, unseal material and token alike, so it buys the audit log and rotation while surrendering nearly all of the security benefit — more work than the env key for close to the same exposure. The threshold is enforced in code (`S4-P5`): crossing it raises a blocking alert and refuses new custodial wallet creation until the active wrapper is `vault:*`. Procedure: `docs/runbooks/custody-vault-migration.md`. |

**Recommendation, for a human to accept or reject:** Shamir 3-of-5 over the
master key, shares held in five physically separate locations with at least one
outside the operator's home and one outside the operating country; recovery
rehearsed annually against a throwaway key. **The migration target and threshold
are no longer open** — separate-host Vault Transit at USD 50,000 custodied or 100
funded users (`docs/adr/0002-custody-key-store.md`, enforced by `S4-P5`); only the
escrow rows above still need a human, and they need one for *either* store, since
Vault relocates the problem to its unseal shares rather than removing it. The
reasoning behind the Shamir recommendation is that total loss and total theft are
both
catastrophic and Shamir is the only listed option that raises the bar on both at
once — but it is also the option with the most operational failure modes
(illegible shares, a share holder who moves, a forgotten reconstruction
procedure), and those failure modes are human, so a human must accept them.

**Until `DG-8` is closed, custody must not hold funds in production.** This is a
second non-code gate on Stage 4 launch that the checklist does not currently
list, and it should be added to `docs/testing-aspects.md` §Stage 4 next to
`S4-1`.

---

## 5. Schema — migrations `047`–`050`

Conventions matched from Stage 1/2 and `035_copy_eligibility_policy.sql`:
`gen_random_uuid()` defaults, `TIMESTAMPTZ` throughout, `VARCHAR(n)` for bounded
values, `CREATE … IF NOT EXISTS` only, `CREATE INDEX IF NOT EXISTS` after the
table. Every file replays twice cleanly — `migrate.ts` re-runs all of them on
every invocation and keeps no applied-migrations table (D16).

### `047_user_trading_wallets.sql` (`S4-7`)

```sql
CREATE TABLE IF NOT EXISTS user_trading_wallets (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  chain_kind   VARCHAR(16)  NOT NULL,
  address      VARCHAR(100) NOT NULL,
  sealed_key   TEXT         NOT NULL,
  key_version  INTEGER      NOT NULL DEFAULT 1,
  status       VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  retired_at   TIMESTAMPTZ,
  CONSTRAINT chk_utw_kind   CHECK (chain_kind IN ('evm','solana')),
  CONSTRAINT chk_utw_status CHECK (status IN ('active','retired','compromised')),
  CONSTRAINT chk_utw_sealed_versioned CHECK (sealed_key LIKE 'v%'),
  CONSTRAINT uq_utw_address UNIQUE (chain_kind, address)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_utw_active_per_user_kind
  ON user_trading_wallets(user_id, chain_kind)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_utw_user ON user_trading_wallets(user_id);
```

- **`ON DELETE RESTRICT`, not `CASCADE`.** Stage 1 and 2 used `CASCADE` because
  sessions and subscriptions are preferences. This row is the only pointer to
  funds. A cascade delete on a user with a non-zero balance destroys the key and
  the money with it, irreversibly, from a single `DELETE FROM users`. Stage 1
  already made deletion soft (`users.status = 'deleted'`); `RESTRICT` makes the
  hard path fail loudly rather than depending on that discipline holding.
- **`chain_kind`, not `chain`** — matching `041_user_auth_wallets.sql`. One EVM
  keypair signs on Polygon and Robinhood Chain both; minting a separate key per
  EVM chain would double the custody surface for zero benefit and fragment a
  user's balance across addresses that are cryptographically the same identity.
  This is also why `048` keys balances by `chain`, not by wallet: one address,
  many chains.
- **`address` is NOT chain-prefixed**, for the same reason as
  `user_auth_wallets`: `chain_kind` is the discriminator, and the repo-wide
  `${chain}:${raw}` invariant applies to *tracked* wallets and transactions.
  EVM lowercased, Solana case-preserved, matching `resolveChainAddress`
  semantics. **Any join to `copy_positions.target_account` must prefix on the
  way** — that column holds the prefixed form.
- **`uq_utw_address` is global**, mirroring `uq_auth_wallet`. Two users
  cannot share a custodial address; if a keygen collision or a restore bug
  produced one, two users' funds would sit at one address with two ledger
  balances and no way to say whose is whose.
- **The partial unique index is the real invariant**: exactly one `active`
  wallet per `(user_id, chain_kind)`. A plain `UNIQUE (user_id, chain_kind)`
  would make key rotation impossible without deleting the old row — deleting the
  row that holds the sealed key for an address that may still hold dust.
  Retired rows stay forever and stay decryptable.
- **`sealed_key` is `TEXT`.** Its length depends on the wrapper: an env-wrapped
  data key is 32 bytes, an AWS KMS `CiphertextBlob` is a few hundred. A
  `VARCHAR(n)` sized for the env wrapper silently truncates or rejects on the
  KMS swap — during a migration that touches every user's key.
- **`chk_utw_sealed_versioned`** is a cheap tripwire: it rejects any write that
  is not a versioned envelope, so a code path that ever stores a raw or
  base64-only key fails at the database rather than at the next signing attempt.
  It cannot detect a plaintext key that happens to start with `v`; it is a
  guardrail, not a proof, and §9's test plan carries the real assertion.
- **No `balance` column here.** Balances live in `048` and are cached
  observations, not authority. Putting a mutable balance on the key row invites
  reading it as truth.

### `048_user_balances.sql` (`S4-8`)

```sql
CREATE TABLE IF NOT EXISTS user_balances (
  user_id     UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain       VARCHAR(32)  NOT NULL,
  asset       VARCHAR(128) NOT NULL,
  amount      NUMERIC      NOT NULL DEFAULT 0 CHECK (amount >= 0),
  decimals    SMALLINT     NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 36),
  usd         NUMERIC      CHECK (usd IS NULL OR usd >= 0),
  usd_priced_at TIMESTAMPTZ,
  fetched_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  source      VARCHAR(24)  NOT NULL DEFAULT 'poller',
  PRIMARY KEY (user_id, chain, asset),
  CONSTRAINT chk_ub_source CHECK (source IN ('poller','post-trade','manual-refresh'))
);

CREATE INDEX IF NOT EXISTS idx_user_balances_stale ON user_balances(fetched_at);
```

- **`ON DELETE CASCADE` is correct here and `RESTRICT` is correct on `047`**,
  and the difference is the point: this table is a *cache of an on-chain fact*.
  Deleting it loses nothing — the poller rebuilds it from the chain. Deleting
  `047` loses the funds.
- **`PRIMARY KEY (user_id, chain, asset)`** — the triple is the fact, matching
  the reasoning in Stage 2's `044`. No surrogate id; there is nothing to
  reference.
- **`usd` is nullable and carries its own timestamp.** A price fetch can fail
  independently of a balance fetch. Encoding "we know the amount but not the
  price" as `usd = 0` would make a funded user look empty to the sizing path,
  which then sizes to zero — a silent failure that looks like a working system.
  Nullable `usd` forces the sizing path to say "unknown" and refuse (Principle 3).
- **`decimals` is stored alongside `amount`.** `NUMERIC` holds the human-scale
  amount; the raw base-unit integer needs `decimals` to reconstruct, and Stage 3
  already established that a sell needs an exact base-unit quantity (`S3-7`:
  "a BUY is `ExactIn` on SOL; a SELL is `ExactIn` on the token"). Deriving
  decimals at read time from a token-metadata lookup makes the sizing path
  depend on a second network call that can fail.
- **`source`** distinguishes a scheduled poll from a post-trade refresh. When a
  balance looks wrong, the first question is always "when and why did we last
  write this", and reconstructing it from timestamps alone is guesswork.
- **`idx_user_balances_stale`** serves the poller's "what is oldest" scan and the
  sizing path's staleness check.

**Staleness is a hard gate, not a warning.** The sizing path refuses to size a
live trade against a balance older than `BALANCE_MAX_STALENESS_MS` (default 60s)
and triggers a synchronous refresh instead. Sizing off a stale balance is how a
user ends up with more exposure than they hold: the previous trade's debit has
not been observed, so the next trade sizes off pre-trade funds. Fan-out makes
this acute — N jobs for one user across chains can all read the same
pre-trade snapshot within one poll interval.

### `049_user_execution_settings.sql` (`S4-9`)

```sql
CREATE TABLE IF NOT EXISTS user_execution_settings (
  user_id                UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  auto_execute           BOOLEAN     NOT NULL DEFAULT FALSE,
  min_signal_score       SMALLINT    NOT NULL DEFAULT 80
                           CHECK (min_signal_score BETWEEN 0 AND 100),
  max_position_pct       NUMERIC(5,2) NOT NULL DEFAULT 5
                           CHECK (max_position_pct > 0 AND max_position_pct <= 100),
  max_daily_exposure_pct NUMERIC(5,2) NOT NULL DEFAULT 25
                           CHECK (max_daily_exposure_pct > 0 AND max_daily_exposure_pct <= 100),
  stop_loss_pct          NUMERIC(5,2) NOT NULL DEFAULT 20
                           CHECK (stop_loss_pct > 0 AND stop_loss_pct <= 100),
  rebuy_cooldown_seconds INTEGER     NOT NULL DEFAULT 3600
                           CHECK (rebuy_cooldown_seconds >= 0),
  max_daily_withdrawal_usd NUMERIC   NOT NULL DEFAULT 1000
                           CHECK (max_daily_withdrawal_usd >= 0),
  killed                 BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ues_position_within_daily
    CHECK (max_position_pct <= max_daily_exposure_pct)
);

CREATE TABLE IF NOT EXISTS user_chain_execution_settings (
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain      VARCHAR(32) NOT NULL,
  mode       VARCHAR(16) NOT NULL DEFAULT 'off',
  -- Per-chain because tolerable slippage is a property of the venue, not the
  -- user: 3% is loose on a Polymarket CLOB book and tight on a thin Solana
  -- memecoin. One global value would force a user to accept the loosest chain's
  -- risk everywhere. NULL = "use the chain default" and is deliberately
  -- distinct from a user-chosen value, so raising a default later reaches
  -- users who never set one without overwriting anyone who did (`S4-P4`).
  max_slippage_bps INTEGER     NULL
                     CHECK (max_slippage_bps > 0 AND max_slippage_bps <= 5000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, chain),
  CONSTRAINT chk_uces_mode CHECK (mode IN ('off','paper','live'))
);
```

- **Defaults are `DEFAULT_RISK_CONFIG`** (`packages/shared/src/constants.ts:66`),
  verified: `maxPositionPct: 5`, `maxDailyExposurePct: 25`, `stopLossPct: 20`.
  `min_signal_score` defaults to 80, matching the seeded
  `signals.auto_execute_min_score` in `001_init.sql:147`. Duplicating the numeric
  literals in SQL is deliberate — a migration cannot import TypeScript — but the
  values must match, and §9 has a test that asserts the DDL defaults equal
  `DEFAULT_RISK_CONFIG` so drift fails CI instead of silently giving new users
  different risk than the docs claim.
- **`auto_execute` defaults to `FALSE` and per-chain `mode` defaults to
  `'off'`.** A user who creates an account and deposits does not begin trading.
  Opting in is an explicit act, and D13's disclosure obligations attach to it.
- **`chk_ues_position_within_daily`** rejects a single-position cap larger than
  the daily cap. Without it, one trade can exhaust and exceed the daily limit,
  making the daily limit decorative. The checklist lists both fields and does not
  say they must be ordered; they must.
- **A second table for per-chain mode, not a JSONB column.** A JSONB
  `{"solana":"live"}` cannot carry a `CHECK` on the value, cannot be joined to
  the certification gate, and needs application-side parsing in the fan-out
  enumeration query — which is the hot path in §7. The pair *is* the fact, same
  argument as Stage 2's `044`.
- **`killed`** is the per-user kill switch (`S6-8`). It is on the settings row
  rather than derived from setting every chain to `off`, because those are
  different intents: "stop everything now" must be one atomic write that survives
  the user later re-enabling one chain, and it must be greppable in the audit log
  as one event.
- **`max_daily_withdrawal_usd` lives here, not in a constant**, because D11
  requires a daily cap and a per-user cap must be adjustable by an admin without
  a deploy. Default 1000 is deliberately low; raising it is an audited admin
  action (§6).
- **No row is created at signup.** Absence means "all defaults, nothing opted
  in", and the resolver returns defaults for a missing row. Creating a row at
  signup would require Stage 1's signup path to know about Stage 4's schema.

### `050_trades_copy_executions_user_id.sql` (`S4-10`) — expand only

This migration is **expand-only** and contains no destructive statement, per
ADR-0001 §"Migration sequencing", Standing Rule 4, and D16(c)/(d).

```sql
-- EXPAND. No column is dropped, no constraint is removed, no row is rewritten.
-- The contract phase is migration 057+, in a LATER RELEASE. See §5.1.

ALTER TABLE trades           ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE copy_executions  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
ALTER TABLE copy_positions   ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);

-- New tenancy-keyed uniqueness, ALONGSIDE the existing target_account uniqueness.
-- Partial: legacy operator rows have user_id NULL and are excluded, so this
-- index cannot conflict with the pre-tenancy data it must not touch.
CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_exec_source_user_mode
  ON copy_executions (source_trade_id, user_id, execution_mode)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_exec_chain_user_client_order
  ON copy_executions (chain, user_id, client_order_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trades_user           ON trades(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_copy_exec_user        ON copy_executions(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_copy_positions_user   ON copy_positions(user_id) WHERE user_id IS NOT NULL;
```

- **`user_id` is nullable and stays nullable through Stage 4.** NULL means the
  legacy operator row (ADR-0001). It is never backfilled — attributing
  single-operator history to a user account would corrupt that user's P&L,
  expectancy, and exposure caps with trades they never made. This repeats Stage
  1's `S1-7` reasoning and is the same decision.
- **The new unique indexes are `WHERE user_id IS NOT NULL`.** This is not
  cosmetic. Stage 3 learned it the expensive way: `046`'s first exactly-once
  guard was **inert** because the partial unique index included a column that was
  NULL for every row, and **NULL never conflicts with NULL** — two concurrent
  sweeps both claimed the same market. Here the *opposite* shape is required: we
  must exclude the NULL-`user_id` legacy rows entirely, or a table constraint
  spanning them would be simultaneously useless (NULLs never conflict) and
  misleading (it looks enforced). Making the exclusion explicit says which rows
  are governed.
- **`copy_positions` also gains `user_id`, which the checklist does not
  mention.** Its primary key is `(target_account, chain, token_mint)` — verified
  at `028_copy_execution_lifecycle.sql:280`. Under fan-out each user has a
  distinct custodial address per chain, so the existing PK does *not* collide
  between users in **live** mode. It absolutely does in **paper** mode, where
  `resolvePaperCopyTargetAccount(chain)` returns one synthetic per-chain value —
  the exact defect ADR-0001 identified for `copy_executions`, which applies
  identically to `copy_positions` and was missed. Without this column, **every
  paper user on a chain shares one position row**: user A's buy inflates user
  B's `confirmed_quantity`, and B's proportional exit sells against A's cost
  basis. Paper is the default mode for every free-tier user, so this is the
  common path. `S4-10` must be scoped to three tables, not two.
- The `copy_positions` PK change is itself expand-and-contract and cannot be done
  in this migration (a PK swap is destructive). §5.1 sequences it.

### 5.1 Expand-and-contract sequencing (D16c/d, Standing Rule 4)

The point of expand-and-contract is that **at every instant, a rollback to the
previous release still works.** Each row below is a separate release.

| Release | Migration | Code | Rollback-safe because |
|---|---|---|---|
| R1 | `050` — add nullable `user_id`, add partial unique indexes, add indexes | none reads or writes `user_id` | Adding a nullable column and a partial index over an all-NULL column is invisible to the old code |
| R2 | none | **Dual-write**: fan-out writes `user_id` *and* `target_account` as it does today | Old code ignores `user_id`; new rows still satisfy the old `target_account` constraints |
| R3 | none | Backfill: nothing. Legacy rows stay NULL by decision | — |
| R4 | none | **Switch reads** to `user_id` for per-user queries; `target_account` still written and still constrained | Reverting to R3 code re-reads `target_account`, which is still correct and still populated |
| R5+ (later release, Stage 5 or after) | `057` contract — swap `copy_positions` PK to `(user_id, chain, token_mint)` for user rows, drop superseded `target_account` uniqueness | reads already on `user_id` | Only reached after R4 has run in production long enough to be trusted |

The dangerous step is R5, and it is deliberately outside Stage 4. Two rules make
it survivable: it ships in a release whose code does not change, and the
preceding release must have been live long enough that a rollback past it is not
being considered. **A `DROP CONSTRAINT` in the same release as the code that
stopped using it means a rollback restores code that needs a constraint the
database no longer has** — D16(d) exists for exactly this, and Stage 4 must not
be the release that violates it.

The `copy_positions` PK swap in R5 is the most delicate statement in the whole
plan: it rewrites the primary key of a table holding position quantities. It
gets its own design note when it is written, not a line in this one.

### 5.2 Ledger update

`AUDIT-FIX-CHECKLIST.md` §11 must be updated **in the same commit as each
migration file**, not afterwards — that procedural rule is the whole lesson of
the `046` collision. Stage 4 consumes `047`–`050`. The R5 contract migration
takes a number from whatever is free at the time and is recorded then; reserving
it now would repeat the collision from the other direction.

---

## 6. Deposit and withdraw (`S4-11`, `S4-12`, D11 anti-theft core)

### 6.1 Deposit (`S4-11`)

`GET /v1/me/trading/wallets` returns `{chainKind, address, qrPayload}` for each
active custodial wallet. There is no deposit *action* — the user sends funds to
an address they already own. The only requirements are that the address shown is
the one whose key we hold, and that the UI states which chains that address is
valid on.

Two failure modes worth designing against, because both are unrecoverable for
the user and neither is our transaction to reverse:

- **Wrong-chain deposit to the EVM address.** One EVM address is valid on
  Polygon and Robinhood Chain, and also on every other EVM chain — including ones
  we do not index. Funds sent on an unindexed chain are safe (we hold the key)
  but invisible: the balance poller queries configured chains only. The UI must
  name the supported chains explicitly, and a support path must exist to sweep an
  unindexed-chain deposit. This is a **product gap the checklist does not list**.
- **Depositing a token we cannot trade or price.** The poller records it, `usd`
  stays NULL, sizing ignores it. Correct behaviour, but the UI must show it as
  held-and-unpriced rather than omitting it, or the user believes the deposit was
  lost.

The address is generated at first request, not at signup — an account that never
enables trading never needs a key, and every key that exists is a key that must
be backed up and rotated forever.

### 6.2 Withdraw (`S4-12`)

```
POST /v1/me/trading/withdraw   { chainKind, asset, amount, destinationAddress }
  → 202 { withdrawalId, status: 'pending_confirmation', expiresAt }
POST /v1/me/trading/withdraw/:id/confirm   { token }
  → 200 { withdrawalId, status: 'queued' }
```

Every withdrawal passes **four independent controls**. All four, always; none is
skippable by tier, admin action, or support request.

**1. Destination allowlist — the destination must be a row in
`user_auth_wallets` for this user.** Not "an address the user typed", not "an
address they used before". The address must have been proven by a SIWE/SIWS
signature under Stage 1's `S1-9` flow, and `041_user_auth_wallets.sql`'s
`UNIQUE (chain_kind, address)` is **global**, so exactly one user can own a given
address. Stage 1 called this out as the reason for the global constraint, and
Stage 4 is where that reason pays: the question "whose address is this?" has one
answer.

`chain_kind` matching matters: an EVM withdrawal may only go to an `evm`-kind
linked wallet, a Solana withdrawal only to a `solana`-kind one. Sending Solana
funds to an address proven with an EVM signature sends them to an address nobody
controls on that chain.

**2. Email confirmation** — a single-use token, 15-minute TTL, hashed at rest
(same primitive as `user_sessions.token_hash`: SHA-256 + `timingSafeEqual`, and
the same reasoning — the token is CSPRNG output, so a slow hash buys nothing),
consumed atomically. Redis `GETDEL`, exactly as `S1-9` established for SIWE
nonces after finding that `GET`-then-`DEL` lets two concurrent requests both
observe the same value.

**3. Per-day cap** — `user_execution_settings.max_daily_withdrawal_usd`,
evaluated over a rolling 24 hours in USD. Enforced in `packages/db`, not the
route handler, and under `SELECT … FOR UPDATE` on the user row. This is the
**exact** correction Stage 2 had to make: `withTransaction` runs at **READ
COMMITTED**, so N concurrent requests each `SUM()` the pre-commit state, each
sees room under the cap, and each proceeds. Stage 2's own test fired five
concurrent subscribes against a 3-wallet quota and got **all five**. A withdrawal
cap has the same shape and a worse consequence, so it takes the same lock. Any
implementation that counts inside a transaction and calls it safe is wrong, and
this doc says so before the code is written rather than after.

**4. Audit, strictly** — `recordAuditEventStrict` (`S1-21`), which throws rather
than swallowing. `recordAuditEvent` is best-effort by design so an audit failure
cannot turn a successful login into a 500; for withdrawals the tradeoff inverts.
An unlogged withdrawal is worse than a failed one, because it is the row a
dispute turns on. Events: `custody.withdraw_requested`,
`custody.withdraw_confirmed`, `custody.withdraw_submitted`,
`custody.withdraw_failed`, `custody.withdraw_rejected` (with the failing
control named), plus `custody.wallet_generated`, `custody.key_rewrapped`,
`custody.kill_switch_set`, and `admin.withdrawal_cap_changed`.

### 6.3 Why this combination defeats account takeover — precisely

The threat model is a **complete** takeover: the attacker holds the password, a
valid session cookie, a CSRF token, and the ability to read the victim's API
responses. This is strictly stronger than what phishing or credential stuffing
usually yields, and every control below still holds.

The mechanism is that the four controls fail **independently**, and the
destination control is not authorisation-based at all:

- **The destination control is not something the session can grant.** With full
  session control the attacker can call the withdraw route, pass CSRF, and read
  the response. What they cannot do is make their own address appear in
  `user_auth_wallets`, because adding a row there requires a **signature from
  that address's private key** over a server-issued nonce bound to that address
  and to this origin (`S1-9`, `S1-22` — including the cross-domain replay case).
  Session possession is not signature possession. So a full takeover can withdraw
  *only to an address the victim already proved they control* — which is a
  transfer of the victim's funds to the victim.
  This is the load-bearing control. The others buy time and evidence.
- **Adding a destination is itself gated, and by a different secret.** The
  attacker's obvious move is to link their own wallet first. That needs the
  attacker's own keypair (they have it) *and* the `409` in `S1-20` not to fire
  (it fires if the address is linked elsewhere) — so linking succeeds. **The
  email confirmation is what stops this branch**: linking writes
  `auth.wallet_linked` to the audit log, and the withdrawal to the newly linked
  address needs a token delivered to the victim's mailbox, which the session does
  not grant access to. The attacker must compromise password **and** mailbox —
  two different providers, two different credentials.
- **A newly linked destination must age.** Since a mailbox compromise is exactly
  what a determined attacker escalates to, add a **cooling-off period: a linked
  auth wallet is not a valid withdrawal destination until 24 hours after
  `verified_at`**, and linking sends a notification email immediately. This turns
  a silent instant drain into a 24-hour window during which the victim receives
  an email about a wallet link they did not perform. `user_auth_wallets` already
  carries `verified_at`, so no schema change is needed — this is a query
  predicate. **The checklist does not specify this and it is the gap that makes
  the email control bypassable**, because email confirmation and email
  notification protect against different things: confirmation proves the mailbox
  at withdrawal time, notification tells a victim whose mailbox is *not*
  compromised that their account is.
- **The cap bounds the loss if all of the above fails.** Password, mailbox, and a
  24-hour wait still yields `max_daily_withdrawal_usd`, not the balance. Default
  1000. The cap converts total loss into bounded loss and gives the victim
  another day to notice.
- **Each control leaves a different trace.** The audit log carries the link, the
  request, the confirmation, and the submission separately, so a dispute can
  establish which control was defeated. This is also D13's immutable financial
  trail.

**What this does not defend against**, stated so it is not mistaken for
coverage: an attacker who compromises the **host** reads the master key and signs
directly, bypassing all four controls. Nothing in this section addresses that —
D10's host hardening, the executor's no-inbound-connections rule, and `S4-18`'s
custody host split are the controls there, and they are the reason those items
are not optional.

Second gap: an attacker who takes over the account can set `auto_execute` on with
`max_position_pct` at 100 and destroy the balance through *trading* rather than
withdrawal, with no email confirmation anywhere in that path. Trading losses are
not exfiltration — the attacker gains nothing — so this is vandalism, not theft,
and it is out of scope for D11's anti-theft core. But it is a real way to lose a
user's funds through a compromised account, and the mitigation is cheap:
**raising** a risk setting sends a notification email (not a confirmation), and
`auto_execute` off→on is an audited event. Recorded here because the checklist
treats settings changes as ordinary CRUD.

### 6.4 The email dependency — **not currently satisfiable**

`S4-12` requires email confirmation. **There is no email provider in this
codebase** — verified: no `nodemailer`, `sendgrid`, `postmark`, `resend`, or SES
dependency in any `package.json`, and no SMTP configuration in `.env.example`.
Stage 1 deliberately deferred it: its §8 table lists "Email delivery
(verification, password reset) — needs a provider decision; signup works without
it."

Signup works without email. **Withdrawal does not.** So Stage 4 inherits the
deferred provider decision as a hard prerequisite, and the checklist does not
list it as a task. Add it: a provider choice, a transactional-send helper, bounce
handling, and — critically — the answer to *what happens when the send fails*.
The answer must be that the withdrawal stays `pending_confirmation` and expires;
never that it proceeds because the email could not be sent. That is the
fail-closed direction, and it is the sort of default that gets written the other
way when the requirement arrives late.

Telegram already works (`alert-service`) and is tempting as a substitute. It is
not equivalent: the Telegram channel is the **operator's**, not the user's, so it
proves nothing about the user's control of a second factor. A per-user Telegram
link could serve later; it is not what D11 specified and not what a disclosure
document will describe.

---

## 7. Fan-out (`S4-13` … `S4-17`) and `DG-7`

### 7.1 Eligibility enumeration (`S4-13`)

One query, resolved in `packages/db`, run when a signal becomes trade-eligible:

```
users
  ⋈ user_wallet_subscriptions → cluster_memberships → the signal's cluster
  ⋈ user_execution_settings          (auto_execute, min_signal_score, killed)
  ⋈ user_chain_execution_settings    (mode ≠ 'off' for the signal's chain)
  ⋈ user_trading_wallets             (status = 'active', matching chain_kind)
  ⋈ user_balances                    (fresh enough, usd IS NOT NULL, ≥ minimum)
  where users.status = 'active'
    and effective tier permits live execution   -- operator+ for live, any tier for paper
    and signal.score ≥ user.min_signal_score
```

Two properties the enumeration must have:

- **Ordering must be deterministic and must not be `user_id`.** Whoever is
  enumerated first gets the better fill (§7.3). Ordering by `user_id` gives a
  permanent, invisible advantage to users whose UUID happens to sort low. Order by
  a per-signal deterministic hash of `(signalId, userId)` — stable enough to
  replay a fan-out identically, unbiased across signals.
- **Tier gating uses the *effective* tier** — an expired paid tier degrades to
  `free`, matching `requireTier` (`S1-11`), and `tier_expires_at IS NULL` means
  lifetime, never expired. A user whose subscription lapsed mid-signal must not
  execute live.

### 7.2 Job identity (`S4-14`)

One BullMQ job per `(signal, user)` on the per-chain queue from `S3-25` /
`D6`. Job id: `copy-<chain>-<signalId>-<userId>-<mode>`.

`S4-14` says "idempotent under the Stage-0 identity keys as re-keyed by S1-B5",
which is right about the database and incomplete about the queue. Two layers, and
both are needed:

- **Queue layer:** the deterministic BullMQ job id makes a redelivered or
  double-produced job a no-op at enqueue.
- **Database layer:** `uq_copy_exec_source_user_mode` from `050` is the actual
  exactly-once guarantee. The queue id is best-effort — BullMQ drops completed job
  ids after retention, so a late duplicate can get past it. Stage 3 already
  demonstrated the consequence: mutation-testing `jupiter-jito-runtime.ts` showed
  that removing the resolved-order guard "would let a redelivered queue job
  double-spend a position". The database constraint is the one that must hold.

**`S3-25` is a hard prerequisite for fan-out, and the checklist does not mark it
as one.** Its switch is deliberately OFF today — `tradeQueueForChain()` returns
the shared `swat-trades` for every chain. Fan-out multiplies queue volume by the
eligible-user count, so running it through a single queue at concurrency 1 means
one chain's venue latency serialises every other chain's users. `S4-13` should
list `S3-25` as a dependency.

### 7.3 `DG-7` — the market-impact problem

The problem is real and the numbers make it concrete. The signal-engine's
liquidity screen is `fetchDexScreenerLiquidity` compared against a fixed
`25_000` threshold (`apps/signal-engine/src/safety.ts:264-268`), and the
executor's per-chain gate is `DEFAULT_RISK_CONFIG.minLiquidityUsd` = `50_000`.
Both validate **pool depth against one order**. Neither knows how many users
will trade the signal.

So: 40 eligible users, each sized at 5% of a $10,000 balance, is $20,000 of
aggregate market orders into a pool the screen cleared at $50,000 of depth. The
first user fills near the quoted price; the last fills materially worse; and the
aggregate order may be a meaningful fraction of the pool the screen validated.
The screen was not wrong — it answered the question it was asked. Nobody asked the
aggregate question, because until Stage 4 there was only ever one order.

Polymarket has the same shape with a different mechanism: `polymarket.ts:514`
rejects an order whose required depth exceeds `maxSlippageBps`, walking the book
per order. Twenty users walking the same book sequentially each see a book the
previous user consumed, so users late in the ordering get rejected by a slippage
guard that users early in the ordering passed. **The failure is not that late
users fill badly — it is that they fill badly or not at all, unpredictably, based
on enumeration order.** That is a fairness problem before it is an execution
problem, and per D13 it is one a disclosure document has to describe honestly.

Note also that fan-out worsens each user's fill *for the platform's own reason*.
The user did not choose to trade alongside 39 others; the platform chose to fan
out. That makes the degradation an obligation the platform owns, not market risk
the user accepted.

### 7.4 Options

**Option A — aggregate into one venue order, allocate pro rata.**
One order for the summed notional; each user receives their share of the actual
fill at the blended average price.

- *Execution:* best possible. One order, one slippage event, one fee. Everyone
  gets the same price, so enumeration order stops mattering.
- *Custody:* **this is the blocker.** One order must be signed by one key, so
  the funds must be pooled — either in a platform omnibus wallet or by moving
  funds between user wallets. That is the opposite of Principle 5. It means
  per-user on-chain balances stop being the ledger, an internal ledger becomes
  authority, and the platform is holding commingled customer funds. That is a
  materially different legal object than segregated custodial wallets, and D13's
  counsel opinion would be answering a different question than the one `S4-1`
  poses.
- *Accounting:* every position becomes a claim on a pool. Partial fills need a
  pro-rata rule with a rounding policy, and the rounding dust has to belong to
  someone. `copy_positions` is keyed per account — an omnibus model needs a real
  sub-ledger, not a column.
- *Fairness:* the best of the three. Identical price for everyone.

**Option B — stagger execution with decay.**
Keep one order per user; space them (e.g. 250 ms apart) and shrink each
successive size by a decay factor, stopping when a per-signal cumulative notional
budget is exhausted.

- *Execution:* worse than A. N slippage events, N fee payments, and the last
  user's price is genuinely worse.
- *Custody:* **unchanged.** One key, one user, one order. Segregated throughout.
  This is the whole reason it is attractive.
- *Accounting:* unchanged. Every existing per-account structure keeps working.
- *Fairness:* explicitly unequal, and the inequality is quantified rather than
  emergent. Rotating who leads across signals (`hash(signalId, userId)` from
  §7.1) makes it fair *in expectation over many signals* while unfair on any
  single one. Users late in a given signal may be cut entirely when the budget
  runs out, which needs an honest name in the UI — "not executed: aggregate
  liquidity budget reached", never a generic failure.

**Option C — cap total copied notional per signal.**
A hard ceiling per signal (absolute, or a fraction of screened pool depth, e.g.
≤2%). Allocate the ceiling across eligible users; execute in parallel or
staggered.

- *Execution:* bounded impact by construction. The cap is the control the
  liquidity screen is missing.
- *Custody:* unchanged. Segregated.
- *Accounting:* unchanged, plus one allocation decision — and that decision is
  the hard part. Equal split penalises large balances; pro-rata-by-balance
  concentrates the signal in the largest accounts and makes small users' fills
  negligible; first-come-first-served is a lottery on enumeration order.
- *Fairness:* depends entirely on the allocation rule, which is a product
  decision with no technically correct answer.

### 7.5 Decision — **resolved 2026-08-07 by the operator**

**Decided: no platform cap. Option A (aggregation) remains rejected. Option C
(truncating cap) is also rejected — it was this document's recommendation and the
operator overrode it.** The reasoning below records both why A stays rejected and
why C was declined, because the second is a deliberate reversal.

- **A stays rejected, on custody rather than execution.** It has the best fills
  and is still wrong for Stage 4: pooling funds converts segregated custodial
  wallets into commingled customer funds. That changes the legal question `DG-2`
  asks, invalidates the "each user's exposure is bounded by their own deposit"
  property every risk control here relies on, and replaces on-chain per-user
  balances with an internal sub-ledger the platform would have to prove correct.
  Superior fills do not compensate for that at this stage.
- **C is declined because truncation makes the platform choose who loses.** A cap
  serves the first N users and denies the rest — including paying users, who then
  paid for a signal they did not receive. The operator's position is that this is
  a worse failure than a poor fill, and that the honest alternative is to serve
  everyone and disclose the consequence.

**What replaces the cap — three mechanisms, none of which ration:**

1. **Disclosure over promise.** The platform commits to *fastest available
   routing*, not to a price. Users are told directly that when many users copy
   one wallet, later fills land at worse prices; that this is inherent to copy
   trading rather than a platform fault; and that this style of trading is
   high-risk. The Jito bundle path (`S3-2`) is the substance behind the routing
   claim — it delivers straight to block builders instead of the public mempool,
   so it is a real mechanism, not marketing. It must be described as *how* orders
   are routed, never as a latency or price guarantee.
2. **Structural de-concentration via user-chosen targets (the load-bearing
   control).** Rather than the platform steering everyone at a few KOLs, each
   account gets a discovery dashboard: indexed top wallets per chain (Solana,
   Polymarket, and any other enabled chain), one-click copy, and a
   bring-your-own-address field so a user can index any wallet. The platform
   supplies tools; the user selects targets. **This does not mitigate
   concentration, it prevents it** — 500 users spread across many wallets never
   contend for one book. Every other mechanism here manages symptoms; this one
   removes the cause, which is why it is load-bearing for `DG-7` and not a
   later nice-to-have. If it slips, the whole decision rests on disclosure plus
   per-user slippage alone.
3. **Per-user slippage limits do the bounding the cap would have done** — a user
   whose order would fill worse than their own configured tolerance is not
   executed, not because the platform rationed them but because their own stated
   limit rejected the price. This is what makes "no cap" safe: the tail never eats
   a catastrophic fill, and the platform never decides who misses out.

   **This does not exist yet, and the gap is load-bearing.** Verified
   2026-08-07: slippage is a **hard-coded per-chain constant**, not a user
   setting — `1500` bps (15%) on the Solana paths and `300` bps (3%) on the
   Robinhood paths in `apps/trade-executor/src/index.ts`, with `150` on the
   Jupiter route. It appears nowhere in `packages/db/src/risk-policy.ts`.

   Two consequences, both material to this decision:

   - **Nothing bounds the tail today.** A 15% hard-coded ceiling on Solana is
     wide enough that a late fan-out fill can be badly degraded and still
     execute. The mechanism relied on to replace the cap is currently absent,
     which means `DG-7` as decided is not yet safe to ship.
   - **A per-chain constant cannot express user intent.** Two users with
     different risk appetites get the same tolerance, so "their own stated limit"
     is not a thing the system can honour.

   **The setting is per chain, not per user** *(operator decision, 2026-08-07)* —
   `max_slippage_bps` on `user_chain_execution_settings` (§5), which is already
   keyed `(user_id, chain)`. Tolerable slippage is a property of the venue rather
   than the person: 3% is loose on a Polymarket CLOB book and tight on a thin
   Solana memecoin, so one global value would force a user to accept the loosest
   chain's risk everywhere. `NULL` means "use the chain default" and stays
   distinct from a user-chosen value, so a default can be raised later for users
   who never set one without overwriting anyone who did. The per-chain constant
   becomes that default and **never a floor overriding a tighter user value**.

   Tracked as a Stage 4 prerequisite (`S4-P4`). Until it lands, the honest
   statement is that fan-out has no per-user downside bound.

**Still to settle (mechanics, not the policy):**

- **Ordering.** Someone fills first and someone last; this is unavoidable with
  sequential orders. Recommended: **random per signal**, so nobody is
  structurally advantaged and the explanation to a user is simply "it is random".
  Tier-priority is a legitimate alternative *if* execution priority is sold as a
  paid benefit and free-tier users are told they systematically fill later.
  FIFO-by-signup is rejected — it permanently advantages early users for no
  product reason.
- **Stagger.** Space orders by milliseconds so the book partially replenishes.
  This costs users nothing and requires no fairness trade-off; only the accepted
  latency is a question.
- **Do not scale order sizes down.** Silently reducing everyone to a fraction of
  their chosen size overrides a risk percentage the user explicitly agreed to,
  and barely helps anyway — 500 users at 40% is still a large multiple of thin
  depth.

**User-supplied addresses keep the guardrails.** Giving users target selection
does not disable per-token safety checks. A pasted address that turns out to be a
rug or a wash-trader must still be screened; "the user chose it" is thin cover
for skipping controls the platform already has.

**Aggregate measurement is still required (§7.3).** Serving everyone does not
remove the need to *measure* the aggregate — see the ratio recorded per signal
below. Disclosure of a risk whose magnitude is never computed is boilerplate: the
platform would be warning that fills "may be worse" with no idea whether that
means 0.5% or 400% on a given signal, while the liquidity screen reports green
either way.

**Why this must still be a human decision.** Every option trades execution
quality against fairness against operational complexity, and the weights are
product and legal judgements, not technical ones:

1. **The cap number is a business choice.** "≤2% of screened depth" is a
   plausible starting figure with no derivation behind it. Too low and paying
   users are systematically excluded from signals they subscribed to receive; too
   high and the impact problem persists. It needs either an operator's judgement
   or an empirical study using Stage 3's paper-mode fills.
2. **Truncation means some paying users do not get some trades.** That is a
   product promise being narrowed. It has to be in the ToS and the UI before it
   is in the code, and `S4-1`'s counsel review is the right place for it.
3. **A may be right later.** At scale, aggregated execution is materially better
   for users, and a licensed, audited omnibus structure is how real brokers
   operate. That is a deliberate business and regulatory step, taken with
   counsel — not a refactor.
4. **Rotating leadership is fair in expectation but not per signal.** Whether
   "fair over many signals" is an acceptable promise is a disclosure question.

**What Stage 4 should build regardless of which option is chosen**, because all
three need it and none of it prejudges the decision:

- A per-signal **aggregate notional ledger** — how much has been committed
  across all users for this signal — recorded transactionally with each
  execution claim. Every option needs this number; A allocates against it, B
  stops at it, C caps it. Without it, the decision cannot be implemented in any
  form.
- A **`not_executed` reason** on the fan-out path, distinct from `failed`. A user
  who was skipped because a budget was exhausted did not have a failed trade, and
  recording it as one corrupts their expectancy statistics and the breaker's
  failure count. This matters immediately: `recordCopyEligibilityRejection`
  already exists with a `reasons: string[]` shape (`packages/db/src/copy-eligibility.ts:143`)
  and is the right home for it.

Until `DG-7` is decided, fan-out ships **paper-only** (`S4-17`'s platform gates
already enforce that in the absence of certifications). Paper mode does not
consume real liquidity, so the exit gate — "paper-mode fan-out proven for
multiple users on one signal with disjoint sizing" — is reachable with `DG-7`
still open. **Live fan-out is not.**

### 7.6 Sizing (`S4-15`) and per-user risk state (`S4-16`, `S4-17`)

`calculateBalanceAwareSize` (`apps/trade-executor/src/policy.ts:67`) already
takes `balance`, `base`, `maximum`, `riskPct`, `tierMultiplier`,
`scoreMultiplier`, `precision`, `dynamic` — all values, no globals. Verified: it
needs no signature change. What changes is where its inputs come from:

| Input | Today | Under fan-out |
|---|---|---|
| `balance` | `getAvailablePositionBalance` → `PAPER_BANKROLL_USD` env, or the operator wallet's on-chain balance via `TROJAN_WALLET_ADDRESS` (`index.ts:422-467`) | that user's `user_balances` row, staleness-gated |
| `riskPct` | `resolveRiskPolicy('operator', chain).maxPositionPct`, applied only in the paper branch (`index.ts:481-490`) | `user_execution_settings.max_position_pct` |
| `maximum` | `getSizingConfig(chain, sizingMode)` env-derived | min(env ceiling, user daily-exposure headroom) |

Three defects in the current sizing path that fan-out turns from cosmetic into
material, all verified by reading `apps/trade-executor/src/index.ts`:

1. **The DB policy override is paper-only.** `getBalanceAwarePositionSize`
   resolves `resolveRiskPolicy` and overrides `config.riskPct` **inside
   `if (sizingMode === 'paper')`** (line 481). In live mode the env-derived
   `riskPct` is used and the DB policy is ignored for sizing. Today that is
   survivable because there is one operator whose env and DB agree. Under
   fan-out the per-user risk percentage is *only* in the database, so live
   sizing would silently ignore every user's stated risk and use one env value
   for everyone. **This branch must be removed, not extended.**
2. **The override is `(config as any).riskPct = policy.maxPositionPct`**
   (line 484) — a mutation through an `any` cast, defeating the `readonly`-by-
   convention shape the return type describes.
   **This is *not* a cross-user leak, and it is worth being precise about why,
   because the opposite conclusion is the easy one to reach.** `getSizingConfig`
   (line 379) returns a **fresh object literal on every call** — each `if (chain
   === …)` branch constructs a new one. So the mutation is confined to the single
   call that made it; user A's `riskPct` cannot survive into user B's sizing.
   The defect is a maintenance hazard, not a money bug: the `any` cast means the
   compiler will not stop someone from later hoisting that config to a
   module-level constant or a memo cache for performance — at which point the
   mutation silently *becomes* a cross-user leak with no type error and no test
   failure. `S0-3` already tracks eliminating `any`. Fix by having sizing accept
   an explicit per-call `riskPct` parameter rather than mutating a config object,
   which removes the cast and forecloses the hazard.
3. **Policy-resolution failure falls back to env defaults with a
   `console.warn`** (lines 486-489). For an operator, defaulting is reasonable.
   For a user, it silently substitutes a risk percentage they did not agree to.
   Per Principle 3 this must fail closed: no resolvable user policy → no trade.

`S4-16` is right that the **breaker, stop-loss, and eligibility machinery ride
unchanged** — `readCircuitBreakerState(account, chain)` keys Redis/DB state as
`breaker:${account}:${chain}` (`circuit-breaker.ts:37`), and passing a UUID
instead of `'operator'` yields per-user isolation with no code change. That is
Standing Rule 2 paying off exactly as ADR-0001 predicted.

`S4-17`'s platform clamp must be applied by **resolution order**, not by a final
check. The mode a user's trade executes in is
`min(platform_mode(chain), user_chain_mode)` where `off < paper < live`, computed
in one function that takes the platform resolution from
`resolveChainMode(chain)` (`packages/db/src/execution-config.ts:194`) and the user
row together. A structure where the user's mode is read first and the platform
gate is consulted afterwards is one refactor away from someone returning early.

---

## 8. `account` → user id: verified call-site inventory

`AUDIT-FIX-CHECKLIST.md` §1 claims "`account: string` is threaded through
`resolveRiskPolicy`, `circuit-breaker`, `stop-loss`, and `copy-eligibility`.
Every caller passes the literal `'operator'`, so per-user risk is a
value-substitution exercise, not a signature rewrite."

**Verified true for the four modules' signatures.** Read directly:

| Module | Signature | Where `account` lands |
|---|---|---|
| `packages/db/src/risk-policy.ts:78` | `resolveRiskPolicy(account: string, chain: Chain)` | in-memory cache key `${account}:${chain}` (line 27) — **not persisted** |
| `packages/db/src/circuit-breaker.ts:92,105,142,167` | `(account: string, chain: Chain, …)` on all four entry points | key string `breaker:${account}:${chain}` (line 37) |
| `packages/db/src/stop-loss.ts:54,97` | `account` on `claimStopLossTrigger` input and `releaseStopLossTrigger(account, signalId)` | `signal_stop_losses.account` — `VARCHAR(64) NOT NULL DEFAULT 'operator'`, PK `(account, signal_id)` |
| `packages/db/src/copy-eligibility.ts:34,149` | `account` on `CopyEligibilityRejection` | `copy_eligibility_rejections.account` — `VARCHAR(64) NOT NULL DEFAULT 'operator'`, PK `(account, signal_id)` |

A UUID is 36 characters, so both `VARCHAR(64)` columns hold one with room to
spare. **No migration is needed for either.** The `DEFAULT 'operator'` stays and
keeps meaning "the legacy single-operator row", exactly like `user_id NULL` on
`trades`.

### Call sites that change (all verified)

| File:line | Today | Becomes |
|---|---|---|
| `apps/trade-executor/src/index.ts:430` | `resolveRiskPolicy('operator', opts.chain)` | per-user; see §7.6 defect 1 — the whole paper-only branch goes |
| `apps/trade-executor/src/index.ts:482` | `resolveRiskPolicy('operator', chain)` | per-user, and **must apply in live mode too** |
| `apps/trade-executor/src/index.ts:804,807,809,822,825,839` | six `'operator'` literals across `readCircuitBreakerState`, `claimCircuitBreakerProbe`, `recordCircuitBreakerSuccess`, failure recording | the job's `userId` |
| `apps/trade-executor/src/copy-eligibility.ts:23` | `export const COPY_ELIGIBILITY_ACCOUNT = 'operator'` | a per-job value; the constant becomes the legacy fallback only |
| `apps/trade-executor/src/index.ts:1242` | `account: COPY_ELIGIBILITY_ACCOUNT` | the job's `userId` |
| `apps/scorer/src/stop-loss.ts:14,85` | `STOP_LOSS_ACCOUNT = 'operator'`; `dependencies.account ?? STOP_LOSS_ACCOUNT` | **see the correction below** |
| `apps/trade-executor/src/reconciliation-coordinator.ts:24,87` | `RECONCILIATION_ACCOUNT = 'operator'` | **unchanged** — see below |

### Two corrections to the "value substitution" claim

**1. The stop-loss sweep needs a signature change, not a value substitution.**
`runStopLossSweep` resolves **one** account for the entire sweep
(`apps/scorer/src/stop-loss.ts:85`: `dependencies.account ?? STOP_LOSS_ACCOUNT`)
and then loops over `dependencies.positions` (line 96), which arrive from
`markToMarketOpenPositions()` — a **global** query over all open positions
(`apps/scorer/src/index.ts:137`). Under fan-out, positions in that list belong to
different users. Passing one `account` for the whole sweep means every user's
stop-loss trigger is claimed under one key, so `signal_stop_losses`'s
`PRIMARY KEY (account, signal_id)` — which exists precisely as the exactly-once
guard — admits **one** claim per signal across all users. The first user to
breach claims it; every other user holding that position is recorded as
`alreadyTriggered` and **never sold**.

That is a stop-loss silently not firing on a real position, which is the specific
failure `B3`/`S0` built this table to prevent. The fix: `account` moves from the
sweep's dependencies onto each `OpenPositionSnapshot`, derived from the
position's owner. The signature changes; the guarantee does not.

Two consequences follow. `resolvePolicy` is currently passed once per sweep and
must become per-position (each user has their own `stop_loss_pct`). And
`markToMarketOpenPositions()` must return the owner, which it can only do after
`050` adds `user_id` to `copy_positions` — so **the stop-loss change is
sequenced after `050`, not before.**

**2. `RECONCILIATION_ACCOUNT` stays `'operator'` and must not be substituted.**
`apps/trade-executor/src/reconciliation-coordinator.ts:57` carries a comment
recording that `target_account` is a chain-prefixed wallet address, so matching
it against `'operator'` would claim zero rows — which is why the coordinator
scopes by chain and treats `account` as "a logical escalation label only". It is
not a tenancy key there. Substituting a user id would make the escalation label
per-user, fragmenting one operational alert stream into N, and would not scope
anything, because the coordinator does not filter on it. Reconciliation is a
platform function over all users' ambiguous executions; leave it alone. The
checklist's blanket "substitute the user key for `'operator'`" would get this
wrong if applied mechanically.

### One more that is not on anyone's list

`resolveRiskPolicy`'s cache is a **module-level `Map` keyed
`${account}:${chain}`** with a TTL (`risk-policy.ts:20-28`). With one operator
and three chains it holds 3 entries. With N users it holds N×3 and never evicts
by size — only by TTL on read. That is an unbounded in-process map keyed by user
id, in the process that holds the master key. It needs a bounded LRU or a
TTL sweep before fan-out, and it is a memory-growth bug rather than a
correctness bug, which is why nothing catches it until it matters.

---

## 9. Test plan

Gate for the stage: `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm test:integration`, plus the two scans in §9.4 which are **new CI steps**.

### 9.1 Unit — `packages/custody`

- Seal → open round trip for both chain kinds; the opened key derives the same
  address the seal returned.
- **Wrong AAD fails.** Seal under `(userA, evm, 1)`, attempt to open under
  `(userB, evm, 1)` → auth-tag error, not a wrong key. This is the cross-user
  swap defence from §3 and it must be asserted, not assumed.
- Tampering with any envelope field (ciphertext, IV, tag, wrapped data key) fails
  to open. GCM should catch all four; the test proves the tag is actually being
  verified rather than parsed and discarded.
- Version prefix: a `v2` blob handed to a `v1`-only parser errors explicitly and
  names the version.
- `wrapperId` mismatch: a blob marked `env:v1` handed to a wrapper whose id is
  `kms:v1` is refused **before** any decrypt attempt.
- `NullWrapper` throws on both `wrap` and `unwrap` — it does not pass through.
- **Key rotation:** seal under `env:v1`, rotate to `env:v2`, the row opens; the
  private-key ciphertext bytes are **byte-identical** before and after (proving
  the private key was never decrypted during rotation — D-S4-B's whole claim).
- Rotation is resumable: interrupting it leaves a mixed `v1`/`v2` set where every
  row still opens.
- `EnvMasterKeyWrapper` refuses a master key of the wrong length, and refuses a
  key that is present but whitespace-padded or hex where base64 was expected
  (D-S4-E).
- **The signer never returns key material.** `Object.keys`, `JSON.stringify`, and
  a deep property walk over a `CustodialSigner` yield nothing that decodes to the
  private key. This is the property `S4-5` claims and the one review cannot
  guarantee.

### 9.2 Unit — sizing, settings, gating

- Sizing with a NULL `usd` balance refuses rather than sizing to zero.
- Sizing with a stale balance refuses and requests a refresh.
- **Sizing isolation across users (§7.6 defect 2):** size for user A at 2%, then
  user B at 10%, then A again — A's second size must use 2%. This **passes on
  today's implementation**, because `getSizingConfig` returns a fresh object
  literal per call. It is written as a *pin*, not as a failing test: it locks in
  the property that makes the `as any` mutation safe, so that hoisting that
  config to a module constant or memo cache later turns red here instead of
  silently mispricing a user's position.
- Live-mode sizing uses the DB policy (§7.6 defect 1) — a test that fails on
  today's paper-only branch.
- Policy-resolution failure produces no trade, not a default-risk trade
  (§7.6 defect 3).
- Mode clamp: platform `paper` ∧ user `live` → `paper`. Platform `off` ∧ user
  `live` → `off`. Uncertified chain ∧ `LIVE_ENABLED_CHAINS` includes it ∧ user
  `live` → `paper` (both gates required, `resolveChainMode`).
- `049` DDL defaults equal `DEFAULT_RISK_CONFIG` (`constants.ts:66`) — a test
  that reads both and compares, so the duplicated literals cannot drift.
- Free tier + `mode = 'live'` → clamped to paper (tier gate, `S2-3` matrix).

### 9.3 Integration — adversarial withdrawal (`tests/integration/`)

Each of these is an attack, written as one. The suite is **mutation-tested**:
deleting each control in turn must turn it red, following the precedent set by
`S1-16` (deleting `WHERE user_id = $1` from `listAuthWallets`), `S3-4`
(the resolved-order guard), and `S3-18` (`NULLS NOT DISTINCT`). A green
withdrawal suite that cannot fail is worse than none, because it licenses the
assumption it never checked.

1. Withdraw to an address that is **not** in `user_auth_wallets` → rejected.
2. Withdraw to an address linked to **another** user → rejected. (Global
   `uq_auth_wallet` makes this unambiguous.)
3. Withdraw to a `solana`-kind linked wallet from an `evm` custodial wallet →
   rejected on `chain_kind` mismatch.
4. Withdraw to a linked wallet verified **less than 24 hours ago** → rejected
   (§6.3 cooling-off).
5. Confirm with a token belonging to a **different** withdrawal → rejected.
6. Replay a confirmation token → second attempt rejected (`GETDEL`, the `S1-9`
   lesson).
7. Confirm after expiry → rejected.
8. Confirm from a **different user's** session → rejected.
9. **Concurrency:** ten simultaneous withdrawals whose sum exceeds the daily cap
   → the total submitted is ≤ cap. This is the Stage 2 `FOR UPDATE` test in a
   money context, and it must be written to fail against a naive
   count-inside-a-transaction implementation.
10. Cap arithmetic uses a rolling 24 hours, not calendar days — a withdrawal at
    23:59 and another at 00:01 both count.
11. `killed = true` blocks withdrawal **and** execution.
12. Every rejection writes an audit row naming the failing control; an audit
    write failure aborts the withdrawal (`recordAuditEventStrict`, `S1-21`).
13. Full-takeover simulation: a test holding a valid session + CSRF token for the
    victim **cannot** move funds anywhere but the victim's own aged, linked
    wallet. This is §6.3's claim as an executable assertion.

### 9.4 Custody-key containment scans — **two new CI steps**

The exit gate says "custody keys never observed outside trade-executor (log and
API scan)". That has to be mechanical, because it is a property of *all* output,
not of the paths anyone thought to check.

**Scan 1 — static.** Extends `scripts/check-public-secrets.mjs`, which already
runs in CI *before* typecheck so it fails fast (`S1-16`). New assertions:
`packages/custody` is not imported by `apps/api`, `apps/web`, `apps/indexer`,
`apps/scorer`, `apps/signal-engine`, `apps/alert-service`, or `apps/discovery`
**except** for the `generateCustodialWallet` export in `apps/api`; and
`CUSTODY_MASTER_KEY` appears in no `.env.example` service block other than
trade-executor's.

**Scan 2 — runtime.** Generate a keypair whose private key is a known 32-byte
sentinel. Drive a full paper fan-out execution with stdout/stderr captured, then
assert the sentinel appears in no log line, no `trades` row, no `audit_log`
`metadata` blob, no API response body, no BullMQ job payload, and no Telegram
alert payload — in hex, base64, base58, and JSON-array encodings. **Checking one
encoding is the mistake this test exists to avoid**: a Solana key logged as a
`Uint8Array` serialises to `[12,45,…]` and matches no hex grep. Then repeat with
a deliberately planted `console.log(privateKey)` and assert the scan **fails** —
mutation-testing the scanner itself.

### 9.5 Integration — fan-out and tenancy

- Migrations `047`–`050` replay twice cleanly (`migrations.test.ts` precedent).
- One signal, three eligible users with different balances and risk percentages →
  three executions with **three different sizes**, each ≤ that user's cap.
- One signal, one ineligible user (auto-execute off / chain off / tier / balance
  below minimum / `killed`) → no job, and a recorded reason distinguishable from
  a failure.
- Redelivering a fan-out job → `uq_copy_exec_source_user_mode` admits exactly
  one row. Written to fail if the index is made non-partial or dropped.
- **Paper-mode position isolation:** two paper users on the same chain and token
  → two `copy_positions` rows. Written to fail against the current PK, since this
  is the defect §5's `050` note identifies.
- Breaker isolation: tripping user A's breaker on a chain leaves user B
  executing. (Extends `S0-2`'s multi-process requirement with a tenancy
  dimension.)
- Stop-loss isolation: two users hold the same signal's position and both breach
  → **two** claims, two sells. Written to fail against today's single-account
  sweep (§8 correction 1).
- Extend `tests/integration/cross-tenant.integration.test.ts` to every new
  `/v1/me/trading/*` route: user A cannot read B's wallets, balances, settings,
  or withdrawal history; the tenant-less legacy service key is refused on all of
  them.
- Custody-key non-exposure: `GET /v1/me/trading/wallets` returns `address` and no
  field whose value is or decodes to key material.

### 9.6 Staging demonstration (exit gate, cannot be closed by unit tests)

- Paper fan-out across ≥3 users on one signal, disjoint sizing, observed
  end to end.
- **Vault Transit migration path demonstrated:** on staging, seal under
  `EnvMasterKeyWrapper`, flip the active wrapper, run the re-wrap sweep to
  `VaultTransitWrapper`, confirm only `vault:v1` rows remain and that every wallet
  still signs — the full `docs/runbooks/custody-vault-migration.md` procedure,
  including its §6 verification and a §8 rollback rehearsal. Rehearsing this on
  staging is the point: the production run happens with real custodied funds, and
  the sweep is the step that must be known-resumable before then.
  Staging holds no *production* master key (D2); it holds a staging-only key and a
  staging-only Vault for this purpose, and that distinction must be written into
  the staging runbook or D2's third lock erodes by accident.
- `S0-2`'s two-process risk acceptance re-run with two distinct user accounts.

---

## 10. Deliberately deferred

| Item | Why |
|---|---|
| **Keypair rotation** (new address per user, funds moved on-chain) | Needs gas, an on-chain sweep, reconciliation, and a policy for dust left behind. `user_trading_wallets.key_version` and the partial unique index make it possible without a schema change later. **Wrapper** rotation (§4) is built now; **keypair** rotation is not. |
| Hardware security module / MPC signing | `KeyWrapper` covers the KMS step. MPC changes the signing model, not the wrapping model, and is a `DG-3` vendor question. |
| `VaultTransitWrapper` as production default | Built and demonstrated on staging at Stage 4; production cutover is gated on the threshold now named in `docs/adr/0002-custody-key-store.md` — USD 50,000 custodied or 100 funded users — and enforced by `S4-P5`. |
| Turnkey / Privy vendor evaluation (`S4-6`, `DG-3`) | Must complete **before design freeze**, not before this doc. The binding constraint is raw-signing support for Polymarket L2 credential derivation — `S3-20` derives credentials as a function of an EVM signer, and a vendor that only signs transactions cannot produce them. |
| Dedicated custody host split (`S4-18`, D5 step 2) | Operational, not code. The `packages/custody` boundary is what makes it a deployment change rather than a refactor, and that boundary lands now. |
| Mandatory 2FA on custody accounts | Stage 1 §8 flagged it as "reconsider as mandatory at Stage 4". Deferred **only** because §6.3's destination allowlist already defeats session-only takeover. If email confirmation is ever weakened, this stops being deferrable. |
| Aggregated/omnibus execution (`DG-7` Option A) | Rejected for Stage 4 on custody grounds (§7.5). Revisit with counsel if execution quality becomes the binding constraint. |
| Per-user Polymarket geo-gate implementation | Specified by D13/`S4-1`; the gate is legal, and the enforcement point (Cloudflare + a per-user check) is designed once counsel states the rule. |
| Hard user deletion | Still blocked by the D13 financial trail, and now also by `047`'s `ON DELETE RESTRICT`. Soft delete only. |
| Withdrawal to a non-linked address under manual review | An escape hatch is exactly the control an attacker would target via support. If it is ever added, it needs its own threat model, not an exception to §6.3. |
| Cross-chain balance aggregation for sizing | Sizing reads the balance on the chain being traded. Summing across chains would let a Solana balance authorise a Polygon position the user cannot fund. |
| `resolveRiskPolicy` cache eviction by size | §8 flags it. It is a memory-growth issue, not a correctness one; a bounded LRU lands with fan-out but does not gate the design. |


