import { describe, expect, it } from 'vitest';
import {
  calculateBalanceAwareSize,
  calculateRiskBasedSize,
  capPositionToAvailableBalance,
  floorToPrecision,
  parseNonNegativeNumber,
  parsePositiveNumber,
  parseScore,
  parseTradingMode,
  evaluateExecutionPolicy,
  type ExecutionPolicyInput,
  type ExecutionPolicySnapshot,
  type ExecutionPolicyScope
} from './policy.js';

const SCOPE: ExecutionPolicyScope = {
  account: 'user-1', chain: 'solana', tokenMint: 'solana:TOKEN', masterWalletAddress: 'solana:MASTER'
};
const SNAPSHOT: ExecutionPolicySnapshot = {
  scope: SCOPE, policyId: 'subscription-1', revision: 'revision-1', mode: 'live',
  mirrors: 'buys-and-sells', autoExecute: true, killed: false, maxSlippageBps: 50
};
function exitPolicy(overrides: Partial<ExecutionPolicyInput> = {}): ExecutionPolicyInput {
  return {
    scope: SCOPE, direction: 'sell', score: 10, minimumScore: 80, platformMode: 'live',
    queued: SNAPSHOT, current: { ...SNAPSHOT, revision: 'revision-2', mirrors: 'sells-only' },
    ownedExit: {
      scope: SCOPE, lotId: 'lot-1', availableQuantity: '4', requestedQuantity: '2',
      acquisitionMode: 'live', maxSlippageBps: 100
    },
    ...overrides
  };
}

