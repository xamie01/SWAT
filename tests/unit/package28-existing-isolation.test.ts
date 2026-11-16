import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [{ source_trades: 0, copy_executions: 0, source_positions: 0, copy_positions: 0, trades: 0 }] })) }));
vi.mock('../../packages/db/src/client.js', () => ({ pool: database }));
// Cleanup selectors are tested with inert DB+preflight ports, not a schema
// certificate. The unmocked preflight's mandatory refusal is tested separately.
vi.mock('../integration/helpers/package28-isolation.js', () => ({ assertPackage28IsolationPreflight: vi.fn() }));
import { PublicKey } from '../../packages/shared/src/validation.js';
import { createLifecycleFixture, withLifecycleFixture } from '../integration/helpers/lifecycle-fixture.js';

const root = new URL('../../', import.meta.url);
describe('package28 existing isolation regressions (pure database mock)', () => {
  it('allocates disjoint valid 32-byte Solana fixture identities', () => {
    const a = createLifecycleFixture();
    const b = createLifecycleFixture();
    for (const field of ['sourceWallet', 'targetAccount', 'tokenMint'] as const) {
      expect(a[field]).not.toBe(b[field]);
      expect(a[field]).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(new PublicKey(a[field]).toBytes()).toHaveLength(32);
      expect(new PublicKey(b[field]).toBytes()).toHaveLength(32);
    }
  });
  it('cleanup selectors cannot name another live fixture', async () => {
    database.query.mockClear();
    const survivor = createLifecycleFixture();
    await withLifecycleFixture(async fixture => {
      expect(fixture.targetAccount).not.toBe(survivor.targetAccount);
    });
    const values = database.query.mock.calls.flatMap(call => (call as unknown as [string, unknown[]])[1] ?? []);
    expect(values).not.toContain(`solana:${survivor.targetAccount}`);
    expect(values).not.toContain(`solana:${survivor.sourceWallet}`);
    expect(values).not.toContain(`solana:${survivor.tokenMint}`);
  });
  it('script has no implicit infrastructure acquisition or broad acceptance command', () => {
    const script = readFileSync(new URL('scripts/test-integration.sh', root), 'utf8');
    expect(script).not.toMatch(/docker compose up|pnpm db:migrate|pnpm test\s|verify-acceptance/);
    expect(script).toContain('--preflight-only');
  });
  it('chaos does not kill every PostgreSQL or Redis peer', () => {
    const source = readFileSync(new URL('tests/integration/chaos.integration.test.ts', root), 'utf8');
    expect(source).not.toContain("'KILL', 'TYPE', 'normal'");
    expect(source).toContain('application_name = $1');
  });
});
