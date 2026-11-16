import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JsonReporter } from 'vitest/reporters';
import * as harness from './package12-29-harness.js';

const root = '/home/xahmie/Documents/SWAT';
const evidence = resolve(root, 'threats/sequential-fixes');
const historicalResults = resolve(evidence, 'package12-29-harness-recovery-self-red-20261114a.json');
let fixtureRoot: string;
let first: string;
let second: string;
let output: string;

beforeAll(() => {
  fixtureRoot = mkdtempSync(resolve(evidence, 'package12-29-harness-recovery2-fixtures-'));
  first = resolve(fixtureRoot, 'first.test.ts');
  second = resolve(fixtureRoot, 'second.spec.ts');
  output = resolve(fixtureRoot, 'report.json');
  for (const directory of ['', 'integration', 'apps-alert-service']) {
    mkdirSync(resolve(fixtureRoot, directory), { recursive: true });
  }
  for (const file of ['first.test.ts', 'second.spec.ts', 'not-source.ts', 'unsafe.integration.test.ts',
    'integration/hidden.test.ts', 'apps-alert-service/pure.test.ts', 'export*.test.ts',
    '@(name).test.ts', '+(name).test.ts', '(name).test.ts', 'back\\slash.test.ts']) {
    writeFileSync(resolve(fixtureRoot, file), '// inert path fixture; never collected or executed\n', { flag: 'wx' });
  }
  for (const [name, target] of [
    ['alias.test.ts', first], ['unsafe.service.test.ts', first], ['not-a-test.ts', first],
    ['canonical-glob.test.ts', resolve(fixtureRoot, 'export*.test.ts')],
    ['canonical-extglob.test.ts', resolve(fixtureRoot, '@(name).test.ts')],
    ['canonical-backslash.test.ts', resolve(fixtureRoot, 'back\\slash.test.ts')],
    ['escape.test.ts', '/usr/bin/node']
  ]) symlinkSync(target, resolve(fixtureRoot, name));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function config(files: string[] = [first, second]) {
  vi.stubEnv('REVIEW_RESULTS', output);
  return harness.createPackageConfig(files);
}

// Retain meaningful red evidence before the real exports exist; no mock implementation.
const missing = () => { throw new Error('Package harness gate missing'); };
const verify = (harness as unknown as {
  verifyPackageResults?: (files: string[], results: unknown) => unknown
}).verifyPackageResults ?? missing;
const assertCli = (harness as unknown as {
  assertPackageCli?: (args: string[]) => void
}).assertPackageCli ?? missing;

// Synthetic malformed/negative inputs only. Actual acceptance below uses retained Vitest JSON.
function synthetic(names = [first, second]) {
  return {
    numTotalTestSuites: 9, numTotalTests: 4, numPassedTests: 1, numFailedTests: 1,
    numPendingTests: 1, numTodoTests: 1, success: false,
    testResults: names.map((name, index) => ({
      name, status: index === 0 ? 'failed' : 'passed',
      assertionResults: (index === 0 ? ['passed', 'failed'] : ['skipped', 'todo']).map(status => ({ status }))
    }))
  };
}

describe('literal raw and canonical path boundary', () => {
  it('preserves source aliases, safety setup, exact includes and bounded worker settings', () => {
    const selected = config();
    expect(selected.root).toBe(root);
    expect(selected.resolve?.alias).toMatchObject({
      '@swat/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@swat/db': resolve(root, 'packages/db/src/index.ts')
    });
    expect(selected.test).toMatchObject({
      include: [first, second].map(path => path.slice(root.length + 1)),
      pool: 'forks', minWorkers: 1, maxWorkers: 1, fileParallelism: false, maxConcurrency: 1,
      setupFiles: [resolve(evidence, 'test-safety.ts')], outputFile: output
    });
  });
  it.each(['export*.test.ts', '@(name).test.ts', '+(name).test.ts', '(name).test.ts', 'back\\slash.test.ts',
    'canonical-glob.test.ts', 'canonical-extglob.test.ts', 'canonical-backslash.test.ts'])('rejects dynamic raw/canonical %s', name => {
    expect(() => config([resolve(fixtureRoot, name)])).toThrow(/literal test paths/);
  });
  it.each(['*.test.ts', '?.test.ts', '[a].test.ts', '{a,b}.test.ts', '!(name).test.ts',
    '?(name).test.ts', '*(name).test.ts', '**/x.test.ts', '!x.test.ts'])('rejects raw syntax before filesystem lookup %s', name => {
    expect(() => config([resolve(fixtureRoot, name)])).toThrow(/literal test paths/);
  });
  it.each(['integration/hidden.test.ts', 'unsafe.integration.test.ts', 'unsafe.service.test.ts',
    'not-a-test.ts', 'not-source.ts', 'escape.test.ts'])('retains existing refusal %s', name => {
    expect(() => config([resolve(fixtureRoot, name)])).toThrow();
  });
  it('retains canonical duplicate rejection', () => {
    expect(() => config([first, resolve(fixtureRoot, 'alias.test.ts')])).toThrow(/duplicate/);
  });
  it('retains empty and nonexistent refusals', () => {
    expect(() => config([])).toThrow(/nonempty/);
    expect(() => config([resolve(fixtureRoot, 'missing.test.ts')])).toThrow(/existing regular/);
  });
  it('allows reviewed pure application path and workspace-relative file', () => {
    expect(() => config([resolve(fixtureRoot, 'apps-alert-service/pure.test.ts')])).not.toThrow();
    expect(() => config([first.slice(root.length + 1)])).not.toThrow();
  });
  it.each([undefined, '', 'relative.json'])('requires absolute output %s', value => {
    vi.stubEnv('REVIEW_RESULTS', value);
    expect(() => harness.createPackageConfig([first])).toThrow(/absolute REVIEW_RESULTS/);
  });
});

describe('strict unfiltered CLI grammar', () => {
  it.each([
    ['run', '--config', '/fixture/owner.config.ts'], ['run', '-c', '/fixture/owner.config.ts'],
    ['run', '--config=/fixture/owner.config.ts'], ['run', '-c=/fixture/owner.config.ts']
  ])('accepts explicit run %j', (...args) => expect(() => assertCli(args)).not.toThrow());
  it.each([
    ['run', '--config', '/fixture/owner.config.ts', 'first'],
    ['run', '--config', '/fixture/owner.config.ts', '-t', 'one'],
    ['run', '--config', '/fixture/owner.config.ts', '--testNamePattern=one'],
    ...['--shard=1/2', '--include=first.test.ts', '--exclude=first.test.ts', '--passWithNoTests', '--reporter=json', '--outputFile=/tmp/other.json',
      '--maxWorkers=2', '--pool=threads', '--project=one', '--changed', '--related', '--bail=1', '--retry=1',
      '--watch', '--inspect', '--includeTaskLocation', '--config=/fixture/other.config.ts'].map(flag => ['run', '-c', '/fixture/owner.config.ts', flag]),
    ['watch', '--config', '/fixture/owner.config.ts'], ['list', '-c', '/fixture/owner.config.ts'], ['run'],
    ['run', '--config', ''], ['run', '--config='], ['run', '-c', '--reporter=json'],
    ['run', '-c', ' /fixture/owner.config.ts'], ['run', '--', '-c', '/fixture/owner.config.ts']
  ])('rejects reductions and overrides %j', (...args) => expect(() => assertCli(args)).toThrow(/only Vitest run/));
});

describe('actual JSON exact manifest gate', () => {
  it('accepts only real retained Vitest results with actual counts, not suite count', () => {
    const results = JSON.parse(readFileSync(historicalResults, 'utf8'));
    expect(verify([resolve(evidence, 'package12-29-harness.sequential.test.ts')], results)).toEqual({
      files: 1, total: 48, passed: 37, failed: 11, skipped: 0, pending: 0, todo: 0
    });
  });
  it.each(['empty', 'missing', 'duplicate', 'wrong'])('rejects %s mutations of retained actual JSON', kind => {
    const results = JSON.parse(readFileSync(historicalResults, 'utf8'));
    if (kind === 'empty') results.testResults = [];
    if (kind === 'missing') delete results.testResults;
    if (kind === 'duplicate') results.testResults.push(results.testResults[0]);
    if (kind === 'wrong') results.testResults[0].name = first;
    expect(() => verify([resolve(evidence, 'package12-29-harness.sequential.test.ts')], results)).toThrow(/manifest/);
  });
  it.each(['empty', 'reduced', 'duplicate', 'extra', 'wrong', 'relative'])('rejects %s synthetic manifests', kind => {
    const names: Record<string, string[]> = {
      empty: [], reduced: [first], duplicate: [first, first], extra: [first, second, historicalResults],
      wrong: [first, historicalResults], relative: [first.slice(root.length + 1), second]
    };
    expect(() => verify([first, second], synthetic(names[kind]))).toThrow(/manifest/);
  });
  it.each([
    { testResults: null }, { ...synthetic(), numPassedTests: 99 }, { ...synthetic(), numPendingTests: 0 },
    { ...synthetic(), numTodoTests: -1 }, { ...synthetic(), success: true },
    { ...synthetic(), testResults: [{ name: first, status: 'passed', assertionResults: null }] }
  ])('rejects malformed or contradictory report %j', results => {
    expect(() => verify([first, second], results)).toThrow();
  });
  it('factory installs its CLI hook and manifest-aware real JSON reporter', () => {
    const selected = config();
    expect(selected.plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'package-manifest-cli' })]));
    expect(selected.test?.reporters).toEqual(['default', expect.objectContaining({ manifest: [first, second] })]);
  });
  it('factory CLI hook rejects filters before collection without executing fixtures', () => {
    const plugin = config().plugins?.[0] as { config: () => void };
    const oldArgs = process.argv;
    try {
      process.argv = ['/usr/bin/node', 'vitest.mjs', 'run', '-c', '/fixture/owner.config.ts', 'first'];
      expect(() => plugin.config()).toThrow(/only Vitest run/);
      process.argv = ['/usr/bin/node', 'vitest.mjs', 'run', '--config', '/fixture/owner.config.ts'];
      expect(() => plugin.config()).not.toThrow();
    } finally {
      process.argv = oldArgs;
    }
  });
  it.each(['empty', 'reduced', 'duplicate', 'wrong'])('actual onFinished writes %s JSON before rejecting with final error exit', async kind => {
    const reporter = config().test?.reporters?.[1] as JsonReporter;
    const results = JSON.parse(readFileSync(historicalResults, 'utf8'));
    reporter.ctx = {
      config: { root, passWithNoTests: false }, logger: { log() {} }, snapshot: { summary: results.snapshot }
    } as unknown as JsonReporter['ctx'];
    const files = kind === 'empty' ? [] : [{
      type: 'suite', tasks: [], filepath: kind === 'wrong' ? historicalResults : first,
      result: { state: 'pass' }
    }];
    if (kind === 'duplicate') files.push(files[0]);
    const oldExit = process.exitCode;
    try {
      await expect(reporter.onFinished(files as Parameters<JsonReporter['onFinished']>[0])).rejects.toThrow(/manifest/);
      expect(process.exitCode).toBe(1);
      const actual = JSON.parse(readFileSync(output, 'utf8'));
      expect(actual.testResults).toHaveLength(files.length);
      expect(actual.numTotalTests).toBe(0);
    } finally {
      process.exitCode = oldExit;
    }
  });
  it('real retained failed JSON is written unchanged and keeps error exit despite an exact manifest', async () => {
    vi.stubEnv('REVIEW_RESULTS', output);
    const reporter = harness.createPackageConfig([resolve(evidence, 'package12-29-harness.sequential.test.ts')])
      .test?.reporters?.[1] as JsonReporter;
    reporter.ctx = { config: { root }, logger: { log() {} } } as unknown as JsonReporter['ctx'];
    const report = readFileSync(historicalResults, 'utf8');
    const oldExit = process.exitCode;
    try {
      await expect(reporter.writeReport(report)).resolves.toBeUndefined();
      expect(readFileSync(output, 'utf8')).toBe(report);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = oldExit;
    }
  });
  it('actual reporter writes rejected JSON but cannot return success for a reduced manifest', async () => {
    const selected = config();
    const reporter = selected.test?.reporters?.[1] as unknown as {
      ctx: unknown; writeReport?: (report: string) => Promise<void>
    };
    if (!reporter?.writeReport) missing();
    reporter.ctx = { config: { root }, logger: { log() {} } };
    const oldExit = process.exitCode;
    try {
      await expect(reporter.writeReport!(JSON.stringify(synthetic([first])))).rejects.toThrow(/manifest/);
      expect(process.exitCode).toBe(1);
      expect(existsSync(output)).toBe(true);
      expect(JSON.parse(readFileSync(output, 'utf8')).testResults).toHaveLength(1);
    } finally {
      process.exitCode = oldExit;
    }
  });
});