describe('current execution policy intersection', () => {
  it('admits only a scoped owned exit below entry scores, even after winding down', () => {
    expect(evaluateExecutionPolicy(exitPolicy())).toEqual({
      allowed: true, executionMode: 'live', maxSlippageBps: 50, reducing: true
    });
  });

  it.each([
    { killed: true }, { autoExecute: false }, { mode: 'off' as const }, { mirrors: 'none' as const }
  ])('retains the current explicit stop %j for reducing exits', change => {
    expect(evaluateExecutionPolicy(exitPolicy({ current: { ...SNAPSHOT, ...change } })).allowed).toBe(false);
  });

  it.each([
    { killed: true }, { autoExecute: false }, { mode: 'off' as const }, { mirrors: 'none' as const }
  ])('cannot widen a queued stop %j after current policy is relaxed', change => {
    expect(evaluateExecutionPolicy(exitPolicy({ queued: { ...SNAPSHOT, ...change } })).allowed).toBe(false);
  });

  it('cannot turn an acquired paper lot into a live order', () => {
    const input = exitPolicy();
    expect(evaluateExecutionPolicy({
      ...input, ownedExit: { ...input.ownedExit!, acquisitionMode: 'paper' }
    })).toEqual({ allowed: true, executionMode: 'paper', maxSlippageBps: 50, reducing: true });
  });

  it.each(['queued', 'current', 'platformMode'] as const)('does not pretend a live exit settled in paper when %s is paper', key => {
    const input = exitPolicy();
    const clamped = key === 'platformMode'
      ? { ...input, platformMode: 'paper' as const }
      : { ...input, [key]: { ...SNAPSHOT, mode: 'paper' as const } };
    expect(evaluateExecutionPolicy(clamped)).toEqual({ allowed: false, reason: 'acquisition-mode-not-permitted' });
  });

  it.each(['account', 'tokenMint', 'masterWalletAddress'] as const)('rejects another %s as owned inventory', field => {
    const input = exitPolicy();
    expect(evaluateExecutionPolicy({
      ...input, ownedExit: { ...input.ownedExit!, scope: { ...SCOPE, [field]: 'solana:OTHER' } }
    })).toEqual({ allowed: false, reason: 'owned-exit-scope-mismatch' });
  });

  describe('exact reducing exit quantities', () => {
    function decision(availableQuantity: unknown, requestedQuantity: unknown) {
      const input = exitPolicy();
      return evaluateExecutionPolicy({
        ...input,
        // Deliberately bypass the string contract to exercise untrusted runtime input.
        ownedExit: {
          ...input.ownedExit!, availableQuantity: availableQuantity as string,
          requestedQuantity: requestedQuantity as string
        }
      });
    }

    const allowed = { allowed: true, executionMode: 'live', maxSlippageBps: 50, reducing: true };
    const invalid = { allowed: false, reason: 'owned-exit-invalid' };

    it.each([
      ['9007199254740993', '9007199254740992'],
      ['9007199254740995', '9007199254740994'],
      ['9007199254740995', '9007199254740995']
    ])('admits exact inventory above 2^53: available %s, requested %s', (available, requested) => {
      expect(decision(available, requested)).toEqual(allowed);
    });

    it.each([
      ['4', '5'],
      ['9007199254740992', '9007199254740993'],
      ['9007199254740995', '9007199254740996'],
      ['1', '1.00000000000000000001'],
      ['0.00000000000000000001', '0.00000000000000000002'],
      ['9007199254740993.00000000000000000001', '9007199254740993.00000000000000000002']
    ])('rejects exact oversell: available %s, requested %s', (available, requested) => {
      expect(decision(available, requested)).toEqual(invalid);
    });

    it.each([
      ['0004.000', '4'], ['4', '0004.000'], ['.5', '0.5000'], ['0.5000', '.5'],
      ['005.', '5.000'], ['5.000', '005.'],
      ['0009007199254740993.000', '9007199254740993'],
      ['0.0000000000000000000100', '.00000000000000000001']
    ])('accepts equivalent plain decimal spellings %s and %s', (available, requested) => {
      expect(decision(available, requested)).toEqual(allowed);
    });

    it.each([
      ['integer digits', '9'.repeat(256)],
      ['leading zeroes', `${'0'.repeat(255)}1`],
      ['fractional scale', `0.${'0'.repeat(253)}1`],
      ['fractional scale without a whole digit', `.${'0'.repeat(254)}1`],
      ['trailing zeroes', `1.${'0'.repeat(254)}`],
      ['combined digits and decimal point', `${'9'.repeat(128)}.${'9'.repeat(127)}`]
    ])('accepts the 256-character resource boundary for %s', (_label, quantity) => {
      expect(decision(quantity, quantity)).toEqual(allowed);
    });

    it('compares exactly across the maximum permitted scale difference', () => {
      const tiny = `.${'0'.repeat(254)}1`;
      expect(decision('1', tiny)).toEqual(allowed);
      expect(decision(tiny, '1')).toEqual(invalid);
    });

    it.each([
      '', ' ', ' 1', '1 ', '1\n', '\t1', '0', '00.000', '.0', '0.', '-1', '-0', '+1',
      '.', '1.2.3', '1_000', '1,000', '0x10', '1/2', 'NaN', 'Infinity', '-Infinity',
      '1e2', '1E-2', '1e1000000000', '1e-1000000000',
      '9'.repeat(257), `${'0'.repeat(256)}1`, `0.${'0'.repeat(254)}1`,
      `1.${'0'.repeat(255)}`, `${'9'.repeat(128)}.${'9'.repeat(128)}`, '1'.repeat(10_000),
      2, 0.5, 0, -1, 9007199254740993, Number.MIN_VALUE, Number.MAX_VALUE,
      Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      new Number(2), 2n, true, null, undefined, {}, []
    ].map((quantity, index) => ({ caseNumber: index + 1, quantity })))(
      'rejects invalid runtime quantity case $caseNumber in either field', ({ quantity }) => {
        expect(decision(quantity, '1')).toEqual(invalid);
        expect(decision('4', quantity)).toEqual(invalid);
      }
    );
  });

  it('does not treat sell direction or a stop-loss flag as inventory proof', () => {
    expect(evaluateExecutionPolicy(exitPolicy({ ownedExit: null }))).toEqual({ allowed: false, reason: 'owned-exit-unavailable' });
  });

  it('rejects missing current/queued facts rather than inventing paper authority', () => {
    expect(evaluateExecutionPolicy(exitPolicy({ current: null })).allowed).toBe(false);
    expect(evaluateExecutionPolicy(exitPolicy({ queued: null })).allowed).toBe(false);
  });

  it('retains queue, current and acquisition slippage independently', () => {
    const input = exitPolicy();
    expect(evaluateExecutionPolicy({
      ...input, current: { ...SNAPSHOT, maxSlippageBps: 20 },
      ownedExit: { ...input.ownedExit!, maxSlippageBps: 10 }
    })).toEqual({ allowed: true, executionMode: 'live', maxSlippageBps: 10, reducing: true });
    expect(evaluateExecutionPolicy({ ...input, current: { ...SNAPSHOT, maxSlippageBps: 1000 } }))
      .toEqual({ allowed: true, executionMode: 'live', maxSlippageBps: 50, reducing: true });
  });

  it.each([0, 5001, Number.NaN, 1.5])('refuses invalid tolerance %s instead of clamping upward', maxSlippageBps => {
    expect(evaluateExecutionPolicy(exitPolicy({ queued: { ...SNAPSHOT, maxSlippageBps } })).allowed).toBe(false);
  });

  it('rejects stale buy revision, winding-down buy and low score without exit exemptions', () => {
    expect(evaluateExecutionPolicy(exitPolicy({ direction: 'buy', ownedExit: null })).allowed).toBe(false);
    expect(evaluateExecutionPolicy(exitPolicy({
      direction: 'buy', ownedExit: null, current: { ...SNAPSHOT, revision: 'revision-2' }, score: 90
    }))).toEqual({ allowed: false, reason: 'stale-entry-policy' });
    expect(evaluateExecutionPolicy(exitPolicy({ direction: 'buy', ownedExit: null, current: SNAPSHOT })))
      .toEqual({ allowed: false, reason: 'entry-score-below-minimum' });
  });

  it('preserves a queued paper buy on a live platform', () => {
    expect(evaluateExecutionPolicy(exitPolicy({
      direction: 'buy', ownedExit: null, score: 90,
      queued: { ...SNAPSHOT, mode: 'paper' }, current: SNAPSHOT
    }))).toEqual({ allowed: true, executionMode: 'paper', maxSlippageBps: 50, reducing: false });
  });

  it('does not resurrect a replaced subscription identity or a shadow lot', () => {
    expect(evaluateExecutionPolicy(exitPolicy({ current: { ...SNAPSHOT, policyId: 'replacement' } })).allowed).toBe(false);
    const input = exitPolicy();
    expect(evaluateExecutionPolicy({ ...input, ownedExit: { ...input.ownedExit!, acquisitionMode: 'shadow' } }).allowed).toBe(false);
  });
});

