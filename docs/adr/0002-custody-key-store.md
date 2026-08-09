# ADR-0002 — Env master key now, separate-host Vault at a written trigger

- **Status:** **Superseded for user private keys** by
  `docs/adr/0003-delegated-execution-authority.md` (2026-08-09). **Still accepted,
  narrowed**, for the operator Solana key and the SOPS age key.
- **Date:** 2026-08-07 · **Narrowed:** 2026-08-09

> **Read this first.** WAKE no longer custodies user private keys. Users grant
> scoped, revocable, expiring authority per chain (ADR-0003), so the master key
> below no longer wraps anything whose loss costs a user their funds.
>
> What survives here: the **operator** Solana key (`SOLANA_PRIVATE_KEY`) and the
> **SOPS age key** are still live secrets, and the separate-host argument in §2
> still applies to them. The Shamir 3-of-5 escrow in `DG-8` still covers those two.
>
> What is retired: the USD 50,000 / 100-funded-user migration trigger and its code
> enforcement (`S4-P5`), and the unwrapped-data-key cache (`S4-P6`) — both existed
> to time-limit an exposure that no longer exists. They return **only** under
> ADR-0003 §6 fork (b), scoped to Polymarket.
- **Decision gate:** `DG-8` (store, threshold, and share format decided; **who holds the shares** and the rehearsal cadence remain open)
- **Blocks:** Stage 4 custody (`S4-2` … `S4-6`)
- **Supersedes:** nothing. Extends `docs/plans/stage-4-design.md` §3–§4.

## Context

Custody uses envelope encryption: each user's private key is sealed under its own
data key, and every data key is wrapped by one **master key**. Where that master
key lives is the whole security question.

Two properties are in tension:

1. **Compromise blast radius.** The trade-executor is the most exposed process in
   the system — it consumes a job queue, parses venue API responses, and carries
   the most third-party dependencies. If the master key sits in that process's
   environment, root on that host means every user's private key, decryptable
   offline, permanently, after the intruder is evicted.
2. **Operational cost and latency.** A separate key-management host is another
   machine to run, patch, monitor and unseal, and it puts a network round trip in
   the execution path of a latency-sensitive product.

`S4-4` already defines a `KeyWrapper` interface (`wrap`/`unwrap`, async, taking an
encryption-context map) precisely so the backing store is swappable. The interface
is Vault- and KMS-shaped from the start even though the env implementation needs
neither async nor context.

## Options considered

**A. Separate-host Vault (or OpenBao) from day one.** Strongest posture. The
master key never exists in the executor's memory or environment; an executor
compromise yields a time-bounded, audited *unwrap oracle* rather than the key
itself. Costs a second hardened host before Stage 4 can ship, and couples live
trading to Vault's uptime and unseal state.

**B. Vault on the same host as trade-executor.** Rejected. It buys Vault's
*operational* benefits — audit log, rotation, no plaintext key in env — while
surrendering almost all of its *security* benefit, because root on the host reads
Vault's memory, storage, unseal material and AppRole token alike. Container or
systemd isolation raises the bar without moving the boundary. This is the option
that looks like A and delivers close to C, for more work than C.

**C. `EnvMasterKeyWrapper`, SOPS-encrypted, on the hardened host.** Lowest cost,
ships now, and carries exactly the blast radius described above.

## Decision

**C now, A at a written trigger.**

`EnvMasterKeyWrapper` is the Stage 4 production wrapper. Migration to separate-host
Vault is mandatory on first crossing **either**:

- **USD 50,000** total custodied value across all `user_trading_wallets`, or
- **100 users** with a non-zero custodied balance.

Whichever comes first. On crossing, migration happens **before onboarding further
users**.

### Why a trigger rather than a preference

Without a number written down, this is not a staged plan — it is "env key
indefinitely" with an optimistic story attached. The migration never feels urgent,
because there is always a feature with a clearer deadline, until the balance is
large enough that the migration itself is frightening precisely because it touches
every user's funds.

The thresholds are deliberately low. Both are early enough that migrating is a
boring afternoon, and late enough that the second host is not being stood up for
three test accounts.

### Why the trigger is enforceable rather than aspirational

