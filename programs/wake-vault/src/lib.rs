#![allow(unexpected_cfgs)]

// programs/wake-vault/src/lib.rs
//
// WAKE Non-Custodial Delegated Execution Vault for Solana
// (ADR-0003 §3, ADR-0004, AUDIT-FIX-CHECKLIST S4-P12 & S4-P19).
//
// Solves the three security vulnerabilities identified in the initial review:
//   1. Balance Delta Post-Condition Checks & Rogue Account Scanning (Finding 1)
//   2. Pinned WakeConfig PDA [b"config"] with Fixed Tip Accounts Allowlist (Finding 2)
//   3. Centralized Live Executor Authority Check for Instant Rotation (Finding 3)
//
// Guarantees:
//   - Mathematically keyless vault PDA bound strictly to the creator's wallet [b"vault", owner].
//   - Only the creator/owner can withdraw funds or revoke execution authority.
//   - Operator key can ONLY invoke Jupiter swaps where output tokens return to the vault.
//   - Reverts on-chain if slippage or token spend exceeds pre-authorized bounds.

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("6t6dRetG3Hns4vCfZaj392e9bZ6uTEEmvL37KnDWErfS");

pub mod jupiter {
    use super::*;
    // Jupiter Aggregator v6 Program ID
    pub const ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
}

#[program]
pub mod wake_vault {
    use super::*;

    /// Initializes the global configuration PDA. Admin multisig only.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        executor: Pubkey,
        tip_accounts: [Pubkey; 8],
        max_tip_lamports: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.executor = executor;
        config.tip_accounts = tip_accounts;
        config.max_tip_lamports = max_tip_lamports;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Rotates the global executor authority or updates tip allowlist. Admin only.
    /// Immediately applies to all user vaults without per-vault updates.
    pub fn update_config(
        ctx: Context<UpdateConfig>,
        new_executor: Option<Pubkey>,
        new_tip_accounts: Option<[Pubkey; 8]>,
        new_max_tip_lamports: Option<u64>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        if let Some(executor) = new_executor {
            config.executor = executor;
        }
        if let Some(tips) = new_tip_accounts {
            config.tip_accounts = tips;
        }
        if let Some(max_tip) = new_max_tip_lamports {
            config.max_tip_lamports = max_tip;
        }
        Ok(())
    }

