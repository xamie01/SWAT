import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn(), scopedQuery: vi.fn(), tenantTransaction: vi.fn() }));

// No real client/tenancy role/environment initialization is imported by this suite.
vi.mock('./client.js', () => ({ query: mocks.query }));
vi.mock('./transaction.js', () => ({ withTransaction: vi.fn() }));
vi.mock('./tenancy.js', () => ({
  isCrossTenant: (scope: { userId: string }) => scope.userId === '*',
  forUser: (userId: string) => ({ userId }), crossTenantScope: () => ({ userId: '*' }),
  scopedQuery: mocks.scopedQuery, withTenantTransaction: mocks.tenantTransaction
}));

import {
  assertGrantSecretMatchesKind,
  ExecutionGrantConflictError,
  findActiveExecutionGrant,
  grantKindRequiresExpiry,
  InvalidExecutionGrantError,
  isKeylessGrantKind,
  KEYLESS_GRANT_KINDS,
  listExecutionGrants,
  listExpiringExecutionGrants,
  loadSealedGrantSecret,
  normalizeGrantAccountAddress,
  recordExecutionGrant,
  revokeExecutionGrant,
  markExecutionGrantCompromised,
  retireLapsedExecutionGrants,
  type GrantKind
} from './execution-grants.js';
import { crossTenantScope, forUser } from './tenancy.js';
import { buildCustodySecretBinding } from './custody-contract.js';

/**
 * Delegated-authority grants (`S4-7`, migration `047`).
 *
 * Two things are asserted here that a database cannot assert for us: that the
 * public read projection has no path to `sealed_secret`, and that the SQL text of
 * `047` still expresses the keyless invariant as a *set*. The constraint's
 * behaviour is covered by `tests/integration/user-execution.integration.test.ts`;
 * what this file guards is the shape of the statement, which is what decides
 * whether the next keyless venue fails loudly or quietly acquires a key.
 */

const SOLANA_VAULT = 'So11111111111111111111111111111111111111112';
const EVM_ACCOUNT = '0x1234567890abcdef1234567890abcdef12345678';
const scope = forUser('11111111-2222-3333-4444-555555555555');

/**
 * DDL statements in a migration that are not re-runnable.
 *
 * Comments are stripped first: the prose in these files talks about `CREATE`, and
 * `created_at` starts with the same six letters, so a line-anchored match on the
 * raw text finds statements that do not exist.
 */
function nonIdempotentStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.replace(/--[^\n]*/g, '').trim())
    .filter((statement) => /^(?:CREATE|ALTER|DROP)\s/i.test(statement))
    .filter((statement) => !/IF NOT EXISTS/i.test(statement))
    .map((statement) => statement.slice(0, 100));
}

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant-1',
    user_id: scope.userId,
    chain: 'solana',
    grant_kind: 'solana_vault',
    account_address: SOLANA_VAULT,
    has_sealed_secret: false,
    key_version: null,
    scope_policy: null,
    expires_at: null,
    revoked_at: null,
    status: 'active',
    created_at: new Date('2026-08-01T00:00:00.000Z'),
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockResolvedValue([grantRow()]);
  mocks.scopedQuery.mockImplementation(async (tenant, sql, values) => {
    expect(tenant).toEqual(scope);
    if (tenant.userId === '*') throw new Error('Cross-tenant queries blocked');
    return mocks.query(sql, values);
  });
});

describe('grant kind sets', () => {
  it('treats solana_vault as the only keyless kind', () => {
    expect([...KEYLESS_GRANT_KINDS]).toEqual(['solana_vault']);
    expect(isKeylessGrantKind('solana_vault')).toBe(true);
    for (const kind of ['eip7702', 'session_key_4337', 'polymarket_signer'] as GrantKind[]) {
      expect(isKeylessGrantKind(kind)).toBe(false);
    }
  });

  it('requires an expiry only for the session-shaped kinds', () => {
    expect(grantKindRequiresExpiry('eip7702')).toBe(true);
    expect(grantKindRequiresExpiry('session_key_4337')).toBe(true);
    expect(grantKindRequiresExpiry('solana_vault')).toBe(false);
    expect(grantKindRequiresExpiry('polymarket_signer')).toBe(false);
  });
});