A number in a document is a hope. `S4-P5` (below) makes it a check: a scheduled job
computes both figures, and crossing either raises a **blocking operational alert**
and sets a flag that refuses new custodial wallet creation until the wrapper id is
`vault:*`. The system stops onboarding rather than quietly continuing.

## Consequences

**Accepted risk, time-limited.** Between now and the trigger, a full compromise of
the trade-executor host means permanent, total loss of custodied funds. That is a
defensible trade at USD 50k spread across ≤100 users and an indefensible one at
USD 2M. The trigger is what keeps the trade in the range where it is defensible.

**Two secrets, not one, must survive.** Per `D-S4-D`, the master key lives in a
SOPS-encrypted env file whose age private key lives on the host. Losing *either*
is equivalent to losing the master key. Both need the same escrow discipline, and
`DG-8`'s open question covers both.

**Nothing about the interface changes at migration.** `SealedKey` already carries
its wrapper id, both wrappers stay registered during cutover, and re-wrapping is
expand-and-contract applied to ciphertext (design doc §3.2). The migration is a
config change plus a resumable sweep — see `docs/runbooks/custody-vault-migration.md`.

**The private keys are never decrypted during migration.** Only the small wrapped
data keys are re-wrapped, which is the property per-key data keys were chosen for
(§3.1). A crash mid-sweep leaves a mix of `env:v*` and `vault:v*` rows that both
open correctly — not a partially decrypted set.

**Live trading gains a dependency at migration, not before.** Once on Vault, a
sealed or unreachable Vault means no live trade can execute, because no key can be
unwrapped. Paper mode is unaffected. This is correct fail-closed behaviour and
must be understood before the switch, not discovered during an outage.

**Vault call frequency is per-user-per-trade, not per-signature.** Signing happens
locally with an unwrapped key; a Solana trade needs two signatures (swap and tip)
and one unwrap. Sizing is therefore driven by *concurrent* unwraps during a
fan-out burst, not by trade volume — and requires the bounded cache in `S4-P6`.

## Escrow — decided 2026-08-07

**Shamir 3-of-5, SLIP-39 mnemonic format, applied to both secrets.**

Any 3 of 5 shares reconstruct the secret; any 2 reveal **mathematically nothing** —
not a partial key, zero information. That is the property that makes Shamir the
only listed option to improve loss- *and* theft-resistance at once: every
"keep N copies" scheme trades one against the other, since each additional copy is
another thing to steal. Raising the share count does the opposite.

3-of-5 specifically: an attacker needs three separate compromises, and you survive
losing two shares — a destroyed drive, a lost envelope, an unreachable holder.
Lower thresholds are fragile; higher ones make recovery painful enough that the
rehearsal gets skipped and the procedure is found broken when it matters.

**Format: SLIP-39 mnemonic** (`shamir-mnemonic`, SatoshiLabs) — 33 words per share
for a 256-bit secret, from a 1024-word list. Chosen over hex or `ssss` because
shares are transcribed by hand, and SLIP-39 is **checksummed**: a mis-copied word
is caught when a share is validated rather than on the day it is finally needed.
Its wordlist also has no `0`/`O` or `1`/`l` ambiguity, and every word is unique in
its first four characters.

Two operational requirements that are not optional:

- **Record the tool and version with the shares.** Shamir is not a single
  interoperable format; a SLIP-39 share will not open with `ssss`. Five envelopes
  and no record of what produced them are worth nothing.
- **Label share indices.** Reconstruction fails without them even with all five
  present.

**Both secrets are split, not one.** Per `D-S4-D`, the master key and the SOPS age
key must both survive — losing either is equivalent to losing the key.

**Share locations are held out of band and are deliberately absent from this
repository.** Recording them here would place the map to customer funds in the
same artefact as the code that guards them.

## Open

`DG-8` remains open on the parts 3-of-5 does not settle: **who** holds the shares
(the threshold is not the same question as whose hands they are in), whether
recovery is rehearsed annually against a throwaway key rather than the live one,
and rotation cadence. Vault relocates this to its unseal shares rather than
removing it, so the answers are required for either wrapper.

## Follow-on tasks

- `S4-P5` — enforce the trigger in code (measurement job, alert, onboarding halt).
- `S4-P6` — bounded, swept cache of unwrapped data keys.
- `docs/runbooks/custody-vault-migration.md` — the migration procedure.