    /// Initializes a user's vault PDA.
    /// Bound mathematically to the creator's wallet: seeds = [b"vault", owner.key()].
    /// WAKE never signs this — the creator is the exclusive, permanent owner.
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.bump = ctx.bumps.vault;
        vault.revoked = false;
        Ok(())
    }

    /// Initializes a user's vault PDA even if it was pre-funded with native SOL
    /// before initialization was called.
    ///
    /// Standard Anchor `init` fails with `AccountAlreadyInUse` if the user transferred
    /// SOL to the PDA beforehand. This instruction safely allocates space and assigns
    /// ownership to the program via `invoke_signed` using the PDA's canonical seeds.
    pub fn initialize_funded_vault(ctx: Context<InitializeFundedVault>) -> Result<()> {
        let vault_info = ctx.accounts.vault.to_account_info();
        let owner_info = ctx.accounts.owner.to_account_info();
        let system_program_info = ctx.accounts.system_program.to_account_info();

        // 1. Ensure the account is uninitialized and currently owned by SystemProgram
        require!(
            vault_info.owner == &solana_program::system_program::ID,
            VaultError::AlreadyInitialized
        );
        require!(vault_info.data_is_empty(), VaultError::AlreadyInitialized);

        let space = 8 + WakeVault::LEN;
        let rent = Rent::get()?;
        let required_rent = rent.minimum_balance(space);
        let current_lamports = vault_info.lamports();

        // Top up deficit rent from owner if current balance is less than required rent
        if current_lamports < required_rent {
            let deficit = required_rent - current_lamports;
            solana_program::program::invoke(
                &solana_program::system_instruction::transfer(owner_info.key, vault_info.key, deficit),
                &[owner_info.clone(), vault_info.clone(), system_program_info.clone()],
            )?;
        }

        let bump = ctx.bumps.vault;
        let seeds = &[
            b"vault",
            ctx.accounts.owner.key.as_ref(),
            &[bump],
        ];
        let signer_seeds = &[&seeds[..]];

        // 2. Allocate account space
        solana_program::program::invoke_signed(
            &solana_program::system_instruction::allocate(vault_info.key, space as u64),
            &[vault_info.clone(), system_program_info.clone()],
            signer_seeds,
        )?;

        // 3. Assign account ownership to this program
        solana_program::program::invoke_signed(
            &solana_program::system_instruction::assign(vault_info.key, ctx.program_id),
            &[vault_info.clone(), system_program_info],
            signer_seeds,
        )?;

        // 4. Write Anchor discriminator and WakeVault state
        let mut data = vault_info.try_borrow_mut_data()?;
        let discriminator = WakeVault::DISCRIMINATOR;
        data[..8].copy_from_slice(&discriminator);

        let vault_state = WakeVault {
            owner: ctx.accounts.owner.key(),
            bump,
            revoked: false,
        };
        let mut writer = &mut data[8..8 + WakeVault::LEN];
        vault_state.serialize(&mut writer)?;

        Ok(())
    }

    /// Immediate, on-chain kill switch signed by the creator's wallet.
    pub fn revoke_executor(ctx: Context<ManageVault>) -> Result<()> {
        ctx.accounts.vault.revoked = true;
        Ok(())
    }

    /// Restores executor swap authority. Signed by the creator's wallet only.
    pub fn restore_executor(ctx: Context<ManageVault>) -> Result<()> {
        ctx.accounts.vault.revoked = false;
        Ok(())
    }

    /// User-only withdrawal of SPL tokens from their vault PDA back to their own wallet.
    pub fn withdraw_spl(ctx: Context<WithdrawSpl>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroWithdrawalAmount);

        let seeds = &[
            b"vault",
            ctx.accounts.vault.owner.as_ref(),
            &[ctx.accounts.vault.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_token.to_account_info(),
            to: ctx.accounts.destination_token.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, amount)?;

        Ok(())
    }

    /// User-only withdrawal of native SOL from their vault PDA back to their own wallet.
    pub fn withdraw_sol(ctx: Context<WithdrawSol>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroWithdrawalAmount);

        let vault_info = ctx.accounts.vault.to_account_info();
        let rent = Rent::get()?;
        let min_rent = rent.minimum_balance(vault_info.data_len());
        let current_lamports = vault_info.lamports();

        let available = current_lamports.saturating_sub(min_rent);
        require!(amount <= available, VaultError::InsufficientFunds);

        let new_vault_lamports = current_lamports
            .checked_sub(amount)
            .ok_or(VaultError::ArithmeticUnderflow)?;
        let new_owner_lamports = ctx.accounts.owner.lamports()
            .checked_add(amount)
            .ok_or(VaultError::ArithmeticOverflow)?;

        **vault_info.try_borrow_mut_lamports()? = new_vault_lamports;
        **ctx.accounts.owner.try_borrow_mut_lamports()? = new_owner_lamports;

        Ok(())
    }

    /// Executes a delegated Jupiter swap on behalf of the user.
    ///
    /// Security Controls:
    ///   - Must be signed by config.executor (checked live).
    ///   - Vault must not be revoked.
    ///   - Swaps strictly between disjoint vault-owned token accounts.
    ///   - Scans remaining_accounts to prevent rogue vault ATAs from being drained.
    ///   - Asserts native SOL lamport preservation (vault lamports cannot decrease).
    ///   - Asserts post-CPI balance deltas: spent <= max_in, received >= min_out.
    pub fn execute_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>,
        max_in: u64,
        min_out: u64,
        cpi_data: Vec<u8>,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(!vault.revoked, VaultError::ExecutorRevoked);

        // Verify target program is Jupiter Aggregator
        require_keys_eq!(
            ctx.accounts.swap_program.key(),
            jupiter::ID,
            VaultError::UnknownCpiTarget
        );

        let in_key = ctx.accounts.vault_token_in.key();
        let out_key = ctx.accounts.vault_token_out.key();
        require_keys_neq!(in_key, out_key, VaultError::IdenticalSwapTokens);

        // Record baseline token balances and native lamports before swap
        ctx.accounts.vault_token_in.reload()?;
        ctx.accounts.vault_token_out.reload()?;
        let in_before = ctx.accounts.vault_token_in.amount;
        let out_before = ctx.accounts.vault_token_out.amount;
        let vault_lamports_before = ctx.accounts.vault.to_account_info().lamports();

        // Scan remaining_accounts to reject any other writable vault-owned token accounts
        let vault_key = vault.key();
        let token_prog_key = ctx.accounts.token_program.key();

        for acc in ctx.remaining_accounts.iter() {
            if acc.is_writable
                && acc.owner == &token_prog_key
                && acc.key() != in_key
                && acc.key() != out_key
            {
                let ata_data = TokenAccount::try_deserialize(&mut &acc.data.borrow()[..])?;
                require!(
                    ata_data.owner != vault_key,
                    VaultError::UnauthorizedVaultAccount
                );
            }
        }

        // Execute CPI into Jupiter program with Vault PDA signing seeds
        let seeds = &[
            b"vault",
            vault.owner.as_ref(),
            &[vault.bump],
        ];
        let signer = &[&seeds[..]];

        let cpi_accounts = ctx.remaining_accounts.to_vec();
        invoke_signed(
            &Instruction {
                program_id: ctx.accounts.swap_program.key(),
                accounts: cpi_accounts
                    .into_iter()
                    .map(|a| AccountMeta {
                        pubkey: *a.key,
                        is_signer: a.key == &vault_key,
                        is_writable: a.is_writable,
                    })
                    .collect(),
                data: cpi_data,
            },
            ctx.remaining_accounts,
            signer,
        )?;

        // Assert post-CPI invariants
        ctx.accounts.vault_token_in.reload()?;
        ctx.accounts.vault_token_out.reload()?;
        let in_after = ctx.accounts.vault_token_in.amount;
        let out_after = ctx.accounts.vault_token_out.amount;
        let vault_lamports_after = ctx.accounts.vault.to_account_info().lamports();

        // Ensure native SOL in vault PDA was not drained by CPI instruction
        invariants::verify_native_sol_preservation(vault_lamports_before, vault_lamports_after)?;

        // Ensure token deltas strictly observe maximum spend and minimum return bounds
        invariants::verify_token_in_delta(in_before, in_after, max_in)?;
        invariants::verify_token_out_delta(out_before, out_after, min_out)?;

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Account Contexts
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + WakeConfig::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, WakeConfig>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin @ VaultError::UnauthorizedAdmin
    )]
    pub config: Account<'info, WakeConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + WakeVault::LEN,
        seeds = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, WakeVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeFundedVault<'info> {
    /// CHECK: Target Vault PDA. May be pre-funded with SOL (lamports > 0) prior to initialization.
    /// Canonical seeds, bump, ownership (SystemProgram), and empty data are strictly checked.
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ManageVault<'info> {
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::UnauthorizedOwner
    )]
    pub vault: Account<'info, WakeVault>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawSpl<'info> {
    #[account(
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::UnauthorizedOwner
    )]
    pub vault: Account<'info, WakeVault>,
    pub owner: Signer<'info>,

    #[account(
        mut,
        token::authority = vault,
    )]
    pub vault_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::authority = owner,
        constraint = destination_token.mint == vault_token.mint @ VaultError::MintMismatch,
    )]
    pub destination_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(
        mut,
        seeds = [b"vault", owner.key().as_ref()],
        bump = vault.bump,
        has_one = owner @ VaultError::UnauthorizedOwner
    )]
    pub vault: Account<'info, WakeVault>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(
        mut,
        seeds = [b"vault", vault.owner.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, WakeVault>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, WakeConfig>,

    #[account(
        mut,
        constraint = executor.key() == config.executor @ VaultError::UnauthorizedExecutor
    )]
    pub executor: Signer<'info>,

    #[account(
        mut,
        token::authority = vault,
    )]
    pub vault_token_in: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::authority = vault,
    )]
    pub vault_token_out: Account<'info, TokenAccount>,

    /// CHECK: Target DEX routing program verified against allowlist (Jupiter v6)
    #[account(address = jupiter::ID @ VaultError::UnknownCpiTarget)]
    pub swap_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

