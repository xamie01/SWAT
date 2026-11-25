import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXECUTION_GRANT_PUBLIC_COLUMNS, projectExecutionGrant, type ExecutionGrantProjectionRow } from './execution-grant-projection.js';

const row: ExecutionGrantProjectionRow = { id: 'grant', user_id: 'user', chain: 'solana', grant_kind: 'solana_vault',
  account_address: 'account', has_sealed_secret: false, key_version: null, scope_policy: null,
  expires_at: null, revoked_at: null, status: 'active', created_at: new Date('2026-11-24') };

describe('metadata-only execution grant projection; no PostgreSQL execution', () => {
  it('does not require a ciphertext column read to return presence metadata', () => {
    expect(EXECUTION_GRANT_PUBLIC_COLUMNS).toContain('key_version IS NOT NULL AS has_sealed_secret');
    expect(EXECUTION_GRANT_PUBLIC_COLUMNS).not.toMatch(/\bsealed_secret\b/);
    expect(EXECUTION_GRANT_PUBLIC_COLUMNS).not.toMatch(/\bsecret_binding\b/);
  });

  it('pins the predecessor constraint that makes key-version presence equivalent', () => {
    const sql = readFileSync(new URL('../sql/047_user_execution_grants.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/CONSTRAINT chk_ueg_secret_matches_kind CHECK\s*\(\s*CASE WHEN grant_kind = ANY \(ARRAY\['solana_vault'\]\) THEN\s*sealed_secret IS NULL AND key_version IS NULL\s*ELSE\s*sealed_secret IS NOT NULL\s*AND key_version IS NOT NULL/);
  });

  it.each([false, true])('only maps public fields when presence is %s', present => {
    const result = projectExecutionGrant({ ...row, has_sealed_secret: present, key_version: present ? 7 : null,
      sealed_secret: 'inert-private-field', secret_binding: { private: true } } as ExecutionGrantProjectionRow);
    expect(result.hasSealedSecret).toBe(present);
    expect(result.keyVersion).toBe(present ? 7 : null);
    expect(result).not.toHaveProperty('sealed_secret');
    expect(result).not.toHaveProperty('sealedSecret');
    expect(result).not.toHaveProperty('secretBinding');
    expect(result).not.toHaveProperty('secret_binding');
  });

  it('has only type imports and no ambient database acquisition', () => {
    const source = readFileSync(new URL('./execution-grant-projection.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/import\s+(?!type\b).*from/);
    expect(source).not.toMatch(/\b(?:Pool|connect|scopedQuery|withTenantTransaction)\b/);
  });
});
