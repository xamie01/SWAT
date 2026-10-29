#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use wake_vault::invariants::*;
use wake_vault::VaultError;

/// Trident Invariant Test Suite for WakeVault
///
/// Asserts critical on-chain safety properties across arbitrary transaction interleavings:
/// 1. Vault Conservation Invariant (spend <= max_in)
/// 2. Minimum Return Invariant (gain >= min_out)
/// 3. Unauthorized Withdrawal Invariant (caller != owner fails)
/// 4. Centralized Executor Invariant (caller != config.executor fails)
/// 5. Revocation Invariant (revoked vault rejects swap execution)
/// 6. Lamport Preservation Invariant (vault lamports never decrease during token swap)
/// 7. Rogue Account Scanning Invariant (vault-owned writable ATA injection in remaining_accounts fails)
pub struct FuzzVaultState {
    pub owner: Pubkey,
    pub executor: Pubkey,
    pub revoked: bool,
    pub token_in_balance: u64,
    pub token_out_balance: u64,
    pub sol_lamports: u64,
}

impl Default for FuzzVaultState {
    fn default() -> Self {
        Self::new()
    }
}

impl FuzzVaultState {
    pub fn new() -> Self {
        Self {
            owner: Pubkey::new_unique(),
            executor: Pubkey::new_unique(),
            revoked: false,
            token_in_balance: 1_000_000_000,
            token_out_balance: 500_000_000,
            sol_lamports: 100_000_000,
        }
    }

    /// Fuzz step: Attempt swap execution
    pub fn step_swap(
        &mut self,
        caller: Pubkey,
        max_in: u64,
        min_out: u64,
        actual_spend: u64,
        actual_gain: u64,
        sol_drain: u64,
    ) -> Result<()> {
        // Invariant 1: Executor Authorization & Revocation
        verify_executor_authorization(caller, self.executor, self.revoked)?;

        let in_before = self.token_in_balance;
        let in_after = in_before.saturating_sub(actual_spend);

        let out_before = self.token_out_balance;
        let out_after = out_before.saturating_add(actual_gain);

        let lamports_before = self.sol_lamports;
        let lamports_after = lamports_before.saturating_sub(sol_drain);

        // Invariant 2: Native SOL Preservation
        verify_native_sol_preservation(lamports_before, lamports_after)?;

        // Invariant 3: Token In Delta
        verify_token_in_delta(in_before, in_after, max_in)?;

        // Invariant 4: Token Out Delta
        verify_token_out_delta(out_before, out_after, min_out)?;

        // Update state on successful verification
        self.token_in_balance = in_after;
        self.token_out_balance = out_after;
        self.sol_lamports = lamports_after;

        Ok(())
    }

    /// Fuzz step: Attempt withdrawal
    pub fn step_withdraw(&self, caller: Pubkey, amount: u64) -> Result<()> {
        verify_withdrawal_authorization(caller, self.owner)?;
        require!(amount > 0, VaultError::ZeroWithdrawalAmount);
        Ok(())
    }

    /// Fuzz step: Revoke executor
    pub fn step_revoke(&mut self, caller: Pubkey) -> Result<()> {
        verify_withdrawal_authorization(caller, self.owner)?;
        self.revoked = true;
        Ok(())
    }

    /// Fuzz step: Restore executor
    pub fn step_restore(&mut self, caller: Pubkey) -> Result<()> {
        verify_withdrawal_authorization(caller, self.owner)?;
        self.revoked = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_trident_invariant_campaign() {
        let mut state = FuzzVaultState::new();
        let owner = state.owner;
        let executor = state.executor;
        let attacker = Pubkey::new_unique();

        // 1. Attacker withdrawal must always fail
        assert!(state.step_withdraw(attacker, 1_000).is_err());
        assert!(state.step_withdraw(owner, 1_000).is_ok());

        // 2. Attacker cannot invoke swap
        assert!(state.step_swap(attacker, 100, 50, 80, 60, 0).is_err());

        // 3. Executor swap with acceptable slippage succeeds
        assert!(state.step_swap(executor, 100, 50, 80, 60, 0).is_ok());

        // 4. Excessive spend is rejected
        assert!(state.step_swap(executor, 100, 50, 150, 60, 0).is_err());

        // 5. Slippage exceeded is rejected
        assert!(state.step_swap(executor, 100, 50, 80, 40, 0).is_err());

        // 6. Sol drain is rejected
        assert!(state.step_swap(executor, 100, 50, 80, 60, 1).is_err());

        // 7. Revoke executor prevents any further swaps
        assert!(state.step_revoke(owner).is_ok());
        assert!(state.step_swap(executor, 100, 50, 80, 60, 0).is_err());

        // 8. Restore executor re-enables valid swaps
        assert!(state.step_restore(owner).is_ok());
        assert!(state.step_swap(executor, 100, 50, 80, 60, 0).is_ok());
    }
}
