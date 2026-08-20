# Runbook — migrating custody from `EnvMasterKeyWrapper` to separate-host Vault

> **PARKED 2026-08-09.** `docs/adr/0003-delegated-execution-authority.md` removed
> user-key custody, so the trigger below has nothing left to measure and this
> procedure has nothing to sweep. **Do not execute it.**
>
> Retained deliberately, for two futures: it is the procedure again under ADR-0003
> §6 **fork (b)** (Polymarket-only custodial exception), and its separate-host
> argument still applies to the operator Solana key and the SOPS age key, which
> ADR-0002 still governs. §6's staging rehearsal is still the right shape for both.

**Decision:** `docs/adr/0002-custody-key-store.md` (narrowed)
**Design:** `docs/plans/stage-4-design.md` §3 (envelope scheme), §4 (rotation and DR)
**Trigger:** USD 50,000 total custodied, or 100 users with a non-zero balance —
whichever comes first. On crossing, migrate **before onboarding further users**.

This is an operational procedure, not a design document. It assumes Stage 4 custody
is live on `EnvMasterKeyWrapper` and you are moving to Vault Transit on a separate
host.

## 0. What this migration does and does not touch

**Re-wrapped:** the small wrapped data key inside each `user_trading_wallets.sealed_key`.

**Never decrypted:** the private keys themselves. Per design §3.1 the ciphertext is
untouched — only the data key that opens it is re-wrapped. This is why the migration
is safe to interrupt: a crash leaves a mix of `env:v*` and `vault:v*` rows that
**both open correctly**, not a partially decrypted set.

**Unchanged:** `key_version` on the row. That is the *keypair* version (an on-chain
address rotation, deferred per `D-S4-C`). The *wrapper* version lives inside the
`sealed_key` string.

A `sealed_key` is self-describing:

```
v1.<wrapperId>.<b64(wrappedDataKey)>.<b64(iv)>.<b64(authTag)>.<b64(ciphertext)>
       ^^^^^^^^ this is the only field the migration changes
```

Because `wrapperId` is embedded per row rather than read from config, both wrappers
can serve traffic simultaneously. There is no flag day.

---

## 1. Before you start

Do not begin until all of these are true.

- [ ] **`DG-8` is answered.** Vault relocates the escrow problem to its unseal
      shares; it does not remove it. If you do not have a decided, written home for
      the unseal material, you are about to move the single point of failure rather
      than fix it.
- [ ] **A full `pg_dump` is taken and its restore verified**, on a host that can
      read the *current* `CUSTODY_MASTER_KEY_V*`. A backup you cannot decrypt is
      not a backup (§4 opening).
- [ ] **The current master key and the SOPS age key are both escrowed** as Shamir
      3-of-5 per `docs/runbooks/custody-key-shamir-split.md`, and the shares have
      been **verified by reconstruction** — not merely written down. Per `D-S4-D`
      two secrets must survive, not one.
- [ ] **Live trading is paused** — set the platform kill switch. The sweep is safe
      to run against live traffic in principle, but a migration is not the moment
      to discover an edge case in `unwrap` fallback.
- [ ] Staging has run the full procedure end to end at least once.

---

## 2. Stand up Vault

Separate host, same private network as the executor. Not the same machine — that
choice is argued in ADR-0002 and is the entire point of the exercise.

```bash
# On the Vault host.
vault operator init -key-shares=5 -key-threshold=3
```

Record the 5 unseal shares and the root token **onto physical media, immediately**,
and distribute per your `DG-8` decision. They are displayed once.

**These shares now need the same custody as the master key did.** Vault does not
remove the escrow problem, it relocates it: losing 3 of 5 unseal shares means Vault
can never be unsealed, which means no data key can ever be unwrapped, which is the
same total loss the master key's escrow exists to prevent. Vault emits its own
shares in base64 rather than SLIP-39, so they cannot be hand-verified the way
`docs/runbooks/custody-key-shamir-split.md` describes — transcribe with
correspondingly more care, and verify by sealing and unsealing once before relying
on them.

Store the root token separately from the unseal shares and revoke it after setup;
day-to-day auth is the AppRole below.

```bash
vault operator unseal   # x3, with three different shares
vault secrets enable transit
vault write -f transit/keys/swat-custody type=aes256-gcm96
```

`transit/keys/swat-custody` never leaves Vault. The executor sends a data key and
receives a wrapped blob; the master key is not transmitted in either direction.
That property is what a same-host deployment would have surrendered.

### Least-privilege policy

```hcl
# swat-custody policy — encrypt/decrypt ONLY. No key export, no key deletion.
path "transit/encrypt/swat-custody" { capabilities = ["update"] }
path "transit/decrypt/swat-custody" { capabilities = ["update"] }
```

Deliberately absent: `transit/keys/*` read, `export`, and `delete`. A compromised
executor token can ask Vault to wrap and unwrap while it holds access — a
time-bounded, fully audited oracle — but cannot extract the master key, and cannot
destroy it to hold you to ransom.

### AppRole auth, not a static token

```bash
vault auth enable approle
vault write auth/approle/role/trade-executor \
  token_policies=swat-custody \
  token_ttl=1h token_max_ttl=24h \
  secret_id_ttl=0 bind_secret_id=true
```

