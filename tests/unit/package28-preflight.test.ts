import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { assertPackage28IsolationPreflight } from '../integration/helpers/package28-isolation.js';

const runId = '12345678-1234-4234-8234-123456789abc';
const declared = {
  INTEGRATION_DISPOSABLE: 'true',
  INTEGRATION_RUN_ID: runId,
  SWAT_DB_PROFILE: 'core',
  INTEGRATION_DATABASE_URL: 'postgresql://127.0.0.1:55432/swat_integration_12345678123442348234123456789abc',
  INTEGRATION_REDIS_URL: 'redis://127.0.0.1:56379/0',
  INTEGRATION_REDIS_NAMESPACE: `swat:integration:${runId}`
};

const effects = vi.hoisted(() => ({ imports: vi.fn(), queries: vi.fn() }));
vi.mock('../../packages/db/src/client.js', () => {
  effects.imports();
  return { pool: { query: effects.queries }, closePool: effects.queries };
});

const root = new URL('../../', import.meta.url);
const source = (name: string) => readFileSync(new URL(name, root), 'utf8');

describe('package28 declaration preflight (pure)', () => {
  it('does not accept generic DATABASE_URL or Redis fallbacks', () => {
    expect(() => assertPackage28IsolationPreflight({ DATABASE_URL: declared.INTEGRATION_DATABASE_URL }))
      .toThrow(/explicit INTEGRATION_DISPOSABLE/);
  });
  it.each([undefined, '', '1', 'TRUE', 'false'])('rejects nonexplicit disposal %s', value => {
    expect(() => assertPackage28IsolationPreflight({ ...declared, INTEGRATION_DISPOSABLE: value }))
      .toThrow(/explicit INTEGRATION_DISPOSABLE/);
  });
  it.each([undefined, '', 'lp', 'CORE', ' core', 'unknown'])('rejects noncanonical profile %s', value => {
    expect(() => assertPackage28IsolationPreflight({ ...declared, SWAT_DB_PROFILE: value }))
      .toThrow(/canonical SWAT_DB_PROFILE/);
  });
  it.each([undefined, '', runId.toUpperCase(), '12345678-1234-1234-8234-123456789abc'])('rejects invalid run ID %s', value => {
    expect(() => assertPackage28IsolationPreflight({ ...declared, INTEGRATION_RUN_ID: value }))
      .toThrow(/canonical unique UUIDv4/);
  });
  it.each([
    undefined, '', 'postgresql://db.example:55432/shared_test',
    declared.INTEGRATION_DATABASE_URL.replace('127.0.0.1', 'localhost'),
    declared.INTEGRATION_DATABASE_URL.replace('127.0.0.1', '127.1'),
    declared.INTEGRATION_DATABASE_URL.replace('127.0.0.1', '2130706433'),
    declared.INTEGRATION_DATABASE_URL.replace('127.0.0.1', '0177.0.0.1'),
    declared.INTEGRATION_DATABASE_URL.replace('127.0.0.1', '[::1]'),
    declared.INTEGRATION_DATABASE_URL.replace('postgresql:', 'postgres:'),
    declared.INTEGRATION_DATABASE_URL.replace(':55432', ':5432'),
    declared.INTEGRATION_DATABASE_URL.replace(':55432', ''),
    declared.INTEGRATION_DATABASE_URL.replace(':55432', ':055432'),
    declared.INTEGRATION_DATABASE_URL.replace('swat_integration_12345678123442348234123456789abc', 'shared_test'),
    `${declared.INTEGRATION_DATABASE_URL}?host=prod.example`,
    `${declared.INTEGRATION_DATABASE_URL}?options=-csearch_path=public`,
    `${declared.INTEGRATION_DATABASE_URL}#fixture`,
    ` ${declared.INTEGRATION_DATABASE_URL}`,
    declared.INTEGRATION_DATABASE_URL.replace('swat_', '%73wat_')
  ])('rejects dangerous or noncanonical database declaration %s', value => {
    expect(() => assertPackage28IsolationPreflight({ ...declared, INTEGRATION_DATABASE_URL: value }))
      .toThrow(/canonical loopback disposable endpoints/);
  });
  it.each([undefined, '', 'redis://127.0.0.1:6379', 'redis://127.0.0.1:6379/0',
    'redis://redis.example:56379/0', 'redis://127.1:56379/0', 'redis://127.0.0.1:56379/1',
    'redis://127.0.0.1:56379/0?host=prod.example', 'rediss://127.0.0.1:56379/0'])('rejects unsafe Redis declaration %s', value => {
    expect(() => assertPackage28IsolationPreflight({ ...declared, INTEGRATION_REDIS_URL: value }))
      .toThrow(/canonical loopback disposable endpoints/);
  });
  it.each([
    ['INTEGRATION_DATABASE_URL', 'postgresql://127.0.0.1:55432/other/../swat_integration_12345678123442348234123456789abc'],
    ['INTEGRATION_DATABASE_URL', 'postgresql://127.0.0.1:55432/./swat_integration_12345678123442348234123456789abc'],
    ['INTEGRATION_REDIS_URL', 'redis://127.0.0.1:56379/./0'],
    ['INTEGRATION_REDIS_URL', 'redis://127.0.0.1:56379/other/../0']
  ])('rejects literal dot segments at the endpoint stage: %s %s', (field, value) => {
    expect(() => assertPackage28IsolationPreflight({ ...declared, [field]: value }))
      .toThrow(/canonical loopback disposable endpoints/);
  });
  it('rejects shared namespace and conflicting generic endpoints', () => {
    expect(() => assertPackage28IsolationPreflight({ ...declared, INTEGRATION_REDIS_NAMESPACE: 'shared' }))
      .toThrow(/run-specific Redis namespace/);
    expect(() => assertPackage28IsolationPreflight({ ...declared, DATABASE_URL: 'postgresql://production/shared_test' }))
      .toThrow(/conflicting DATABASE_URL/);
    expect(() => assertPackage28IsolationPreflight({ ...declared, REDIS_URL: 'redis://production:6379' }))
      .toThrow(/conflicting REDIS_URL/);
  });
  it('blocks even valid declarations without an independently generated canonical schema baseline', () => {
    const snapshot = { ...declared };
    expect(() => assertPackage28IsolationPreflight(declared)).toThrow(/independently generated canonical schema baseline/);
    expect(declared).toEqual(snapshot);
  });
  it('does not accept manual certificates, digests, table existence or scope_policy fallback', () => {
    expect(() => assertPackage28IsolationPreflight({ ...declared,
      INTEGRATION_SCHEMA_BASELINE: '/tmp/operator-certificate.json',
      INTEGRATION_SCHEMA_VERIFIED: 'true', INTEGRATION_TABLES_PRESENT: 'true',
      INTEGRATION_MIGRATION_DIGEST: 'a'.repeat(64), INTEGRATION_SCOPE_POLICY: 'scope_policy'
    })).toThrow(/independently generated canonical schema baseline/);
  });
});

