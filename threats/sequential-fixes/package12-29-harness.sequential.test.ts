import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as harness from './package12-29-harness.js';

const root = '/home/xahmie/Documents/SWAT';
const fixtureRoot = resolve(root, 'threats/sequential-fixes/reviewtmp/package12-29-harness-fixtures');
const first = resolve(fixtureRoot, 'first.test.ts');
const second = resolve(fixtureRoot, 'second.spec.ts');
const output = resolve(fixtureRoot, 'report.json');

beforeAll(() => {
  for (const directory of ['', 'integration', 'services', 'apps-alert-service']) {
    mkdirSync(resolve(fixtureRoot, directory), { recursive: true });
  }
  for (const file of ['first.test.ts', 'second.spec.ts', 'not-source.ts', 'unsafe.integration.test.ts',
    'integration/hidden.test.ts', 'services/hidden.test.ts', 'apps-alert-service/pure.test.ts',
    'export*.test.ts', '@(name).test.ts', 'back\\slash.test.ts']) {
    const path = resolve(fixtureRoot, file);
    if (!existsSync(path)) writeFileSync(path, '// deterministic inert fixture; never executed\n', { flag: 'wx' });
  }
  for (const [name, target] of [
    ['alias.test.ts', first], ['unsafe.service.test.ts', first], ['not-a-test.ts', first],
    ['canonical-glob.test.ts', resolve(fixtureRoot, 'export*.test.ts')],
    ['escape.test.ts', '/usr/bin/node']
  ]) {
    const path = resolve(fixtureRoot, name);
    if (!existsSync(path)) symlinkSync(target, path);
  }
});
afterEach(() => vi.unstubAllEnvs());

function config(files: string[] = [first, second]) {
  vi.stubEnv('REVIEW_RESULTS', output);
  return harness.createPackageConfig(files);
}

function report(names = [first, second]) {
  return {
    numTotalTestSuites: 9, // Nested suite count must never be mistaken for file count.
    numTotalTests: 4, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, numTodoTests: 1,
    testResults: names.map((name, index) => ({
      name, status: index === 0 ? 'failed' : 'passed',
      assertionResults: (index === 0 ? ['passed', 'failed'] : ['skipped', 'todo'])
        .map(status => ({ status }))
    }))
  };
}

// The manifest/CLI exports are optional only to retain meaningful pre-correction red evidence.
const missing = () => { throw new Error('Package harness gate missing'); };
const verify = (harness as unknown as {
  verifyPackageResults?: (files: string[], results: unknown) => unknown
}).verifyPackageResults ?? missing;
const assertCli = (harness as unknown as {
  assertPackageCli?: (args: string[]) => void
}).assertPackageCli ?? missing;

describe('saved package factory literal manifest', () => {
  it('preserves exact source aliases, test safety and bounded execution settings', () => {
    const selected = config();
    expect(selected.root).toBe(root);
    expect(selected.resolve?.alias).toMatchObject({
      '@swat/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@swat/db': resolve(root, 'packages/db/src/index.ts')
    });
    expect(selected.test).toMatchObject({
      include: [first, second].map(path => path.slice(root.length + 1)),
      pool: 'forks', minWorkers: 1, maxWorkers: 1, fileParallelism: false, maxConcurrency: 1,
      setupFiles: [resolve(root, 'threats/sequential-fixes/test-safety.ts')], outputFile: output
    });
  });
  it.each([
    ['empty', []], ['glob', ['**/*.test.ts']], ['nonexistent', [resolve(fixtureRoot, 'missing.test.ts')]],
    ['non-test', [resolve(fixtureRoot, 'not-source.ts')]], ['duplicate', [first, first]],
    ['canonical duplicate', [first, resolve(fixtureRoot, 'alias.test.ts')]],
    ['outside', ['/usr/bin/node']], ['symlink escape', [resolve(fixtureRoot, 'escape.test.ts')]],
    ['integration directory', [resolve(fixtureRoot, 'integration/hidden.test.ts')]],
    ['service directory', [resolve(fixtureRoot, 'services/hidden.test.ts')]],
    ['integration filename', [resolve(fixtureRoot, 'unsafe.integration.test.ts')]],
    ['service alias filename', [resolve(fixtureRoot, 'unsafe.service.test.ts')]],
    ['non-test alias filename', [resolve(fixtureRoot, 'not-a-test.ts')]],
    ['canonical glob alias', [resolve(fixtureRoot, 'canonical-glob.test.ts')]],
    ['extglob', [resolve(fixtureRoot, '@(name).test.ts')]],
    ['backslash', [resolve(fixtureRoot, 'back\\slash.test.ts')]],
    ['directory', [fixtureRoot]], ['whitespace', [` ${first}`]]
  ])('rejects %s', (_label, files) => {
    expect(() => config(files)).toThrow();
  });
  it('allows pure tests inside application names containing service', () => {
    expect(() => config([resolve(fixtureRoot, 'apps-alert-service/pure.test.ts')])).not.toThrow();
  });
  it.each([undefined, '', 'relative-results.json'])('requires absolute REVIEW_RESULTS (%s)', value => {
    vi.stubEnv('REVIEW_RESULTS', value);
    expect(() => harness.createPackageConfig([first])).toThrow(/absolute REVIEW_RESULTS/);
  });
});