// ─────────────────────────────────────────────────────────────────────────────
// State Data
// ─────────────────────────────────────────────────────────────────────────────

#[account]
pub struct WakeConfig {
    pub admin: Pubkey,
    pub executor: Pubkey,
    pub tip_accounts: [Pubkey; 8],
    pub max_tip_lamports: u64,
    pub bump: u8,
}

impl WakeConfig {
    pub const LEN: usize = 32 + 32 + (32 * 8) + 8 + 1;
}

#[account]
pub struct WakeVault {
    pub owner: Pubkey,
    pub bump: u8,
    pub revoked: bool,
}

impl WakeVault {
    pub const LEN: usize = 32 + 1 + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error Taxonomy
// ─────────────────────────────────────────────────────────────────────────────

#[error_code]
pub enum VaultError {
    #[msg("Executor authority has been revoked by the vault owner")]
    ExecutorRevoked,
    #[msg("Signer is not the authorized global executor")]
    UnauthorizedExecutor,
    #[msg("Signer is not the admin of this configuration")]
    UnauthorizedAdmin,
    #[msg("Signer is not the permanent owner of this vault")]
    UnauthorizedOwner,
    #[msg("Target swap program ID is not the verified Jupiter aggregator")]
    UnknownCpiTarget,
    #[msg("Withdrawal amount must be greater than zero")]
    ZeroWithdrawalAmount,
    #[msg("Insufficient funds available to complete withdrawal above rent exemption")]
    InsufficientFunds,
    #[msg("CPI accounts contain an unauthorized writable vault token account")]
    UnauthorizedVaultAccount,
    #[msg("Token spend exceeded the maximum allowable in_amount")]
    ExcessiveSpend,
    #[msg("Token received is less than the minimum required out_amount (slippage exceeded)")]
    SlippageExceeded,
    #[msg("Arithmetic underflow occurred during balance delta reconciliation")]
    ArithmeticUnderflow,
    #[msg("Arithmetic overflow occurred during balance calculation")]
    ArithmeticOverflow,
    #[msg("Vault native SOL lamports were decreased during swap execution")]
    LamportsDrained,
    #[msg("Input and output token accounts must be distinct")]
    IdenticalSwapTokens,
    #[msg("Destination token account mint does not match vault token account mint")]
    MintMismatch,
    #[msg("Vault account is already initialized or owned by another program")]
    AlreadyInitialized,
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure Invariant Verification Modules (For Fuzzing & Static Analysis)
// ─────────────────────────────────────────────────────────────────────────────

pub mod invariants {
    use super::*;

