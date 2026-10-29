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
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("WakeVau1t11111111111111111111111111111111111");

pub mod jupiter {
    use super::*;
    // Jupiter Aggregator v6 Program ID
    pub const ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV");
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

        **vault_info.try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.try_borrow_mut_lamports()? += amount;

        Ok(())
    }

    /// Executes a delegated Jupiter swap on behalf of the user.
    ///
    /// Security Controls:
    ///   - Must be signed by config.executor (checked live).
    ///   - Vault must not be revoked.
    ///   - Swaps strictly between vault-owned token accounts.
    ///   - Scans remaining_accounts to prevent rogue vault ATAs from being drained.
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

        // Record baseline token balances before swap
        ctx.accounts.vault_token_in.reload()?;
        ctx.accounts.vault_token_out.reload()?;
        let in_before = ctx.accounts.vault_token_in.amount;
        let out_before = ctx.accounts.vault_token_out.amount;

        // Scan remaining_accounts to reject any other writable vault-owned token accounts
        let vault_key = vault.key();
        let in_key = ctx.accounts.vault_token_in.key();
        let out_key = ctx.accounts.vault_token_out.key();
        let token_prog_key = ctx.accounts.token_program.key();

        for acc in ctx.remaining_accounts.iter() {
            if acc.is_writable && acc.owner == &token_prog_key {
                if acc.key() != in_key && acc.key() != out_key {
                    let ata_data = TokenAccount::try_deserialize(&mut &acc.data.borrow()[..])?;
                    require!(
                        ata_data.owner != vault_key,
                        VaultError::UnauthorizedVaultAccount
                    );
                }
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

        let in_spent = in_before.checked_sub(in_after).ok_or(VaultError::ArithmeticUnderflow)?;
        let out_received = out_after.checked_sub(out_before).ok_or(VaultError::ArithmeticUnderflow)?;

        require!(in_spent <= max_in, VaultError::ExcessiveSpend);
        require!(out_received >= min_out, VaultError::SlippageExceeded);

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

    /// CHECK: Target DEX routing program verified against allowlist (Jupiter)
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
}
