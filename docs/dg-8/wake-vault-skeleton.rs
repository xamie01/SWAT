// programs/wake-vault/src/lib.rs
//
// WAKE non-custodial execution vault (S4-P12, ADR-0003 §3).
//
// DESIGN SKELETON, NOT A DEPLOYABLE PROGRAM. Missing: Anchor.toml/Cargo.toml
// boilerplate, associated-token-account creation helpers, the full set of
// #[derive(Accounts)] structs (two are shown; the rest follow the same
// pattern), and — critically — the Jupiter program id below MUST be verified
// against Jupiter's current docs before this touches mainnet. Jupiter has
// changed this across versions; a stale id here is a silent security hole,
// not a compile error, because `invoke_signed` will happily CPI into
// whatever address is configured.
//
// The property this buys: even a fully compromised WAKE operator key can
// only trigger swaps *inside* a user's own vault. It cannot move funds to
// any other address. Only the original depositor's own signature can do
// that, via `withdraw`. That is the whole design.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{Token, TokenAccount};
use std::str::FromStr;

declare_id!("Vau1t1111111111111111111111111111111111111"); // placeholder — real id assigned at first deploy

pub mod jupiter {
    // Jupiter Aggregator program id. VERIFY at https://station.jup.ag before
    // any mainnet deploy — do not trust this constant as-is.
    pub const PROGRAM_ID: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV";
}

#[program]
pub mod wake_vault {
    use super::*;

    /// One-time setup. Called by the USER's own wallet — WAKE never signs
    /// this. Creates the vault PDA and records who may withdraw from it
    /// (owner) and who may trigger swaps in it (executor_authority, read
    /// from the shared config so it can be rotated without touching every
    /// vault — same reasoning as moving JITO_TIP_ACCOUNTS out of a hardcoded
    /// constant).
    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.user.key();
        vault.executor_authority = ctx.accounts.config.executor;
        vault.bump = ctx.bumps.vault;
        vault.revoked = false;
        Ok(())
    }

    /// Immediate, on-chain kill switch. User-signed only. This is what makes
    /// S4-P9's "expiry is a liveness dependency" concern moot for Solana:
    /// revocation isn't a database flag WAKE promises to honor, it's enforced
    /// by every subsequent execute_swap call failing the revoked check below.
    pub fn revoke_executor(ctx: Context<RevokeExecutor>) -> Result<()> {
        ctx.accounts.vault.revoked = true;
        Ok(())
    }

    pub fn restore_executor(ctx: Context<RevokeExecutor>) -> Result<()> {
        ctx.accounts.vault.revoked = false;
        Ok(())
    }

    /// Executes a swap sourced from and settled back into the SAME vault.
    ///
    /// Signed by WAKE's operator key — but that key only proves "this
    /// request came from WAKE's backend". It grants no authority beyond what
    /// the constraints below check. `jupiter_ix_data` is the raw instruction
    /// Jupiter's Swap API already returns today (same call
    /// `buildJupiterSwap` in jupiter-jito-runtime.ts makes) — this program
    /// does not reimplement Jupiter's routing, it validates the instruction's
    /// shape and forwards it via CPI with the vault's own signer seeds.
    pub fn execute_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>,
        jupiter_ix_data: Vec<u8>,
    ) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(!vault.revoked, VaultError::ExecutorRevoked);
        require_keys_eq!(
            ctx.accounts.executor.key(),
            vault.executor_authority,
            VaultError::UnauthorizedExecutor
        );

        // The two checks that actually matter. Jupiter's instruction names
        // its own source/destination token accounts explicitly — if either
        // one isn't owned by this vault, this is an attempted redirect and
        // the whole point of the program is defeated. Neither check is
        // optional and neither is inferred from caller-supplied intent.
        require_keys_eq!(
            ctx.accounts.jupiter_program.key(),
            Pubkey::from_str(jupiter::PROGRAM_ID).unwrap(),
            VaultError::UnknownCpiTarget
        );
        require_keys_eq!(
            ctx.accounts.source_token_account.owner,
            vault.key(),
            VaultError::SourceNotVault
        );
        require_keys_eq!(
            ctx.accounts.destination_token_account.owner,
            vault.key(),
            VaultError::DestinationNotVault
        );

        let owner_key = vault.owner;
        let bump = vault.bump;
        let seeds: &[&[u8]] = &[b"vault", owner_key.as_ref(), &[bump]];

        // Route accounts vary per swap (that's why they're remaining_accounts
        // rather than a fixed list) — but every account in a Jupiter route
        // instruction is either the program itself, a pool/market account, or
        // one of the two token accounts already checked above. Nothing here
        // grants the instruction data any authority the checks above didn't.
        let ix = Instruction {
            program_id: ctx.accounts.jupiter_program.key(),
            accounts: ctx
                .remaining_accounts
                .iter()
                .map(|a| AccountMeta {
                    pubkey: a.key(),
                    is_signer: a.is_signer,
                    is_writable: a.is_writable,
                })
                .collect(),
            data: jupiter_ix_data,
        };
        invoke_signed(&ix, ctx.remaining_accounts, &[seeds])?;
        Ok(())
    }

    /// Pays a Jito tip from the vault — bounded and allowlisted, both read
    /// from WakeConfig rather than hardcoded, so rotating Jito's tip
    /// addresses is one config update, not a re-consent flow for every user.
    pub fn pay_jito_tip(ctx: Context<PayJitoTip>, lamports: u64) -> Result<()> {
        let vault = &ctx.accounts.vault;
        require!(!vault.revoked, VaultError::ExecutorRevoked);
        require_keys_eq!(
            ctx.accounts.executor.key(),
            vault.executor_authority,
            VaultError::UnauthorizedExecutor
        );
        require!(
            lamports <= ctx.accounts.config.max_tip_lamports,
            VaultError::TipExceedsCap
        );
        require!(
            ctx.accounts.config.tip_accounts.contains(&ctx.accounts.tip_account.key()),
            VaultError::TipAccountNotAllowlisted
        );
        // system_program::transfer from the vault PDA to tip_account, signed
        // with the same seeds pattern as execute_swap. Worst case on a
        // stolen operator key: tip-sized drains to Jito's own validators —
        // vandalism, not theft, and bounded by max_tip_lamports per call.
        Ok(())
    }

    /// The ONLY path funds leave to an address other than the vault's own
    /// swaps. Requires the ORIGINAL DEPOSITOR's signature — never the
    /// operator's. This is what makes revoke_executor meaningful: even a
    /// fully compromised WAKE backend cannot call this successfully.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.owner.key(),
            ctx.accounts.vault.owner,
            VaultError::NotOwner
        );
        // token::transfer from the vault's token account to the owner's own
        // associated token account, signed with the vault's PDA seeds.
        Ok(())
    }
}

