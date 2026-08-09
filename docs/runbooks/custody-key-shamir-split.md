# Runbook — splitting a custody secret into Shamir 3-of-5 shares

> **NARROWED 2026-08-09** by `docs/adr/0003-delegated-execution-authority.md`.
> There is no longer a *custody master key* wrapping user private keys, so the
> highest-stakes application of this procedure is gone. It stays **live and unchanged**
> for the two secrets that still exist: the **operator Solana key** and the **SOPS age
> key**. Losing either still costs real money or locks every encrypted config, so the
> escrow requirement is undiminished for them — only its blast radius shrank.
> Unlike `custody-vault-migration.md`, this runbook is **not** parked.

**Decision:** `docs/adr/0002-custody-key-store.md` §Escrow (narrowed), ADR-0003 §7
**Applies to:** the **operator Solana key** and the SOPS age key — both, separately.
~~the custody master key~~ — retired with ADR-0003.
Per `D-S4-D` losing either is equivalent to losing the key, so a scheme applied to
only one of them protects nothing.

Do this **before** custody holds any real funds, and again for every new key
version created by rotation (`D-S4-B`).

---

## Why 3-of-5

Any 3 shares reconstruct the secret. Any 2 reveal **mathematically nothing** — not
a partial key, zero information. That is the whole point: every "keep N copies"
scheme makes loss harder and theft easier at the same time, because each copy is
another thing to steal. Shamir improves both at once.

3-of-5 means an attacker needs three separate compromises, and you survive losing
two shares.

---

## 1. Prepare an offline machine

Share generation must not happen on a networked host, and the plaintext secret must
not touch a disk that persists.

- Boot a live USB (Tails, or any live Linux) with **networking disabled**.
- Do not mount the internal drive.
- Nothing generated in this procedure gets saved to a file. Shares are transcribed
  by hand and the machine is powered off afterwards.

If that is impractical, the minimum acceptable substitute is an air-gapped machine
you control that is wiped afterwards. A laptop that later goes back on the internet
with the shell history intact is not acceptable.

---

## 2. Install the tool

```bash
pip install shamir-mnemonic
```

**Record the exact version.** Shamir is not one interoperable format — a SLIP-39
share will not open with `ssss` or any other implementation. Five envelopes with no
record of what produced them are worth nothing.

```bash
pip show shamir-mnemonic | grep -E '^(Name|Version)'
```

That name and version go on every share, in writing.

---

## 3. Split the secret

The master key is 32 bytes. Feed the tool its **raw hex**, not the base64 form that
appears in the env file — decode first, and be certain which you are holding.

```bash
# Interactive: the tool prompts for the master secret as hex.
shamir create 3of5
```

For scripted use the equivalent is `shamir-mnemonic`'s `generate_mnemonics(1, [(3, 5)], secret_bytes)`.
Either way the output is five groups of **33 words** (for a 256-bit secret):

```
Share 1: shadow academic acid alpha branch ...
Share 2: shadow academic agency crunch device ...
...
```

The first two words repeat across shares by design — they encode the share
identifier and group parameters, not secret material.

---

## 4. Transcribe

For each of the five shares, write on durable media:

- [ ] **Share index** (1–5). **Reconstruction fails without it**, even with all
      five in hand. This is the most common way a Shamir backup dies.
- [ ] All 33 words, in order, legibly.
- [ ] Which secret it is — `CUSTODY_MASTER_KEY_V1` or `SOPS_AGE_KEY`. You will have
      two sets of five and they are not interchangeable.
- [ ] Tool name and version from §2.
- [ ] Threshold: `3 of 5`.
- [ ] Date.

Steel plates outlast paper and survive fire and water. Paper in a sealed envelope is
acceptable; a printout is not — printers retain spool files.

---

## 5. Verify *before* destroying the original

**Do not skip this.** It is the only point at which a transcription error is
recoverable.

On the same offline machine, reconstruct from **three shares you have not yet
used together**, reading from your written copies rather than the screen:

```bash
shamir recover
```

- [ ] The recovered secret matches the original **byte for byte**.
- [ ] Repeat with a *different* set of three. Two successful reconstructions from
      disjoint triples prove more than one lucky attempt.
- [ ] Confirm any **two** shares fail — the tool should refuse rather than return
      something wrong.

SLIP-39 is checksummed, so a mis-copied word is caught here rather than on the day
you actually need it. That is the reason this format was chosen over hex.

---

## 6. Distribute and clear down

- [ ] Shares go to five locations with **genuinely different failure modes** — not
      five places one burglary or one flood reaches. Locations are held out of band
      and are deliberately **not** recorded in this repository; writing them here
      would put the map to customer funds beside the code that guards them.
- [ ] Power off the offline machine. If it was a live USB, the RAM-only session is
      gone; if it was a persistent air-gapped host, wipe it.
- [ ] Confirm the plaintext secret exists nowhere except the SOPS-encrypted env file
      and the five shares.

---

## 7. Annual rehearsal

An untested recovery procedure is a hope, not a plan.

Once a year, reconstruct from three shares — **against a throwaway key with
disposable funds, never the live master key.** Testing on the real key means the
real key transits a laptop, which is the exact exposure this whole scheme exists to
prevent.

The rehearsal is checking three things, only one of which is cryptographic:

- The shares are still legible and still present.
- Every holder is still reachable and still knows what they hold.
- You still remember the procedure.

Schedule it, or it will not happen.

---

## 8. When rotation creates a new key version

`D-S4-B` rotation produces `CUSTODY_MASTER_KEY_V2` alongside `V1`. That new version
needs its own 3-of-5 split, and this whole runbook repeats.

**Do not destroy `V1`'s shares when `V2` is created.** Rows sealed under `env:v1`
still name `v1` in their `sealed_key`, and they open only under that version.
Destroy a version's shares only once a re-wrap sweep confirms **zero** rows
reference it:

```sql
SELECT count(*) FROM user_trading_wallets
WHERE status = 'active' AND sealed_key LIKE 'v1.env:v1.%';
```