describe('parseTradingMode', () => {
  it('defaults only an absent value to paper', () => {
    expect(parseTradingMode(undefined)).toBe('paper');
  });

  it('accepts exact supported values', () => {
    expect(parseTradingMode('paper')).toBe('paper');
    expect(parseTradingMode('live')).toBe('live');
  });

  it.each(['Paper', 'live ', '', 'test'])('rejects unsafe mode %j', (value) => {
    expect(() => parseTradingMode(value)).toThrow(/must be exactly/);
  });
});

describe('numeric policy validation', () => {
  it('accepts bounded scores and rejects missing or invalid scores', () => {
    expect(parseScore(0, 'score')).toBe(0);
    expect(parseScore('85', 'score')).toBe(85);
    expect(() => parseScore(undefined, 'score')).toThrow();
    expect(() => parseScore(null, 'score')).toThrow();
    expect(() => parseScore('', 'score')).toThrow();
    expect(() => parseScore(' 85', 'score')).toThrow();
    expect(() => parseScore(Number.NaN, 'score')).toThrow();
    expect(() => parseScore(101, 'score')).toThrow();
  });

  it('requires positive finite configuration numbers', () => {
    expect(parsePositiveNumber(undefined, 15_000, 'timeout')).toBe(15_000);
    expect(() => parsePositiveNumber('0', 15_000, 'timeout')).toThrow();
    expect(parseNonNegativeNumber('0', 60, 'cooldown')).toBe(0);
    expect(() => parseNonNegativeNumber('-1', 60, 'cooldown')).toThrow();
  });
});

describe('calculateRiskBasedSize', () => {
  it('sizes down for small balances instead of applying a static floor', () => {
    expect(calculateRiskBasedSize({
      balance: 20,
      riskPct: 2,
      tierMultiplier: 1,
      scoreMultiplier: 1,
      maximum: 500,
      precision: 2
    })).toBe(0.4);
  });

  it('never exceeds the configured maximum or available balance', () => {
    expect(calculateRiskBasedSize({
      balance: 100_000,
      riskPct: 100,
      tierMultiplier: 1,
      scoreMultiplier: 1,
      maximum: 500,
      precision: 2
    })).toBe(500);
    expect(calculateRiskBasedSize({
      balance: 0.001,
      riskPct: 100,
      tierMultiplier: 1,
      scoreMultiplier: 1,
      maximum: 0.5,
      precision: 6
    })).toBe(0.001);
  });

  it('floors rather than rounds above a sub-precision balance', () => {
    expect(floorToPrecision(0.0000009, 6)).toBe(0);
    expect(capPositionToAvailableBalance({
      requested: 100,
      available: 20.009,
      maximum: 500,
      precision: 2
    })).toBe(20);
  });

  it('caps static sizing to the available balance when dynamic sizing is disabled', () => {
    expect(calculateBalanceAwareSize({
      balance: 20,
      base: 100,
      maximum: 500,
      riskPct: 2,
      tierMultiplier: 1,
      scoreMultiplier: 1,
      precision: 2,
      dynamic: false
    })).toBe(20);
  });

  it('uses risk-based sizing when dynamic sizing is enabled', () => {
    expect(calculateBalanceAwareSize({
      balance: 20,
      base: 100,
      maximum: 500,
      riskPct: 2,
      tierMultiplier: 1,
      scoreMultiplier: 1,
      precision: 2,
      dynamic: true
    })).toBe(0.4);
  });
});
