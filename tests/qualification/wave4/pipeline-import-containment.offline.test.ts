import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Fresh source evaluation, not stale dist, barrel mocks, or source regex proof.
 * The temporary loader config resolves the apps' production dist-leaf specifiers
 * to their real source bodies without widening any application tsconfig/rootDir. */
describe('P4a actual source pipeline import containment', () => {
  it('imports real owned intake/fanout/worker/quote/runtime graphs with PG constructors forbidden', async () => {
    const script = `
      import { createRequire } from 'node:module';
      import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join, resolve } from 'node:path';
      const require = createRequire(import.meta.url);
      const pg = require(require.resolve('pg', { paths: ['./packages/db'] }));
      let constructors = 0;
      const forbidden = kind => class { constructor() {
        constructors++; throw new Error('Forbidden PG ' + kind + ' construction');
      } };
      pg.Pool = forbidden('Pool'); pg.Client = forbidden('Client');
      const temp = mkdtempSync(join(tmpdir(), 'swat-p4a-source-'));
      try {
        const config = join(temp, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { baseUrl: resolve('.'), paths: {
          '@swat/db/dist/*.js': ['packages/db/src/*.ts'],
          '@swat/shared': ['packages/shared/src/index.ts']
        } } }));
        process.env.TSX_TSCONFIG_PATH = config;
        // No package source has evaluated before the constructor traps above.
        const { tsImport } = await import('tsx/esm/api');
        const loaded = new Set();
        const load = path => tsImport(path, { parentURL: import.meta.url, tsconfig: config,
          onImport: url => loaded.add(new URL(url).pathname) });
        const roots = [
          ['./packages/db/src/copy-trade-lifecycle-owned.ts', 'recordSourceTradeEventWithClient'],
          ['./packages/db/src/trades-owned.ts', 'insertTradeWithClient'],
          ['./packages/db/src/risk-spend-owned.ts', 'reserveRiskSpend'],
          ['./packages/db/src/fanout-eligibility.ts', 'planFanout'],
          ['./packages/db/src/obligation-runtime-owned.ts', 'createOwnedObligationScopedTransaction'],
          ['./apps/signal-engine/src/fanout-enqueue.ts', 'createDurableFanoutDelivery'],
          ['./apps/trade-executor/src/worker-policy.ts', 'runCanonicalWorkerJob'],
          ['./apps/trade-executor/src/worker-paper-quote.ts', 'createExactPaperQuote'],
          ['./apps/trade-executor/src/worker-runtime-owned-adapters.ts', 'createOwnedExecutorRuntimePorts']
        ];
        for (const [path, entry] of roots) {
          const actual = await load(path);
          if (typeof actual[entry] !== 'function') throw new Error('Missing real entry ' + path + '#' + entry);
        }
        // Drain the loader's import-observation message channel.
        await new Promise(resolve => setTimeout(resolve, 25));
        const paths = [...loaded];
        const required = roots.map(([path]) => resolve(path)).concat([
          resolve('packages/db/src/worker-execution.ts'), resolve('packages/db/src/worker-settlement.ts'),
          resolve('packages/db/src/subscription-state.ts'), resolve('packages/db/src/package13-fanout-delivery.ts'),
          resolve('packages/db/src/runtime-exact-decimal.ts'), resolve('packages/db/src/source-verification-store.ts')
        ]);
        for (const path of required) if (!loaded.has(path)) throw new Error('Source loader missed ' + path);
        const forbiddenPaths = ['index.ts','client.ts','transaction.ts','tenancy.ts','subscriptions.ts',
          'copy-trade-lifecycle.ts','trades.ts','risk-policy.ts','obligation-runtime-capability.ts']
          .map(file => resolve('packages/db/src', file));
        if (paths.some(path => path.startsWith(resolve('packages/db/dist') + '/')
          || forbiddenPaths.includes(path))) throw new Error('Ambient/stale DB module in owned graph');
        if (constructors !== 0) throw new Error('Owned import constructed PG');
        // Positive control proves the traps intercept the real ambient source.
        let controlRefused = false;
        try { await load('./packages/db/src/client.ts'); }
        catch (error) { controlRefused = String(error).includes('Forbidden PG Pool construction'); }
        if (!controlRefused || constructors !== 1) throw new Error('PG constructor control did not fire');
        console.log(JSON.stringify({ roots: roots.length, sourceModules: required.length,
          ownedConstructors: 0, controlRefused, runtimeAccepted: false }));
      } finally { rmSync(temp, { recursive: true, force: true }); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgres://swat_app:offline@127.0.0.1:1/offline' },
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    });
    expect(JSON.parse(stdout.trim())).toEqual({ roots: 9, sourceModules: 15,
      ownedConstructors: 0, controlRefused: true, runtimeAccepted: false });
  }, 35_000);
});