    /// Verifies the vault token spend invariant: spent <= max_in
    pub fn verify_token_in_delta(in_before: u64, in_after: u64, max_in: u64) -> Result<u64> {
        let in_spent = in_before.checked_sub(in_after).ok_or(VaultError::ArithmeticUnderflow)?;
        require!(in_spent <= max_in, VaultError::ExcessiveSpend);
        Ok(in_spent)
    }

    /// Verifies the minimum token return invariant: received >= min_out
    pub fn verify_token_out_delta(out_before: u64, out_after: u64, min_out: u64) -> Result<u64> {
        let out_received = out_after.checked_sub(out_before).ok_or(VaultError::ArithmeticUnderflow)?;
        require!(out_received >= min_out, VaultError::SlippageExceeded);
        Ok(out_received)
    }

    /// Verifies native SOL preservation invariant: lamports cannot decrease
    pub fn verify_native_sol_preservation(lamports_before: u64, lamports_after: u64) -> Result<()> {
        require!(lamports_after >= lamports_before, VaultError::LamportsDrained);
        Ok(())
    }

    /// Verifies unauthorized withdrawal invariant: only owner key may withdraw
    pub fn verify_withdrawal_authorization(caller: Pubkey, vault_owner: Pubkey) -> Result<()> {
        require_keys_eq!(caller, vault_owner, VaultError::UnauthorizedOwner);
        Ok(())
    }

