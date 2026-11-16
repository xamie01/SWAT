import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Static source regressions only. These do not compile Rust, dispatch Solana
// instructions, execute Jupiter, or prove transaction rollback/deployment state.
const wake = readFileSync(new URL('../programs/wake-vault/src/lib.rs', import.meta.url), 'utf8');
const minimal = readFileSync(new URL('../programs/pda-vault-minimal/src/lib.rs', import.meta.url), 'utf8');
const section = (source: string, start: string, end: string): string => {
  const begin = source.indexOf(start);
  expect(begin, `missing source marker ${start}`).toBeGreaterThanOrEqual(0);
  const finish = source.indexOf(end, begin + start.length);
  expect(finish, `missing source marker ${end}`).toBeGreaterThan(begin);
  return source.slice(begin, finish);
};

describe('package26 static program boundary regressions (not runtime acceptance)', () => {
  it('requires an owner-signed, vault-bound policy account without enlarging existing vault state', () => {
    const initialize = section(wake, 'pub struct InitializeSwapPolicy', 'pub struct ManageSwapPolicy');
    expect(initialize).toContain('has_one = owner');
    expect(initialize).toContain('pub owner: Signer');
    expect(initialize).toContain('seeds = [b"swap_policy", vault.key().as_ref()]');
    const manage = section(wake, 'pub struct ManageSwapPolicy', 'pub struct InitializeVault');
    expect(manage).toContain('has_one = owner');
    expect(manage).toContain('has_one = vault');
    expect(manage).toContain('pub owner: Signer');
    const execute = section(wake, 'pub struct ExecuteSwap', '// State Data');
    expect(execute).toContain('pub swap_policy: Account');
    expect(execute).toContain('has_one = vault');
    const state = section(wake, 'pub struct WakeVault', '// Error Taxonomy');
    expect(state).toContain('pub const LEN: usize = 32 + 1 + 1;');
  });

  it('checks owner economic bounds before CPI and consumes actual debit only after postconditions', () => {
    const swap = section(wake, 'pub fn execute_swap', '// Account Contexts');
    const policyCheck = swap.indexOf('invariants::verify_swap_policy(');
    const cpi = swap.indexOf('invoke_signed(');
    const debit = swap.indexOf('invariants::verify_token_in_delta(');
    const credit = swap.indexOf('invariants::verify_token_out_delta(');
    const consume = swap.indexOf('invariants::consume_swap_budget(');
    expect(policyCheck).toBeGreaterThanOrEqual(0);
    expect(cpi).toBeGreaterThan(policyCheck);
    expect(debit).toBeGreaterThan(cpi);
    expect(credit).toBeGreaterThan(debit);
    expect(consume).toBeGreaterThan(credit);
    const checks = section(wake, 'pub fn verify_swap_policy', 'pub fn consume_swap_budget');
    for (const field of ['executor', 'input_mint', 'output_mint', 'expires_at', 'max_input_per_swap', 'remaining_input_budget', 'min_output_per_swap']) {
      expect(checks).toContain(`policy.${field}`);
    }
    expect(checks).toContain('now < policy.expires_at');
    expect(checks).toContain('min_out >= policy.min_output_per_swap');
    expect(checks).toContain('max_in <= policy.remaining_input_budget');
  });

  it('stages config changes and admin acceptance instead of assigning live config in update_config', () => {
    const update = section(wake, 'pub fn update_config', 'pub fn apply_config_change');
    expect(update).toContain('CONFIG_CHANGE_DELAY_SECONDS');
    expect(update).not.toContain('config.executor =');
    expect(update).not.toContain('config.admin =');
    const apply = section(wake, 'pub fn apply_config_change', 'pub fn cancel_config_change');
    expect(apply).toContain('invariants::verify_config_change(');
    expect(apply.indexOf('invariants::verify_config_change(')).toBeLessThan(apply.indexOf('config.executor ='));
    const accounts = section(wake, 'pub struct ApplyConfigChange', 'pub struct CancelConfigChange');
    expect(accounts).toContain('pub admin: Signer');
    expect(accounts).toContain('pub next_admin: Signer');
    expect(accounts).toContain('has_one = config');
    const check = section(wake, 'pub fn verify_config_change', 'pub fn verify_token_account_scope');
    expect(check).toContain('now >= change.activate_after');
    expect(check).toContain('change.next_admin');
    expect(check).toContain('change.proposer');
  });

  it('makes the vault readonly in CPI, rejects unsupported writable resources and rechecks token authority', () => {
    const swap = section(wake, 'pub fn execute_swap', '// Account Contexts');
    expect(swap).toContain('acc.owner == &token_prog_key');
    expect(swap).toContain('VaultError::UnsupportedWritableResource');
    expect(swap).toContain('is_writable: a.is_writable && a.key != &vault_key');
    expect(swap).toContain('cpi_infos.push(ctx.accounts.swap_program.to_account_info())');
    expect(swap.match(/invariants::verify_token_account_scope\(/g)).toHaveLength(4);
    const context = section(wake, 'pub struct ExecuteSwap', '// State Data');
    expect(context).toContain('constraint = swap_program.executable');
    expect(swap).toContain('VaultError::MissingInputTokenAccount');
  });

  it('keeps minimal withdrawal System-account checks before CPI', () => {
    const handler = section(minimal, '// Tag 0:', '// Tag 1:');
    const cpi = handler.indexOf('invoke_signed(');
    for (const check of ['system_program::ID', 'system_program_info.executable', 'vault_info.owner', 'vault_info.data_is_empty()', 'vault_info.is_writable', 'destination_info.is_writable']) {
      const at = handler.indexOf(check);
      expect(at, check).toBeGreaterThanOrEqual(0);
      expect(at, check).toBeLessThan(cpi);
    }
    expect(handler).toContain('instruction_data.len() != 9');
    expect(minimal).toContain('fn rejects_incompatible_accounts_through_dispatch');
  });
});