describe('full-manifest command guard', () => {
  it.each([
    ['run', '--config', '/fixture/owner.config.ts'], ['run', '-c', '/fixture/owner.config.ts'],
    ['run', '--config=/fixture/owner.config.ts']
  ])('accepts only explicit unfiltered run %j', (...args) => {
    expect(() => assertCli(args)).not.toThrow();
  });
  it.each([
    ['run', '--config', '/fixture/owner.config.ts', 'first'],
    ['run', '--config', '/fixture/owner.config.ts', '-t', 'one test'],
    ['run', '--config', '/fixture/owner.config.ts', '--testNamePattern=one'],
    ['run', '--config', '/fixture/owner.config.ts', '--shard=1/2'],
    ['run', '--config', '/fixture/owner.config.ts', '--exclude=first.test.ts'],
    ['run', '--config', '/fixture/owner.config.ts', '--passWithNoTests'],
    ['run', '--config', '/fixture/owner.config.ts', '--reporter=json'],
    ['run', '--config', '/fixture/owner.config.ts', '--maxWorkers=2'],
    ['watch', '--config', '/fixture/owner.config.ts'], ['run'], ['run', '--config', '']
  ])('rejects reductions/overrides %j', (...args) => {
    expect(() => assertCli(args)).toThrow();
  });
});

describe('actual JSON manifest verification', () => {
  it('reports actual file and assertion counts including explicit skips, not suite count', () => {
    expect(verify([first, second], report())).toEqual({
      files: 2, total: 4, passed: 1, failed: 1, skipped: 1, pending: 0, todo: 1
    });
  });
  it('accepts reordered exact files', () => {
    expect(() => verify([first, second], report([second, first]))).not.toThrow();
  });
  it.each([
    ['empty', []], ['reduced', [first]], ['duplicate', [first, first]],
    ['extra', [first, second, resolve(fixtureRoot, 'apps-alert-service/pure.test.ts')]],
    ['wrong', [first, resolve(fixtureRoot, 'apps-alert-service/pure.test.ts')]],
    ['relative', ['threats/sequential-fixes/reviewtmp/package12-29-harness-fixtures/first.test.ts', second]]
  ])('rejects %s actual file manifests', (_label, names) => {
    expect(() => verify([first, second], report(names))).toThrow();
  });
  it('rejects malformed report', () => {
    expect(() => verify([first, second], { testResults: null })).toThrow();
  });
  it('rejects invented aggregate pass counts', () => {
    expect(() => verify([first, second], { ...report(), numPassedTests: 99 })).toThrow();
  });
  it('wires the guard and verifying JSON reporter into actual factory config', () => {
    const selected = config();
    expect(selected.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'package-manifest-cli' })]));
    expect(selected.test?.reporters).toEqual(['default', expect.objectContaining({ manifest: [first, second] })]);
  });
});