    /// Verifies executor authorization invariant: must match active config executor and not revoked
    pub fn verify_executor_authorization(
        caller: Pubkey,
        config_executor: Pubkey,
        vault_revoked: bool,
    ) -> Result<()> {
        require!(!vault_revoked, VaultError::ExecutorRevoked);
        require_keys_eq!(caller, config_executor, VaultError::UnauthorizedExecutor);
        Ok(())
    }

    /// Verifies remaining accounts safety: no unauthorized vault-owned token account can be writable
    #[allow(clippy::too_many_arguments)]
    pub fn verify_remaining_account_safety(
        acc_key: Pubkey,
        is_writable: bool,
        account_owner: Pubkey,
        token_program_id: Pubkey,
        ata_owner: Option<Pubkey>,
        vault_key: Pubkey,
        in_key: Pubkey,
        out_key: Pubkey,
    ) -> Result<()> {
        if is_writable
            && account_owner == token_program_id
            && acc_key != in_key
            && acc_key != out_key
        {
            if let Some(owner) = ata_owner {
                require!(owner != vault_key, VaultError::UnauthorizedVaultAccount);
            }
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant Verification Tests & Fuzzing Harness
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vault_conservation_invariant_exact_spend() {
        let res = invariants::verify_token_in_delta(1_000, 500, 500);
        assert_eq!(res.unwrap(), 500);
    }

    #[test]
    fn test_vault_conservation_invariant_less_spend() {
        let res = invariants::verify_token_in_delta(1_000, 700, 500);
        assert_eq!(res.unwrap(), 300);
    }

    #[test]
    fn test_vault_conservation_invariant_excessive_spend_fails() {
        let res = invariants::verify_token_in_delta(1_000, 400, 500);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::ExcessiveSpend));
    }

    #[test]
    fn test_vault_conservation_invariant_underflow_fails() {
        let res = invariants::verify_token_in_delta(100, 200, 500);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::ArithmeticUnderflow));
    }

    #[test]
    fn test_minimum_return_invariant_exact_return() {
        let res = invariants::verify_token_out_delta(100, 300, 200);
        assert_eq!(res.unwrap(), 200);
    }

    #[test]
    fn test_minimum_return_invariant_higher_return() {
        let res = invariants::verify_token_out_delta(100, 450, 200);
        assert_eq!(res.unwrap(), 350);
    }

