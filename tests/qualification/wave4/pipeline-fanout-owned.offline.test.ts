import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Separate P4b fresh source graph; accepted P4a containment is not modified.
 * Source aliases exercise the actual production bodies, not stale dist or mocks.
 * No runtime/protected-backing acceptance is claimed by constructor containment. */
describe('P4b shared candidate and current-recipient fanout source containment', () => {
  it('imports and invokes owned canonical fanout graph with PG constructors trapped and real ambient positive control', async () => {
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
      const temp = mkdtempSync(join(tmpdir(), 'swat-p4b-fanout-source-'));
      try {
        const config = join(temp, 'tsconfig.json');
        writeFileSync(config, JSON.stringify({ compilerOptions: { baseUrl: resolve('.'), paths: {
          '@swat/db/dist/*.js': ['packages/db/src/*.ts'],
          '@swat/shared': ['packages/shared/src/index.ts']
        } } }));
        process.env.TSX_TSCONFIG_PATH = config;
        const { tsImport } = await import('tsx/esm/api');
        const loaded = new Set();
        const load = path => tsImport(path, { parentURL: import.meta.url, tsconfig: config,
          onImport: url => loaded.add(new URL(url).pathname) });
        const candidates = await load('./packages/db/src/fanout-candidates-owned.ts');
        const { createOwnedFanoutPolicy } = await load('./apps/signal-engine/src/fanout-policy-owned.ts');
        const { projectCohortNotionalUsd } = await load('./apps/signal-engine/src/capacity-projection.ts');
        const { planFanoutTradeJobs } = await load('./apps/signal-engine/src/fanout-enqueue.ts');
        if (typeof candidates.listFanoutCandidatesWithClient !== 'function'
          || typeof candidates.prepareListFanoutCandidates !== 'function'
          || typeof createOwnedFanoutPolicy !== 'function' || typeof projectCohortNotionalUsd !== 'function') {
          throw new Error('Missing actual owned entry');
        }
        const SOURCE = '11111111-1111-4111-8111-111111111111';
        const SIGNAL = '22222222-2222-4222-8222-222222222222';
        const TARGET = 'solana:11111111111111111111111111111111';
        const TOKEN = 'solana:11111111111111111111111111111112';
        const now = new Date('2026-11-23T00:00:01Z');
        const queries = [];
        const client = { query: async (sql, values) => {
          queries.push({ sql, values });
          if (sql.includes('SELECT true AS accepted')) return { rows: [{ accepted: true }] };
          if (sql.includes('FROM user_wallet_subscriptions subscription')) return { rows: [] };
          if (sql.includes('SELECT source.wallet_address')) return { rows: [{ wallet_address: TARGET,
            direction: 'buy', token_mint: TOKEN, chain: 'solana', event_at: new Date(now.getTime() - 1000),
            confirmation_state: 'confirmed' }] };
          if (sql.includes("key = 'blacklist'")) return { rows: [{ value: [] }] };
          throw new Error('Unscripted actual SQL: ' + sql);
        } };
        await candidates.listFanoutCandidatesWithClient(client, { masterWalletAddress: TARGET, chain: 'solana', now });
        let modeReads = 0, safetyReads = 0, capacityReads = 0;
        const policy = createOwnedFanoutPolicy({
          transaction: async operation => operation(client), mode: async () => { modeReads++; return { effectiveMode: 'paper' }; },
          safety: async () => { safetyReads++; return { isSafe: true }; },
          capacity: async () => { capacityReads++; return { capacity: { outcome: 'admit' }, decision: null, logLine: 'inert' }; },
          operatorAutoExecute: () => true, paperTargetAccount: () => TARGET, now: () => new Date(now),
          minimumBalanceUsd: 0, minimumSignalScore: 70, maximumSourceEventAgeMs: 1000,
          log() {}, warn() {}, error(message, error) { throw new Error(message + String(error)); }
        });
        const plan = planFanoutTradeJobs({ signalId: SIGNAL, tokenMint: TOKEN, score: 90, clusterTier: 'elite',
          sourceTrade: { sourceTradeId: SOURCE, direction: 'buy' }, plan: { eligible: [], excluded: [], exclusionCounts: {} } });
        const snapshot = await policy.prepareEnumeration({ sourceTradeId: SOURCE, walletAddress: TARGET,
          tokenMint: TOKEN, side: 'buy', eventAt: new Date(now.getTime() - 1000) },
          { allowed: true, requiresOwnedExit: false }, null)(plan);
        if (snapshot.recipients.length !== 1 || snapshot.exclusions.length !== 0
          || snapshot.recipients[0].userId !== null) throw new Error('Actual cohort body not invoked');
        const admitted = await policy.admission(client, snapshot.recipients[0].descriptor);
        if (!admitted.allowed || safetyReads !== 1 || capacityReads !== 1 || modeReads !== 2) {
          throw new Error('Actual current admission ports not invoked');
        }
        await new Promise(resolve => setTimeout(resolve, 25));
        const required = [
          'packages/db/src/fanout-candidates-owned.ts', 'packages/db/src/user-balance-state.ts',
          'packages/db/src/user-execution-defaults.ts', 'packages/db/src/position-cap.ts',
          'packages/db/src/fanout-eligibility.ts', 'packages/db/src/forward-only-state.ts',
          'packages/db/src/subscription-state.ts', 'packages/db/src/package13-fanout-delivery.ts',
          'packages/db/src/lot-allocation.ts', 'packages/db/src/source-verification-store.ts',
          'packages/db/src/source-verification.ts', 'apps/signal-engine/src/fanout-policy-owned.ts',
          'apps/signal-engine/src/capacity-projection.ts', 'apps/signal-engine/src/fanout-canonical.ts',
          'apps/signal-engine/src/fanout-enqueue.ts', 'apps/signal-engine/src/trade-eligibility.ts'
        ].map(path => resolve(path));
        for (const path of required) if (!loaded.has(path)) throw new Error('Source loader missed ' + path);
        const forbiddenPaths = ['index.ts','client.ts','transaction.ts','tenancy.ts','fanout-candidates.ts',
          'user-balances.ts','user-execution-settings.ts','subscriptions.ts','forward-only.ts','copy-trade-lifecycle.ts']
          .map(file => resolve('packages/db/src', file)).concat([
            resolve('apps/signal-engine/src/index.ts'), resolve('apps/signal-engine/src/capacity-inputs.ts'),
            resolve('apps/signal-engine/src/safety.ts')]);
        if ([...loaded].some(path => path.startsWith(resolve('packages/db/dist') + '/') || forbiddenPaths.includes(path))) {
          throw new Error('Ambient/stale DB or service boot in owned graph');
        }
        if (constructors !== 0) throw new Error('Owned fanout constructed PG');
        let controlRefused = false;
        try { await load('./packages/db/src/fanout-candidates.ts'); }
        catch (error) { controlRefused = String(error).includes('Forbidden PG Pool construction'); }
        if (!controlRefused || constructors !== 1) throw new Error('Real ambient facade positive control did not fire');
        console.log(JSON.stringify({ sourceModules: required.length, candidateQueries: queries.filter(row =>
          row.sql.includes('FROM user_wallet_subscriptions subscription')).length,
          cohortRecipients: snapshot.recipients.length, admitted: admitted.allowed, ownedConstructors: 0,
          controlRefused, runtimeAccepted: false }));
      } finally { rmSync(temp, { recursive: true, force: true }); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('../../../', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgres://swat_app:offline@127.0.0.1:1/offline', DATABASE_READ_URL: '' },
      timeout: 30_000, maxBuffer: 1024 * 1024
    });
    expect(JSON.parse(stdout.trim())).toEqual({ sourceModules: 16, candidateQueries: 2,
      cohortRecipients: 1, admitted: true, ownedConstructors: 0, controlRefused: true, runtimeAccepted: false });
  }, 35_000);
});