describe('package28 pre-import isolation wiring (static only)', () => {
  it('guards the root config before loading dotenv, Vitest or database modules', () => {
    const text = source('vitest.integration.config.ts');
    const ast = ts.createSourceFile('config.ts', text, ts.ScriptTarget.Latest, true);
    const imports = ast.statements.filter(ts.isImportDeclaration)
      .map(node => (node.moduleSpecifier as ts.StringLiteral).text);
    expect(imports).toEqual(['./tests/integration/helpers/package28-isolation.js']);
    expect(text).not.toContain('dotenv');
    expect(text.indexOf('assertPackage28IsolationPreflight(process.env)')).toBeGreaterThan(0);
    expect(text.indexOf('assertPackage28IsolationPreflight(process.env)'))
      .toBeLessThan(text.indexOf("await import('vitest/config')"));
  });
  it('schema helper refuses before importing or querying a database client', async () => {
    vi.resetModules();
    effects.imports.mockClear();
    effects.queries.mockClear();
    for (const [key, value] of Object.entries({ ...declared, DATABASE_URL: declared.INTEGRATION_DATABASE_URL, REDIS_URL: declared.INTEGRATION_REDIS_URL })) {
      vi.stubEnv(key, value);
    }
    try {
      const { assertIntegrationSchemaCurrent } = await import('../integration/helpers/schema-guard.js');
      await expect(assertIntegrationSchemaCurrent()).rejects.toThrow(/independently generated canonical schema baseline/);
      expect(effects.imports).not.toHaveBeenCalled();
      expect(effects.queries).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('global setup has no static DB import and refuses before DB construction', async () => {
    vi.resetModules();
    effects.imports.mockClear();
    const text = source('tests/integration/global-setup.ts');
    const ast = ts.createSourceFile('setup.ts', text, ts.ScriptTarget.Latest, true);
    expect(ast.statements.filter(ts.isImportDeclaration)
      .map(node => (node.moduleSpecifier as ts.StringLiteral).text))
      .toEqual(['./helpers/schema-guard.js']);
    const { setup } = await import('../integration/global-setup.js');
    await expect(setup()).rejects.toThrow(/Integration isolation/);
    expect(effects.imports).not.toHaveBeenCalled();
  });
  it('lifecycle helper refuses before the operation callback or database import', async () => {
    vi.resetModules();
    effects.imports.mockClear();
    const operation = vi.fn(async () => {});
    const { withLifecycleFixture } = await import('../integration/helpers/lifecycle-fixture.js');
    await expect(withLifecycleFixture(operation)).rejects.toThrow(/Integration isolation/);
    expect(operation).not.toHaveBeenCalled();
    expect(effects.imports).not.toHaveBeenCalled();
  });
  it('script and CLI only invoke the connected pure preflight and never acquire or mutate infrastructure', () => {
    const script = source('scripts/test-integration.sh');
    expect(script).toContain('--preflight-only');
    expect(script).toContain('tests/package28-isolation-preflight.ts');
    expect(script).not.toMatch(/docker|db:migrate|pnpm test|verify-acceptance|vitest|psql|redis-cli/);
    const cli = source('tests/package28-isolation-preflight.ts');
    const ast = ts.createSourceFile('cli.ts', cli, ts.ScriptTarget.Latest, true);
    expect(ast.statements.filter(ts.isImportDeclaration)
      .map(node => (node.moduleSpecifier as ts.StringLiteral).text))
      .toEqual(['./integration/helpers/package28-isolation.js']);
    expect(cli).toContain('assertPackage28IsolationPreflight(process.env)');
  });
  it('preflight has no import graph or manual table/policy/database verification fallback', () => {
    const text = source('tests/integration/helpers/package28-isolation.ts');
    const ast = ts.createSourceFile('guard.ts', text, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require'))) {
        imports.push(node.getText(ast));
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(imports).toEqual([]);
  });
});