describe('assertGrantSecretMatchesKind', () => {
  it('accepts a keyless grant with neither secret nor version', () => {
    expect(() => assertGrantSecretMatchesKind({ grantKind: 'solana_vault' })).not.toThrow();
  });

  it('rejects a keyless grant carrying a secret', () => {
    expect(() =>
      assertGrantSecretMatchesKind({
        grantKind: 'solana_vault',
        sealedSecret: 'v1.env.abc',
        keyVersion: 1
      })
    ).toThrow(InvalidExecutionGrantError);
  });

  it('rejects a keyless grant carrying only a key version', () => {
    // The half-populated case is the one a rotation bug produces: it looks
    // harmless because no ciphertext is present, and it makes a keyless row claim
    // to be openable.
    expect(() =>
      assertGrantSecretMatchesKind({ grantKind: 'solana_vault', keyVersion: 2 })
    ).toThrow(/keyless/);
  });

  it.each(['eip7702', 'session_key_4337', 'polymarket_signer'] as GrantKind[])(
    'rejects %s with no secret',
    (grantKind) => {
      expect(() => assertGrantSecretMatchesKind({ grantKind })).toThrow(
        /requires a sealed secret/
      );
    }
  );

  it('rejects a keyed grant with a secret but no version', () => {
    expect(() =>
      assertGrantSecretMatchesKind({ grantKind: 'polymarket_signer', sealedSecret: 'v1.env.abc' })
    ).toThrow(/requires a sealed secret and a key version/);
  });

  it('rejects a secret that is not a versioned envelope', () => {
    expect(() =>
      assertGrantSecretMatchesKind({
        grantKind: 'polymarket_signer',
        sealedSecret: 'YmFzZTY0LW9ubHk=',
        keyVersion: 1
      })
    ).toThrow(/versioned envelope/);
  });

  it('accepts a versioned envelope', () => {
    expect(() =>
      assertGrantSecretMatchesKind({
        grantKind: 'polymarket_signer',
        sealedSecret: 'v1.env-local.Zm9vYmFy',
        keyVersion: 1
      })
    ).not.toThrow();
  });
});

describe('normalizeGrantAccountAddress', () => {
  it('lowercases an EVM account so uq_ueg_account cannot be defeated by case', () => {
    expect(normalizeGrantAccountAddress('polygon', EVM_ACCOUNT.toUpperCase().replace('0X', '0x')))
      .toBe(EVM_ACCOUNT);
  });

  it('preserves Solana case', () => {
    expect(normalizeGrantAccountAddress('solana', SOLANA_VAULT)).toBe(SOLANA_VAULT);
  });

  it('strips a matching chain prefix rather than storing it', () => {
    expect(normalizeGrantAccountAddress('polygon', `polygon:${EVM_ACCOUNT}`)).toBe(EVM_ACCOUNT);
  });

  it('rejects a prefix that disagrees with the grant chain', () => {
    expect(() => normalizeGrantAccountAddress('polygon', `solana:${SOLANA_VAULT}`)).toThrow(
      InvalidExecutionGrantError
    );
  });

  it('rejects an EVM-shaped address on solana', () => {
    expect(() => normalizeGrantAccountAddress('solana', EVM_ACCOUNT)).toThrow(
      /not a valid solana address/
    );
  });

  it('rejects a malformed address', () => {
    expect(() => normalizeGrantAccountAddress('polygon', '0xdeadbeef')).toThrow(
      InvalidExecutionGrantError
    );
  });
});