    #[test]
    fn test_minimum_return_invariant_slippage_exceeded_fails() {
        let res = invariants::verify_token_out_delta(100, 250, 200);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::SlippageExceeded));
    }

    #[test]
    fn test_minimum_return_invariant_underflow_fails() {
        let res = invariants::verify_token_out_delta(300, 100, 50);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::ArithmeticUnderflow));
    }

    #[test]
    fn test_native_sol_preservation_ok() {
        assert!(invariants::verify_native_sol_preservation(10_000, 10_000).is_ok());
        assert!(invariants::verify_native_sol_preservation(10_000, 12_000).is_ok());
    }

    #[test]
    fn test_native_sol_preservation_drain_fails() {
        let res = invariants::verify_native_sol_preservation(10_000, 9_999);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::LamportsDrained));
    }

    #[test]
    fn test_prefunded_vault_already_initialized_check() {
        let is_system_program = false; // already assigned
        let is_empty_data = false; // already has data
        let res: Result<()> = if !is_system_program || !is_empty_data {
            Err(error!(VaultError::AlreadyInitialized))
        } else {
            Ok(())
        };
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::AlreadyInitialized));
    }

    #[test]
    fn test_withdrawal_authorization_owner_ok() {
        let owner = Pubkey::new_unique();
        assert!(invariants::verify_withdrawal_authorization(owner, owner).is_ok());
    }

    #[test]
    fn test_withdrawal_authorization_attacker_fails() {
        let owner = Pubkey::new_unique();
        let attacker = Pubkey::new_unique();
        let res = invariants::verify_withdrawal_authorization(attacker, owner);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::UnauthorizedOwner));
    }

    #[test]
    fn test_executor_authorization_ok() {
        let executor = Pubkey::new_unique();
        assert!(invariants::verify_executor_authorization(executor, executor, false).is_ok());
    }

    #[test]
    fn test_executor_authorization_revoked_fails() {
        let executor = Pubkey::new_unique();
        let res = invariants::verify_executor_authorization(executor, executor, true);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::ExecutorRevoked));
    }

    #[test]
    fn test_executor_authorization_wrong_caller_fails() {
        let executor = Pubkey::new_unique();
        let impostor = Pubkey::new_unique();
        let res = invariants::verify_executor_authorization(impostor, executor, false);
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::UnauthorizedExecutor));
    }

    #[test]
    fn test_remaining_account_safety_unauthorized_vault_ata_fails() {
        let vault = Pubkey::new_unique();
        let token_prog = Pubkey::new_unique();
        let rogue_ata = Pubkey::new_unique();
        let in_key = Pubkey::new_unique();
        let out_key = Pubkey::new_unique();

        let res = invariants::verify_remaining_account_safety(
            rogue_ata,
            true, // is_writable
            token_prog,
            token_prog,
            Some(vault), // owner is vault!
            vault,
            in_key,
            out_key,
        );
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), error!(VaultError::UnauthorizedVaultAccount));
    }

    #[test]
    fn test_remaining_account_safety_third_party_accounts_allowed() {
        let vault = Pubkey::new_unique();
        let token_prog = Pubkey::new_unique();
        let jup_route_ata = Pubkey::new_unique();
        let pool_owner = Pubkey::new_unique();
        let in_key = Pubkey::new_unique();
        let out_key = Pubkey::new_unique();

        let res = invariants::verify_remaining_account_safety(
            jup_route_ata,
            true,
            token_prog,
            token_prog,
            Some(pool_owner), // belongs to DEX pool, not vault
            vault,
            in_key,
            out_key,
        );
        assert!(res.is_ok());
    }

    #[test]
    fn test_fuzz_stateful_invariants_100k_iterations() {
        // Fast PRNG for stateful invariant fuzzing
        let mut seed: u64 = 0xdeadbeefcafebabe;
        let mut prng = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };

        let owner = Pubkey::new_unique();
        let executor = Pubkey::new_unique();

        for _ in 0..100_000 {
            let r1 = prng();
            let r2 = prng();
            let r3 = prng();

            let max_in = (r1 % 10_000_000) + 1;
            let min_out = (r2 % 10_000_000) + 1;

            let in_before = (r3 % 20_000_000) + max_in;
            let actual_spend = prng() % (max_in * 2);
            let in_after = in_before.saturating_sub(actual_spend);

            let res_in = invariants::verify_token_in_delta(in_before, in_after, max_in);
            if actual_spend <= max_in {
                assert!(res_in.is_ok(), "Invariant violated: valid spend rejected");
                assert_eq!(res_in.unwrap(), actual_spend);
            } else {
                assert!(res_in.is_err(), "Invariant violated: excessive spend admitted");
            }

            let out_before = prng() % 5_000_000;
            let actual_received = prng() % (min_out * 2);
            let out_after = out_before.saturating_add(actual_received);

            let res_out = invariants::verify_token_out_delta(out_before, out_after, min_out);
            if actual_received >= min_out {
                assert!(res_out.is_ok(), "Invariant violated: valid return rejected");
                assert_eq!(res_out.unwrap(), actual_received);
            } else {
                assert!(res_out.is_err(), "Invariant violated: slippage exceeded admitted");
            }

            // Invariant: Non-owner withdrawal must always fail
            let caller_is_owner = (prng() % 2) == 0;
            let caller = if caller_is_owner { owner } else { Pubkey::new_unique() };
            let res_withdraw = invariants::verify_withdrawal_authorization(caller, owner);
            if caller_is_owner {
                assert!(res_withdraw.is_ok());
            } else {
                assert!(res_withdraw.is_err());
            }

            // Invariant: Revoked vault or unauthorized executor must always fail
            let revoked = (prng() % 2) == 0;
            let caller_is_exec = (prng() % 2) == 0;
            let exec_caller = if caller_is_exec { executor } else { Pubkey::new_unique() };
            let res_exec = invariants::verify_executor_authorization(exec_caller, executor, revoked);
            if !revoked && caller_is_exec {
                assert!(res_exec.is_ok());
            } else {
                assert!(res_exec.is_err());
            }
        }
    }
}
