import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Keyless structural source regressions and source-derived arithmetic fixtures only.
// This scanner is NOT a Rust parser/compiler, Anchor ABI validation, instruction
// dispatch, Jupiter CPI execution, transaction rollback, or deployment acceptance.
const raw = readFileSync(new URL('../programs/wake-vault/src/lib.rs', import.meta.url), 'utf8');
const source = raw.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
const compact = (text: string): string => text.replace(/\s+/g, ' ').trim();

function body(marker: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = source.search(new RegExp(`${escaped}\\b`));
  if (start < 0) throw new Error(`Missing source declaration ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  let quoted = false;
  for (let at = open; at < source.length; at++) {
    const ch = source[at];
    if (ch === '"' && source[at - 1] !== '\\') quoted = !quoted;
    if (quoted) continue;
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(open + 1, at);
  }
  throw new Error(`Unbalanced declaration ${marker}`);
}

function account(context: string, field: string): { attributes: string; type: string } {
  const accounts = [...body(`pub struct ${context}`).matchAll(/#\[account\(([\s\S]*?)\)\]\s*pub (\w+): ([^\n]+),/g)];
  const found = accounts.find(match => match[2] === field);
  if (!found) throw new Error(`Missing constrained account ${context}.${field}`);
  return { attributes: compact(found[1]), type: compact(found[3]) };
}

function ordered(text: string, ...markers: string[]): void {
  let position = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker, position + 1);
    expect(next, `ordered source marker ${marker}`).toBeGreaterThan(position);
    position = next;
  }
}

type Value = bigint | string;
type Bindings = Record<string, Value>;
// Restricted comparator interpreter of actual require!/require_keys_* expressions.
// Evaluates source predicates against fixtures, not compiled Rust or account state.
function predicateFailure(functionName: string, values: Bindings): string | undefined {
  const code = body(`pub fn ${functionName}`);
  const guards = [...code.matchAll(/require(!|_keys_eq!|_keys_neq!)\(([^;]+)\);/g)];
  if (!guards.length) throw new Error(`No guards in ${functionName}`);
  const value = (name: string): Value => {
    if (name === 'Pubkey::default()') return 'default';
    if (/^\d+$/.test(name)) return BigInt(name);
    if (!(name in values)) throw new Error(`Unknown fixture binding ${name}`);
    return values[name];
  };
  for (const guard of guards) {
    const args = guard[2].split(',').map(item => item.trim()).filter(Boolean);
    const error = args.pop();
    let left: string;
    let right: string;
    let operator: string;
    if (guard[1] === '!') {
      const parsed = /^(\S+)\s+(==|!=|<=|>=|<|>)\s+(\S+)$/.exec(args[0]);
      if (!parsed) throw new Error(`Unsupported source guard ${args[0]}`);
      [, left, operator, right] = parsed;
    } else {
      [left, right] = args;
      operator = guard[1] === '_keys_eq!' ? '==' : '!=';
    }
    const a = value(left);
    const b = value(right);
    const passed = operator === '==' ? a === b : operator === '!=' ? a !== b
      : operator === '<=' ? a <= b : operator === '>=' ? a >= b
        : operator === '<' ? a < b : a > b;
    if (!passed) return error;
  }
  return undefined;
}

const policyFixture = (): Bindings => ({
  'policy.executor': 'executor', executor: 'executor',
  'policy.input_mint': 'input', input_mint: 'input',
  'policy.output_mint': 'output', output_mint: 'output',
  'policy.expires_at': 200n, now: 100n,
  'policy.max_input_per_swap': 50n, max_in: 50n,
  'policy.min_output_per_swap': 20n, min_out: 20n,
  'policy.remaining_input_budget': 100n,
});

describe('package26 wake policy source regressions (keyless, not Rust/runtime acceptance)', () => {
  it('resolves every handler context, new invariant call and error reference in source', () => {
    for (const context of source.matchAll(/Context(?:<'[^\n]+?,\s*|<)([A-Z]\w+)/g)) {
      expect(source).toMatch(new RegExp(`pub struct ${context[1]}\\b`));
    }
    for (const call of source.matchAll(/invariants::(\w+)\(/g)) {
      expect(source).toMatch(new RegExp(`pub fn ${call[1]}\\b`));
    }
    const errors = body('pub enum VaultError');
    for (const error of source.matchAll(/VaultError::(\w+)/g)) {
      expect(errors).toMatch(new RegExp(`\\b${error[1]},`));
    }
  });

  it('preserves serialized WakeVault/WakeConfig fields, lengths and the existing error prefix', () => {
    expect(compact(body('pub struct WakeVault'))).toBe('pub owner: Pubkey, pub bump: u8, pub revoked: bool,');
    expect(compact(body('impl WakeVault'))).toBe('pub const LEN: usize = 32 + 1 + 1;');
    expect(compact(body('pub struct WakeConfig'))).toBe('pub admin: Pubkey, pub executor: Pubkey, pub tip_accounts: [Pubkey; 8], pub max_tip_lamports: u64, pub bump: u8,');
    expect(compact(body('impl WakeConfig'))).toBe('pub const LEN: usize = 32 + 32 + (32 * 8) + 8 + 1;');
    const variants = [...body('pub enum VaultError').matchAll(/^\s*(\w+),/gm)].map(match => match[1]);
    expect(variants.slice(0, 18)).toEqual([
      'ExecutorRevoked', 'UnauthorizedExecutor', 'UnauthorizedAdmin', 'UnauthorizedOwner', 'UnknownCpiTarget',
      'ZeroWithdrawalAmount', 'InsufficientFunds', 'UnauthorizedVaultAccount', 'ExcessiveSpend', 'SlippageExceeded',
      'ArithmeticUnderflow', 'ArithmeticOverflow', 'LamportsDrained', 'IdenticalSwapTokens', 'MintMismatch',
      'AlreadyInitialized', 'ZeroMinOutNotAllowed', 'MissingOutputTokenAccount',
    ]);
  });

  it('binds policy creation and closure to the vault owner and canonical separate PDA', () => {
    for (const context of ['InitializeSwapPolicy', 'ManageSwapPolicy']) {
      const vault = account(context, 'vault').attributes;
      expect(vault).toContain('seeds = [b"vault", owner.key().as_ref()]');
      expect(vault).toContain('has_one = owner @ VaultError::UnauthorizedOwner');
      expect(account(context, 'owner').type).toBe("Signer<'info>");
      expect(account(context, 'swap_policy').attributes).toContain('seeds = [b"swap_policy", vault.key().as_ref()]');
    }
    expect(account('InitializeSwapPolicy', 'swap_policy').attributes).toContain('init, payer = owner');
    const close = account('ManageSwapPolicy', 'swap_policy').attributes;
    expect(close).toContain('mut, close = owner');
    expect(close).toContain('has_one = vault @ VaultError::InvalidSwapPolicy');
    const initialize = compact(body('pub fn initialize_swap_policy'));
    for (const field of ['executor', 'input_mint', 'output_mint', 'expires_at', 'max_input_per_swap', 'min_output_per_swap', 'remaining_input_budget']) {
      expect(initialize).toContain(`policy.${field} = ${field};`);
    }
    expect(initialize).toContain('policy.vault = ctx.accounts.vault.key();');
    expect(initialize).toContain('policy.bump = ctx.bumps.swap_policy;');
    expect(compact(body('pub fn close_swap_policy'))).toBe('Ok(())');
  });

  it('requires mutable vault-bound policy and both owner-authorized and live global executor', () => {
    const policy = account('ExecuteSwap', 'swap_policy');
    expect(policy.type).toBe("Account<'info, WakeSwapPolicy>");
    expect(policy.attributes).toContain('mut, seeds = [b"swap_policy", vault.key().as_ref()]');
    expect(policy.attributes).toContain('bump = swap_policy.bump');
    expect(policy.attributes).toContain('has_one = vault @ VaultError::InvalidSwapPolicy');
    expect(policy.attributes).toContain('has_one = executor @ VaultError::UnauthorizedExecutor');
    expect(account('ExecuteSwap', 'executor').type).toBe("Signer<'info>");
    expect(account('ExecuteSwap', 'executor').attributes).toContain('executor.key() == config.executor');
    const swap = compact(body('pub fn execute_swap'));
    expect(swap).toContain('require!(!vault.revoked, VaultError::ExecutorRevoked)');
    ordered(swap, 'invariants::verify_swap_policy(', 'invoke_signed(');
    expect(swap).toContain('&ctx.accounts.swap_policy, ctx.accounts.executor.key(), ctx.accounts.vault_token_in.mint, ctx.accounts.vault_token_out.mint, Clock::get()?.unix_timestamp, max_in, min_out,');
  });

  it('evaluates exact source policy predicates at boundary fixtures without executing Rust', () => {
    expect(predicateFailure('verify_swap_policy', policyFixture())).toBeUndefined();
    const cases: [Bindings, string][] = [
      [{ executor: 'attacker' }, 'UnauthorizedExecutor'],
      [{ input_mint: 'other' }, 'MintMismatch'],
      [{ output_mint: 'other' }, 'MintMismatch'],
      [{ 'policy.output_mint': 'input', output_mint: 'input' }, 'InvalidSwapPolicy'],
      [{ now: 200n }, 'SwapPolicyExpired'],
      [{ now: 201n }, 'SwapPolicyExpired'],
      [{ max_in: 0n }, 'SwapPolicyBoundsExceeded'],
      [{ max_in: 51n }, 'SwapPolicyBoundsExceeded'],
      [{ min_out: 19n }, 'SwapPolicyBoundsExceeded'],
      [{ 'policy.remaining_input_budget': 49n }, 'SwapBudgetExceeded'],
      [{ 'policy.executor': 'default' }, 'InvalidSwapPolicy'],
      [{ 'policy.min_output_per_swap': 0n }, 'InvalidSwapPolicy'],
      [{ 'policy.max_input_per_swap': 0n }, 'InvalidSwapPolicy'],
    ];
    for (const [patch, error] of cases) {
      expect(predicateFailure('verify_swap_policy', { ...policyFixture(), ...patch })).toBe(`VaultError::${error}`);
    }
    expect(predicateFailure('verify_swap_policy', { ...policyFixture(), now: 199n, 'policy.remaining_input_budget': 50n })).toBeUndefined();
  });

  it('charges checked actual debit only after CPI reload, scope, native and token postconditions', () => {
    const swap = compact(body('pub fn execute_swap'));
    ordered(swap, 'invoke_signed(', 'ctx.accounts.vault_token_in.reload()?', 'ctx.accounts.vault_token_out.reload()?',
      'invariants::verify_native_sol_preservation(', 'invariants::verify_token_account_scope(&ctx.accounts.vault_token_in',
      'invariants::verify_token_account_scope(&ctx.accounts.vault_token_out',
      'let spent = invariants::verify_token_in_delta(in_before, in_after, max_in)?;',
      'invariants::verify_token_out_delta(out_before, out_after, min_out)?;',
      'invariants::consume_swap_budget(&mut ctx.accounts.swap_policy, spent)?;', 'Ok(())');
    const charge = compact(body('pub fn consume_swap_budget'));
    ordered(charge, 'policy.remaining_input_budget.checked_sub(spent)', '.ok_or(VaultError::SwapBudgetExceeded)?;',
      'policy.remaining_input_budget = remaining;', 'Ok(())');
    expect(swap).not.toContain('consume_swap_budget(&mut ctx.accounts.swap_policy, max_in)');
    expect(body('pub fn verify_token_in_delta')).toContain('in_before.checked_sub(in_after)');
    expect(body('pub fn verify_token_out_delta')).toContain('out_after.checked_sub(out_before)');
  });

  it('evaluates source token-delta predicates for exact, lower, excessive and insufficient returns', () => {
    expect(predicateFailure('verify_token_in_delta', { in_spent: 30n, max_in: 50n })).toBeUndefined();
    expect(predicateFailure('verify_token_in_delta', { in_spent: 50n, max_in: 50n })).toBeUndefined();
    expect(predicateFailure('verify_token_in_delta', { in_spent: 51n, max_in: 50n })).toBe('VaultError::ExcessiveSpend');
    expect(predicateFailure('verify_token_out_delta', { min_out: 20n, out_received: 20n })).toBeUndefined();
    expect(predicateFailure('verify_token_out_delta', { min_out: 20n, out_received: 19n })).toBe('VaultError::SlippageExceeded');
    expect(predicateFailure('verify_token_out_delta', { min_out: 0n, out_received: 20n })).toBe('VaultError::ZeroMinOutNotAllowed');
  });

  it('rejects writable control/governance aliases before CPI and forwards only readonly vault signer', () => {
    const swap = compact(body('pub fn execute_swap'));
    expect(account('ExecuteSwap', 'vault').attributes).not.toMatch(/\bmut\b/);
    expect(account('ExecuteSwap', 'config').attributes).not.toMatch(/\bmut\b/);
    const scan = swap.slice(swap.indexOf('for acc in ctx.remaining_accounts.iter()'), swap.indexOf('let seeds ='));
    expect(scan).toContain('!acc.is_writable || ( acc.owner != ctx.program_id && acc.owner != &solana_program::system_program::ID');
    for (const key of ['vault_key', 'config_key', 'policy_key', 'executor_key', 'token_prog_key', 'swap_program_key']) {
      expect(scan).toContain(`&& acc.key() != ${key}`);
    }
    expect(scan).toContain('VaultError::UnsupportedWritableResource');
    expect(scan).toContain('invariants::verify_remaining_account_safety(');
    ordered(swap, 'VaultError::MissingOutputTokenAccount', 'VaultError::MissingInputTokenAccount', 'VaultError::UnsupportedWritableResource', 'invoke_signed(');
    expect(swap).toContain('is_signer: a.key == &vault_key');
    expect(swap).toContain('is_writable: a.is_writable && a.key != &vault_key');
    expect(swap).toContain('cpi_infos.push(ctx.accounts.swap_program.to_account_info())');
    expect(swap).toContain('&cpi_infos, signer,');
    expect(account('ExecuteSwap', 'swap_program').attributes).toContain('constraint = swap_program.executable');
  });

  it('checks token owner, mint, delegate and close scope around the untrusted CPI', () => {
    const swap = compact(body('pub fn execute_swap'));
    ordered(swap, 'invariants::verify_token_account_scope(&ctx.accounts.vault_token_in',
      'invariants::verify_token_account_scope(&ctx.accounts.vault_token_out', 'invoke_signed(',
      'invariants::verify_token_account_scope(&ctx.accounts.vault_token_in',
      'invariants::verify_token_account_scope(&ctx.accounts.vault_token_out');
    const scope = compact(body('pub fn verify_token_account_scope'));
    expect(scope).toContain('require_keys_eq!(account.owner, vault, VaultError::InvalidTokenAccountScope)');
    expect(scope).toContain('require_keys_eq!(account.mint, mint, VaultError::MintMismatch)');
    expect(scope).toContain('account.delegate.is_none()');
    expect(scope).toContain('account.delegated_amount == 0');
    expect(scope).toContain('COption::Some(authority) = account.close_authority');
    expect(scope).toContain('require_keys_eq!(authority, vault, VaultError::InvalidTokenAccountScope)');
  });

  it('initializes a singleton delayed proposal without live config mutation or instant admin transfer', () => {
    const proposal = account('UpdateConfig', 'config_change').attributes;
    expect(proposal).toContain('init, payer = admin');
    expect(proposal).toContain('seeds = [b"config_change", config.key().as_ref()]');
    expect(proposal).not.toContain('init_if_needed');
    expect(account('UpdateConfig', 'config').attributes).toContain('has_one = admin');
    expect(account('UpdateConfig', 'admin').type).toBe("Signer<'info>");
    const update = compact(body('pub fn update_config'));
    expect(update).toContain('change.config = config.key();');
    expect(update).toContain('change.proposer = ctx.accounts.admin.key();');
    expect(update).toContain('.checked_add(CONFIG_CHANGE_DELAY_SECONDS) .ok_or(VaultError::ArithmeticOverflow)?');
    expect(source).toMatch(/CONFIG_CHANGE_DELAY_SECONDS: i64 = 86_400;/);
    expect(update).not.toMatch(/\bconfig\.\w+\s*=/);
    const apply = compact(body('pub fn apply_config_change'));
    ordered(apply, 'invariants::verify_config_change(', 'config.executor = change.executor;', 'config.admin = change.next_admin;');
  });

  it('binds apply/cancel to current admin, proposal config/proposer and fixed rent destination', () => {
    for (const context of ['ApplyConfigChange', 'CancelConfigChange']) {
      expect(account(context, 'admin').type).toBe("Signer<'info>");
      expect(account(context, 'config').attributes).toContain('has_one = admin @ VaultError::UnauthorizedAdmin');
      const change = account(context, 'config_change').attributes;
      expect(change).toContain('mut, close = admin');
      expect(change).toContain('seeds = [b"config_change", config.key().as_ref()]');
      expect(change).toContain('bump = config_change.bump');
      expect(change).toContain('has_one = config @ VaultError::InvalidConfigChange');
      expect(change).toContain('constraint = config_change.proposer == admin.key()');
    }
    expect(account('ApplyConfigChange', 'next_admin').type).toBe("Signer<'info>");
    expect(account('ApplyConfigChange', 'next_admin').attributes).toContain('next_admin.key() == config_change.next_admin');
    expect(compact(body('pub fn cancel_config_change'))).toBe('Ok(())');
  });

  it('evaluates source proposal delay and signer predicates including unchanged-admin acceptance', () => {
    const fixture: Bindings = {
      'change.proposer': 'admin', admin: 'admin', 'change.next_admin': 'successor', next_admin: 'successor',
      'change.executor': 'executor', 'change.activate_after': 86_500n, now: 86_500n,
    };
    expect(predicateFailure('verify_config_change', fixture)).toBeUndefined();
    expect(predicateFailure('verify_config_change', { ...fixture, now: 86_499n })).toBe('VaultError::ConfigChangeNotReady');
    expect(predicateFailure('verify_config_change', { ...fixture, admin: 'attacker' })).toBe('VaultError::UnauthorizedAdmin');
    expect(predicateFailure('verify_config_change', { ...fixture, next_admin: 'attacker' })).toBe('VaultError::UnauthorizedSuccessor');
    expect(predicateFailure('verify_config_change', { ...fixture, 'change.next_admin': 'admin', next_admin: 'admin' })).toBeUndefined();
  });
});