describe('recordExecutionGrant', () => {
  it('writes the normalised account address', async () => {
    mocks.query.mockResolvedValue([
      grantRow({ chain: 'polygon', grant_kind: 'polymarket_signer', account_address: EVM_ACCOUNT })
    ]);

    const id = '11111111-1111-4111-8111-111111111111';
    await recordExecutionGrant(scope, {
      id, chain: 'polygon', grantKind: 'polymarket_signer',
      accountAddress: EVM_ACCOUNT.toUpperCase().replace('0X', '0x'),
      sealedSecret: ['v2','fixture-wrapper','1',Buffer.from('x').toString('base64'),Buffer.alloc(12).toString('base64'),
        Buffer.alloc(16).toString('base64'),Buffer.from('x').toString('base64')].join('.'),
      keyVersion: 1,
      secretBinding: buildCustodySecretBinding({ deploymentId: 'fixture-deployment', chainId: '137', userId: scope.userId,
        grantId: id, chain: 'polygon', grantKind: 'polymarket_signer', accountAddress: EVM_ACCOUNT,
        keyVersion: 1, scopePolicy: null, expiresAt: null })
    });

    const [, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(values[0]).toBe(scope.userId);
    expect(values[3]).toBe(EVM_ACCOUNT);
  });

  it('takes user_id from the scope, never from the caller', async () => {
    await recordExecutionGrant(scope, {
      chain: 'solana',
      grantKind: 'solana_vault',
      accountAddress: SOLANA_VAULT
    });
    const [, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(values[0]).toBe(scope.userId);
  });

  it('refuses a session grant with no expiry before opening a connection', async () => {
    await expect(
      recordExecutionGrant(scope, {
        chain: 'robinhood-chain',
        grantKind: 'session_key_4337',
        accountAddress: EVM_ACCOUNT,
        sealedSecret: 'v1.env-local.Zm9v',
        keyVersion: 1
      })
    ).rejects.toThrow(/requires expires_at/);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('maps a unique violation to a conflict error', async () => {
    mocks.query.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));
    await expect(
      recordExecutionGrant(scope, {
        chain: 'solana',
        grantKind: 'solana_vault',
        accountAddress: SOLANA_VAULT
      })
    ).rejects.toBeInstanceOf(ExecutionGrantConflictError);
  });

  it('rethrows anything that is not a unique violation', async () => {
    mocks.query.mockRejectedValue(Object.assign(new Error('check violation'), { code: '23514' }));
    await expect(
      recordExecutionGrant(scope, {
        chain: 'solana',
        grantKind: 'solana_vault',
        accountAddress: SOLANA_VAULT
      })
    ).rejects.toThrow(/check violation/);
  });
});

describe('the public read projection', () => {
  it.each([
    ['listExecutionGrants', () => listExecutionGrants(scope)],
    ['findActiveExecutionGrant', () => findActiveExecutionGrant(scope, 'solana', 'solana_vault')]
  ])('never selects sealed_secret (%s)', async (_name, run) => {
    await run();
    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).toContain('sealed_secret IS NOT NULL AS has_sealed_secret');
    // The only occurrence of the bare column name is inside that boolean
    // projection; the second match is the `has_sealed_secret` alias.
    expect(sql.match(/(?<!has_)sealed_secret/g)).toHaveLength(1);
  });

  it.each(['solana_vault', 'eip7702', 'session_key_4337'] as const)('returns public metadata for active %s without granting execution authority', async grantKind => {
    mocks.query.mockResolvedValue([grantRow({ grant_kind: grantKind, sealed_secret: 'inert-ciphertext', secret_binding: { private: true } })]);
    const grant = await findActiveExecutionGrant(scope, grantKind === 'solana_vault' ? 'solana' : 'robinhood-chain', grantKind);
    expect(grant?.grantKind).toBe(grantKind);
    expect(grant).not.toHaveProperty('sealedSecret'); expect(grant).not.toHaveProperty('secretBinding');
    const [sql] = mocks.query.mock.calls[0] as [string];
    expect(sql).not.toContain('grant_kind NOT IN');
    expect(sql).toContain('expires_at > NOW()');
  });

  it('scopes every public read by user_id', async () => {
    await listExecutionGrants(scope);
    await findActiveExecutionGrant(scope, 'solana', 'solana_vault');
    for (const [sql, values] of mocks.query.mock.calls as Array<[string, unknown[]]>) {
      expect(sql).toContain('user_id = $1');
      expect(values[0]).toBe(scope.userId);
    }
  });
});

describe('loadSealedGrantSecret', () => {
  it('stays scoped to the user even though the envelope AAD would also fail', async () => {
    mocks.query.mockResolvedValue([{ sealed_secret: 'v1.env-local.Zm9v', key_version: 3 }]);
    await expect(loadSealedGrantSecret(scope, 'grant-1')).resolves.toEqual({
      sealedSecret: 'v1.env-local.Zm9v',
      keyVersion: 3
    });
    const [sql, values] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('user_id = $2');
    expect(values[1]).toBe(scope.userId);
  });

  it('returns null for a keyless row rather than a half-populated result', async () => {
    mocks.query.mockResolvedValue([{ sealed_secret: null, key_version: null }]);
    await expect(loadSealedGrantSecret(scope, 'grant-1')).resolves.toBeNull();
  });
});

describe('platform sweeps', () => {
  it('refuses listExpiringExecutionGrants without a cross-tenant scope', async () => {
    await expect(listExpiringExecutionGrants(scope, new Date())).rejects.toThrow(
      /crossTenantScope/
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('refuses retireLapsedExecutionGrants without a cross-tenant scope', async () => {
    await expect(retireLapsedExecutionGrants(scope)).rejects.toThrow(/crossTenantScope/);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('blocks cross-tenant expiry sweeps even with a stated reason', async () => {
    await expect(listExpiringExecutionGrants(crossTenantScope('S4-P9 re-consent sweep'), new Date()))
      .rejects.toThrow('separately reviewed privileged capability');
    expect(mocks.scopedQuery).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });

  it('blocks cross-tenant lapse sweeps without a privileged capability', async () => {
    await expect(retireLapsedExecutionGrants(crossTenantScope('S4-P9 lapse sweep')))
      .rejects.toThrow('separately reviewed privileged capability');
    expect(mocks.scopedQuery).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe('tenant-scoped public operations', () => {
  it.each([
    ['record', () => recordExecutionGrant(scope, { chain: 'solana', grantKind: 'solana_vault', accountAddress: SOLANA_VAULT })],
    ['list', () => listExecutionGrants(scope)],
    ['active', () => findActiveExecutionGrant(scope, 'polygon', 'polymarket_signer')],
    ['historical', () => loadSealedGrantSecret(scope, 'grant-1')],
    ['revoke', () => revokeExecutionGrant(scope, 'grant-1')],
    ['compromise', () => markExecutionGrantCompromised(scope, 'grant-1')]
  ])('passes authenticated tenant scope to %s query boundary', async (_name, operation) => {
    await operation(); expect(mocks.scopedQuery).toHaveBeenCalledTimes(1);
    expect(mocks.scopedQuery.mock.calls[0]![0]).toEqual(scope);
  });
  it('does not widen the public grant projection with private lifecycle or custody fields', async () => {
    mocks.query.mockResolvedValue([grantRow({ lifecycle_revision: '8', revocation_tombstone: new Date(),
      sealed_secret: 'inert-ciphertext', secret_binding: { private: true } })]);
    const [grant] = await listExecutionGrants(scope);
    for (const field of ['lifecycleRevision','revocationTombstone','sealedSecret','secretBinding']) expect(grant).not.toHaveProperty(field);
  });
});

describe('047 DDL contract', () => {
  let sql = '';

  beforeEach(async () => {
    sql = await readFile(
      resolve(import.meta.dirname, '../sql/047_user_execution_grants.sql'),
      'utf8'
    );
  });

  it('expresses the keyless invariant as a set, not as an equality on one kind', () => {
    // `grant_kind = 'solana_vault' … OR grant_kind <> 'solana_vault' …` would put a
    // *future* keyless kind in the keyed branch, silently requiring it to carry a
    // secret — the exact inversion of the invariant. The set form makes that
    // addition fail at insert time instead, and names the set once.
    expect(sql).toMatch(/grant_kind = ANY \(ARRAY\['solana_vault'\]\)/);
    expect(sql).not.toMatch(/grant_kind\s*<>\s*'solana_vault'/);
  });

  it('keeps the TypeScript keyless set and the SQL array in agreement', () => {
    const array = /grant_kind = ANY \(ARRAY\[([^\]]*)\]\)/.exec(sql)?.[1] ?? '';
    const kinds = array.split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''));
    expect(kinds).toEqual([...KEYLESS_GRANT_KINDS]);
  });

  it('allows exactly the four documented grant kinds', () => {
    const kinds = /chk_ueg_kind CHECK \(grant_kind IN\s*([^)]*)\)/.exec(sql)?.[1] ?? '';
    expect(kinds.match(/'[a-z0-9_]+'/g)).toEqual([
      "'solana_vault'",
      "'eip7702'",
      "'session_key_4337'",
      "'polymarket_signer'"
    ]);
  });

  it('requires a versioned envelope and a key version on a keyed row', () => {
    expect(sql).toContain('sealed_secret IS NOT NULL');
    expect(sql).toContain('key_version IS NOT NULL');
    expect(sql).toContain("sealed_secret LIKE 'v%'");
  });

  it('requires an expiry on a session-shaped kind', () => {
    expect(sql).toMatch(
      /grant_kind NOT IN \('eip7702','session_key_4337'\)\s+OR expires_at IS NOT NULL/
    );
  });

  it('allows exactly the four documented statuses', () => {
    expect(sql).toContain("status IN ('active','retired','revoked','compromised')");
  });

  it('holds one execution account per chain globally', () => {
    expect(sql).toContain('CONSTRAINT uq_ueg_account UNIQUE (chain, account_address)');
  });

  it('indexes expires_at so the S4-P9 sweep does not scan the table', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_ueg_expiring\s+ON user_execution_grants\(expires_at\)/
    );
  });

  it('permits exactly one active grant per user, chain and kind', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_ueg_active_per_user_chain_kind\s+ON user_execution_grants\(user_id, chain, grant_kind\)\s+WHERE status = 'active'/
    );
  });

  it('replays safely, because migrate.ts has no applied-migrations table', () => {
    // Every statement must be re-runnable: `migrate.ts` replays every file on
    // every invocation under an advisory lock, so one bare CREATE breaks
    // `pnpm db:migrate` for every developer on the second run.
    expect(nonIdempotentStatements(sql)).toEqual([]);
  });
});