A static long-lived token would replace one durable secret with another and gain
less than it appears. The executor renews; `secret_id` goes in the SOPS env file.

---

## 3. Configure the executor for dual-wrapper operation

Both wrappers registered, env still active for writes:

```bash
CUSTODY_MASTER_KEY_V1=<unchanged>
CUSTODY_MASTER_KEY_ACTIVE=1        # still env — do NOT flip yet
VAULT_ADDR=https://vault.internal:8200
VAULT_ROLE_ID=<role id>
VAULT_SECRET_ID=<secret id>
VAULT_TRANSIT_KEY=swat-custody
```

Restart. `D-S4-E`'s boot assertion round-trips a test vector through the **active**
wrapper and refuses to start on failure — so a truncated or wrong-encoding Vault
credential is a loud boot failure, not a per-trade auth-tag error discovered when a
user's trade fails.

**Verify Vault is reachable before making it authoritative:**

```bash
# Should return a wrapped blob, proving policy + auth + network all work.
vault write transit/encrypt/swat-custody plaintext=$(base64 <<< "preflight")
```

If this fails, stop. Nothing has changed yet and there is nothing to roll back.

---

## 4. Flip new writes to Vault

```bash
CUSTODY_WRAPPER_ACTIVE=vault
```

Restart. From here:

- **New** wallets seal under `vault:v1`.
- **Existing** `env:v1` rows still open, because each row names its own wrapper.

Both paths are live. Nothing is stranded. You can sit in this state indefinitely —
and if Vault proves unstable, flipping back to `env` is a config change with no
data implications.

---

## 5. Sweep existing rows

```bash
pnpm --filter @swat/trade-executor rewrap:custody --to vault:v1
```

The job (`D-S4-B`, in trade-executor, **never** the API) iterates
`user_trading_wallets`, unwraps each data key under the wrapper its row names,
re-wraps under the active wrapper, and updates the row.

Properties that make it safe to interrupt:

- **Idempotent by prefix.** A row already at `vault:v1` is detected and skipped
  *without decrypting it*.
- **Resumable.** Kill it and re-run; it continues.
- **Row-at-a-time.** No batch transaction holds many plaintext data keys at once.

Monitor progress:

```sql
SELECT split_part(sealed_key, '.', 2) AS wrapper, count(*)
FROM user_trading_wallets
WHERE status = 'active'
GROUP BY 1;
```

Migration is complete when only `vault:v1` remains.

---

## 6. Verify before retiring the env key

**Do not skip this. It is the last point at which a mistake is recoverable.**

```sql
-- Must return 0.
SELECT count(*) FROM user_trading_wallets
WHERE status = 'active' AND sealed_key NOT LIKE 'v1.vault:%';
```

- [ ] The query above returns 0.
- [ ] A **paper** trade executes end to end for at least one migrated user —
      proving `unwrap` genuinely works through Vault, not merely that the string
      changed shape.
- [ ] Vault's audit log shows the corresponding `decrypt` calls.
- [ ] A fresh `pg_dump` is taken **after** the sweep and stored with the Vault
      unseal shares. The pre-migration backup is now openable only by the env key
      you are about to retire — keep both until the new backup is restore-verified.

---

## 7. Retire the env master key

Only after §6 passes completely.

```bash
# Remove from the SOPS env file:
#   CUSTODY_MASTER_KEY_V1
#   CUSTODY_MASTER_KEY_ACTIVE
```

Restart, confirm trading resumes, un-pause live trading.

**Keep the escrowed env key offline for 90 days.** It is the only thing that opens
the pre-migration backup. Destroying it immediately means that backup becomes
undecryptable the moment you need it. Destroy it only once a post-migration backup
has been restore-verified and the retention window has passed.

---

## 8. Rollback

**Before §7** — trivial. Set `CUSTODY_WRAPPER_ACTIVE=env`, restart, optionally
sweep back with `--to env:v1`. Both wrappers were registered the whole time; no data
is stranded either way.

**After §7** — you must re-add the escrowed env key to the SOPS file before rows
wrapped under `env:v1` can open. If the sweep completed, there are none, and the
correct move is to fix Vault rather than roll back.

**If Vault is unreachable in production:** live trading fails closed — no key can
be unwrapped, so no live trade executes. Paper mode is unaffected. This is intended
behaviour, not an outage to route around. Restore Vault, unseal it (§2), and
trading resumes. **Do not** re-add the env key as an emergency workaround without
also sweeping rows back; a mixed state where the active wrapper is unreachable and
rows name it is exactly the situation §5's dual-wrapper design exists to avoid.

---

## 9. After migration

- Vault's uptime is now live trading's uptime. Monitor seal status; a Vault
  restart requires unsealing before trading resumes.
- Vault's audit log becomes a custody audit trail. Ship it somewhere durable and
  separate from the Vault host.
- The unseal shares now need the escrow discipline the master key had. `DG-8` did
  not go away; it changed shape.
- Wrapper rotation (`D-S4-B`) is now `vault write -f transit/keys/swat-custody/rotate`
  followed by the same sweep. Vault versions its own key, so this becomes routine
  rather than a special event.
