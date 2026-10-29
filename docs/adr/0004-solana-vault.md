# ADR-0004 — Solana Non-Custodial Vault Program (`wake-vault`)

- **Status:** Decided & Specified
- **Date:** 2026-10-29
- **Author:** Antigravity Agent & SWAT Operator
- **Companion to:** [`docs/adr/0003-delegated-execution-authority.md`](./0003-delegated-execution-authority.md) §3, [`AUDIT-FIX-CHECKLIST.md`](../../AUDIT-FIX-CHECKLIST.md) §7.1 `S4-P12` & `S4-P19`
- **Implementation:** [`programs/wake-vault/src/lib.rs`](../../programs/wake-vault/src/lib.rs)

---

## 1. Context & Motivation

Under [ADR-0003](./0003-delegated-execution-authority.md), WAKE eliminated custodial user private keys in favor of scoped, revocable, expiring authority.

On EVM (Robinhood Chain), ERC-4337 session keys and EIP-7702 permit delegation over existing EOAs. However, on Solana:
1. **Native SPL `approve`** only bounds *how much*, never *to whom*; a delegate can transfer funds to an attacker's address.
2. **Squads V4 multisig spending limits** only authorize transfers to pre-named recipient addresses, which structurally cannot authorize CPI swaps through Jupiter settling back into the same vault.

Therefore, WAKE uses a dedicated Anchor smart contract program on Solana: **`wake-vault`**.

---

## 2. Decision & Core Invariants

### 2.1 The Mathematically Bound PDA Vault
Each user's vault PDA is derived strictly from:
$$\text{seeds} = [\texttt{b"vault"}, \text{owner.key().as\_ref()}]$$
- **No private key exists for the vault.** It is mathematically keyless.
- The `owner` is set once upon initialization and is permanent and immutable.
- The creator's wallet signature is **mandatory** for all withdrawals (`withdraw_spl`, `withdraw_sol`) and revocations (`revoke_executor`).

### 2.2 Global `WakeConfig` PDA & Live Executor Check (Resolving Finding 2 & 3)
Instead of storing `executor_authority` on each individual vault (which broke executor rotation), `wake-vault` establishes a centralized configuration PDA:
$$\text{seeds} = [\texttt{b"config"}], \text{bump}$$
- Stores `admin: Pubkey`, `executor: Pubkey`, `tip_accounts: [Pubkey; 8]`, and `max_tip_lamports: u64`.
- In `execute_swap`, the program verifies `constraint = executor.key() == config.executor`.
- When rotating the hot execution key, the admin multisig calls `update_config(new_executor)`. All user vaults instantly recognize the new key without any migration transactions.

### 2.3 Post-CPI Balance Delta Invariants & Side-Channel Defense (Resolving Finding 1)
Jupiter swap instructions accept dynamic routing accounts via `remaining_accounts`. To prevent account substitution and balance draining:
1. **Pre-CPI balance snapshot:** Records `vault_token_in.amount` and `vault_token_out.amount`.
2. **Rogue account scan:** Scans `remaining_accounts` and asserts that no writable token account belongs to the vault other than `vault_token_in` and `vault_token_out`. This prevents side-channel drains.
3. **CPI invocation:** Invokes Jupiter with the vault PDA signer seeds.
4. **Post-CPI invariant assertion:**
   $$\text{spent} = \text{in\_before} - \text{in\_after} \le \text{max\_in}$$
   $$\text{received} = \text{out\_after} - \text{out\_before} \ge \text{min\_out}$$
   If slippage is exceeded or spend is violated, the transaction reverts on-chain.

---

## 3. Operational Sequencing & Security Audit Gate

Per operator instructions:
1. The program code is written and specified in [`programs/wake-vault/src/lib.rs`](../../programs/wake-vault/src/lib.rs).
2. **Solana live execution remains gated and turned off** via `authority-solana-delegate-unavailable` in [`apps/trade-executor/src/execution-authority-adapters.ts`](../../apps/trade-executor/src/execution-authority-adapters.ts).
3. Live per-user execution will only be enabled after an external third-party security audit (e.g., OtterSec, Sec3, or Neodyme) is completed and signed off.