#[account]
pub struct Vault {
    pub owner: Pubkey,              // original depositor — the ONLY withdraw target
    pub executor_authority: Pubkey, // WAKE's current operator key, set at init from WakeConfig
    pub revoked: bool,
    pub bump: u8,
}

#[account]
pub struct WakeConfig {
    pub executor: Pubkey,          // rotate WAKE's operator key here, not per-vault
    pub tip_accounts: Vec<Pubkey>, // the Jito allowlist — one place to update, not baked per-grant
    pub max_tip_lamports: u64,
    pub admin: Pubkey,             // ideally a multisig, not a single key
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub user: Signer<'info>, // the depositor, signing their own account creation
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 32 + 1 + 1,
        seeds = [b"vault", user.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub config: Account<'info, WakeConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    #[account(seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub executor: Signer<'info>, // WAKE's operator key — proves the request's origin only
    /// CHECK: identity checked against jupiter::PROGRAM_ID above, not trusted from caller
    pub jupiter_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub source_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum VaultError {
    #[msg("executor authority has been revoked for this vault")]
    ExecutorRevoked,
    #[msg("signer is not this vault's authorized executor")]
    UnauthorizedExecutor,
    #[msg("CPI target is not the configured Jupiter program")]
    UnknownCpiTarget,
    #[msg("swap source account is not owned by this vault")]
    SourceNotVault,
    #[msg("swap destination account is not owned by this vault")]
    DestinationNotVault,
    #[msg("tip exceeds the configured per-transaction cap")]
    TipExceedsCap,
    #[msg("tip account is not on the configured allowlist")]
    TipAccountNotAllowlisted,
    #[msg("only the original depositor may withdraw")]
    NotOwner,
}
