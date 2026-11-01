import { describe, expect, it, vi } from 'vitest';

// reserve-vault.ts reads guardrail config through @swat/db; mock it so this
// stays a unit test (the real client throws without DATABASE_URL at import).
const dbMocks = vi.hoisted(() => ({
  resolveLpGuardrailConfig: vi.fn(),
  getLpGuardrailConfig: vi.fn()
}));
vi.mock('@swat/db', () => dbMocks);

import { evaluatePoolExposureCap } from './exposure-cap.js';
import { computeProfitBank, runProfitBankSweep, type ReserveVaultPort } from './profit-bank.js';
import { assertReserveVaultReady, resolveReserveVault, type VaultGrantPort } from './reserve-vault.js';

describe('evaluatePoolExposureCap (G1)', () => {
  it('allows a deposit that stays under the cap', () => {
    const decision = evaluatePoolExposureCap({
      deployedUsd: 1_000,
      poolExposureUsd: 200,
      requestedUsd: 100,
      maxPoolAllocationPct: 50
    });
    // (200 + 100) / (1000 + 100) ≈ 27% < 50%
    expect(decision.allowed).toBe(true);
    expect(decision.allowedAmountUsd).toBe(100);
  });

  it('blocks and sizes the largest allowed top-up when the cap is hit', () => {
    const decision = evaluatePoolExposureCap({
      deployedUsd: 1_000,
      poolExposureUsd: 400,
      requestedUsd: 400,
      maxPoolAllocationPct: 50
    });
    // (400+400)/(1000+400) ≈ 57% > 50%
    expect(decision.allowed).toBe(false);
    // t = (0.5*1000 - 400)/0.5 = 200
    expect(decision.allowedAmountUsd).toBeCloseTo(200, 9);
    expect(decision.reasons[0]).toContain('pool-exposure-cap');
  });

  it('a fully saturated pool allows no further allocation', () => {
    const decision = evaluatePoolExposureCap({
      deployedUsd: 1_000,
      poolExposureUsd: 500,
      requestedUsd: 10,
      maxPoolAllocationPct: 50
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowedAmountUsd).toBeCloseTo(0, 9);
    expect(decision.reasons).toContain('no further allocation to this pool is possible under the cap');
  });

  it('the first deposit always passes when nothing else is deployed', () => {
    const decision = evaluatePoolExposureCap({
      deployedUsd: 0,
      poolExposureUsd: 0,
      requestedUsd: 5_000,
      maxPoolAllocationPct: 50
    });
    // deployed=0 before the request; after, the pool is 100% of the base —
    // which IS the whole base, so it passes (cap compares within the base).
    expect(decision.allowed).toBe(true);
  });

  it('validates its inputs', () => {
    expect(() =>
      evaluatePoolExposureCap({ deployedUsd: -1, poolExposureUsd: 0, requestedUsd: 1, maxPoolAllocationPct: 50 })
    ).toThrow('deployedUsd');
    expect(() =>
      evaluatePoolExposureCap({ deployedUsd: 1, poolExposureUsd: 0, requestedUsd: 1, maxPoolAllocationPct: 150 })
    ).toThrow('(0..100]');
  });
});

describe('computeProfitBank (G2)', () => {
  it('splits the configured share of a realized gain', () => {
    const decision = computeProfitBank({ realizedGainUsd: 400, profitBankPct: 50 });
    expect(decision.sweepAmountUsd).toBe(200);
    expect(decision.retainedUsd).toBe(200);
    expect(decision.swept).toBe(true);
  });

  it('a loss sweeps nothing', () => {
    const decision = computeProfitBank({ realizedGainUsd: -50, profitBankPct: 50 });
    expect(decision.swept).toBe(false);
    expect(decision.sweepAmountUsd).toBe(0);
    expect(decision.reason).toBe('no-realized-gain');
  });

  it('zero percent banking disables the sweep explicitly', () => {
    const decision = computeProfitBank({ realizedGainUsd: 100, profitBankPct: 0 });
    expect(decision.reason).toBe('profit-banking-disabled');
  });
});

describe('runProfitBankSweep', () => {
  const vault: ReserveVaultPort = {
    sweep: async (request) => ({ receipt: `sweep-${request.amountUsd}`, executed: true })
  };

  it('computes and executes a sweep with a receipt', async () => {
    const result = await runProfitBankSweep(vault, {
      userId: 'u1',
      positionId: 'p1',
      realizedGainUsd: 400,
      profitBankPct: 50,
      trigger: 'position-close'
    });
    expect(result.decision.sweepAmountUsd).toBe(200);
    expect(result.receipt).toBe('sweep-200');
  });

  it('a no-gain close returns without calling the vault at all', async () => {
    const notCalled: ReserveVaultPort = {
      sweep: async () => {
        throw new Error('vault must not be called');
      }
    };
    const result = await runProfitBankSweep(notCalled, {
      userId: 'u1',
      positionId: 'p1',
      realizedGainUsd: 0,
      profitBankPct: 50,
      trigger: 'position-close'
    });
    expect(result.receipt).toBeNull();
    expect(result.decision.swept).toBe(false);
  });
});

describe('reserve vault (G3)', () => {
  const scope = { userId: 'u1' } as never;
  const pointerConfig = {
    maxPoolAllocationPct: 50,
    profitBankPct: 50,
    reserveSubVault: { chain: 'solana', address: 'vault-1' }
  };

  it('returns null when the user has no reserve pointer', async () => {
    dbMocks.resolveLpGuardrailConfig.mockResolvedValue({
      maxPoolAllocationPct: 50,
      profitBankPct: 50,
      reserveSubVault: null
    });
    const resolved = await resolveReserveVault(scope, { hasActiveVaultGrant: async () => false });
    expect(resolved).toBeNull();
  });

  it('flags the pointer unvalidated when no active vault grant matches', async () => {
    dbMocks.resolveLpGuardrailConfig.mockResolvedValue(pointerConfig);
    dbMocks.getLpGuardrailConfig.mockResolvedValue(pointerConfig);

    const resolved = await resolveReserveVault(
      scope,
      { hasActiveVaultGrant: async () => false }
    );
    expect(resolved?.grantValidated).toBe(false);
    await expect(assertReserveVaultReady(scope, { hasActiveVaultGrant: async () => false }))
      .rejects.toThrow('unvalidated address');
  });

  it('a validated pointer passes the fail-closed guard', async () => {
    dbMocks.resolveLpGuardrailConfig.mockResolvedValue(pointerConfig);
    dbMocks.getLpGuardrailConfig.mockResolvedValue(pointerConfig);

    const resolved = await assertReserveVaultReady(
      scope,
      { hasActiveVaultGrant: async () => true }
    );
    expect(resolved.address).toBe('vault-1');
    expect(resolved.grantValidated).toBe(true);
  });

  it('a missing pointer is a distinct refusal from an unvalidated one', async () => {
    dbMocks.resolveLpGuardrailConfig.mockResolvedValue({
      maxPoolAllocationPct: 50,
      profitBankPct: 50,
      reserveSubVault: null
    });
    dbMocks.getLpGuardrailConfig.mockResolvedValue(null);
    await expect(assertReserveVaultReady(scope, { hasActiveVaultGrant: async () => true }))
      .rejects.toThrow('no reserve sub-vault configured');
  });
});
