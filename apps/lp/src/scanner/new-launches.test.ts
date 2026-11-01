import { describe, it, expect } from 'vitest';
import {
  evaluateRugShield,
  rankHotNewLaunches,
  MAX_NEW_LAUNCH_AGE_HOURS,
  type HotLaunchPool
} from './new-launches.js';
import { evmHoneypotCheck, type EvmHoneypotPort } from '../risk/evm-checks.js';
import {
  HONEYPOT_DETECTED_FLAG,
  EXCESSIVE_TAX_FLAG,
  UNVERIFIED_SOURCE_FLAG,
  MINT_AUTHORITY_FLAG
} from '../risk/types.js';
import type { LpPool } from '@swat/db';

describe('Track 3: Hot Coin Launch Discovery & Rug Shield', () => {
  const now = new Date('2026-11-01T12:00:00Z');

  const createMockPool = (overrides: Partial<LpPool> = {}): LpPool => ({
    id: 'pool-test',
    chain: 'solana',
    protocol: 'meteora-dlmm',
    poolAddress: 'solana:pool-abc',
    pairLabel: 'HOT/SOL',
    baseTokenMint: 'solana:HOT1111111111111111111111111111111111111111',
    quoteTokenMint: 'solana:So11111111111111111111111111111111111111112',
    feeBps: 100,
    binStep: 20,
    tickSpacing: null,
    currentPrice: 1.5,
    tvl: 50_000,
    activeTvl: 20_000,
    volume24h: 150_000,
    feeApr24h: 350.5,
    feeApr7d: null,
    riskScore: 15,
    riskFlags: [],
    lastScannedAt: now,
    createdAt: new Date(now.getTime() - 10 * 3600 * 1000), // 10 hours old
    ...overrides
  });

  describe('evaluateRugShield', () => {
    it('passes verified pool with low risk score and no dangerous flags', () => {
      const cleanPool = createMockPool({ riskScore: 10, riskFlags: [] });
      const result = evaluateRugShield(cleanPool);
      expect(result.passed).toBe(true);
      expect(result.rejectionReasons).toHaveLength(0);
    });

    it('rejects pool with riskScore > 30', () => {
      const riskyPool = createMockPool({ riskScore: 35 });
      const result = evaluateRugShield(riskyPool);
      expect(result.passed).toBe(false);
      expect(result.rejectionReasons[0]).toContain('high_risk_score');
    });

    it('rejects pool with active mint authority or honeypot flag', () => {
      const mintPool = createMockPool({ riskScore: 15, riskFlags: [MINT_AUTHORITY_FLAG] });
      const result = evaluateRugShield(mintPool);
      expect(result.passed).toBe(false);
      expect(result.rejectionReasons[0]).toContain(MINT_AUTHORITY_FLAG);

      const honeypotPool = createMockPool({ riskScore: 15, riskFlags: [HONEYPOT_DETECTED_FLAG] });
      expect(evaluateRugShield(honeypotPool).passed).toBe(false);
    });

    it('rejects pool pending risk audit (null riskScore)', () => {
      const unassessedPool = createMockPool({ riskScore: null });
      const result = evaluateRugShield(unassessedPool);
      expect(result.passed).toBe(false);
      expect(result.rejectionReasons[0]).toContain('risk_audit_pending');
    });
  });

  describe('rankHotNewLaunches', () => {
    it('filters out pools older than 48h and sorts by multi-factor score', () => {
      const freshHot = createMockPool({
        poolAddress: 'solana:pool-fresh-hot',
        pairLabel: 'HOT/SOL',
        createdAt: new Date(now.getTime() - 6 * 3600 * 1000), // 6h old
        volume24h: 200_000,
        activeTvl: 20_000, // V/L = 10.0
        feeApr24h: 500,
        riskScore: 10
      });

      const freshModerate = createMockPool({
        poolAddress: 'solana:pool-fresh-mod',
        pairLabel: 'MOD/SOL',
        createdAt: new Date(now.getTime() - 24 * 3600 * 1000), // 24h old
        volume24h: 50_000,
        activeTvl: 25_000, // V/L = 2.0
        feeApr24h: 80,
        riskScore: 15
      });

      const oldPool = createMockPool({
        poolAddress: 'solana:pool-old',
        pairLabel: 'OLD/SOL',
        createdAt: new Date(now.getTime() - (MAX_NEW_LAUNCH_AGE_HOURS + 5) * 3600 * 1000) // 53h old
      });

      const rugPool = createMockPool({
        poolAddress: 'solana:pool-rug',
        pairLabel: 'RUG/SOL',
        createdAt: new Date(now.getTime() - 2 * 3600 * 1000),
        riskScore: 85,
        riskFlags: [HONEYPOT_DETECTED_FLAG]
      });

      const ranked = rankHotNewLaunches([freshModerate, oldPool, rugPool, freshHot], now);

      // Only the 2 fresh, clean pools should be present
      expect(ranked).toHaveLength(2);
      expect(ranked[0]!.poolAddress).toBe('solana:pool-fresh-hot');
      expect(ranked[1]!.poolAddress).toBe('solana:pool-fresh-mod');

      // Check metrics calculations
      expect(ranked[0]!.volumeToActiveLiquidity).toBe(10.0);
      expect(ranked[0]!.volatilitySurgeIndex).toBe(5.0);
      expect(ranked[0]!.ageHours).toBe(6.0);
      expect(ranked[0]!.dailyFeeYieldPct).toBeCloseTo(500 / 365 * 100, 1);
    });
  });

  describe('evmHoneypotCheck', () => {
    it('detects honeypot and high-tax contracts', async () => {
      const mockHoneypotPort: EvmHoneypotPort = {
        checkTokenSecurity: async () => ({
          isHoneypot: true,
          buyTax: 0.1,
          sellTax: 0.2,
          isOpenSource: false,
          cannotSellAll: true
        })
      };

      const check = evmHoneypotCheck(mockHoneypotPort);
      const findings = await check({
        chain: 'base',
        baseTokenMint: 'base:0xTokenHoneypot',
        quoteTokenMint: 'base:0xUsdc',
        poolAddress: 'base:0xPool'
      });

      expect(findings).toHaveLength(3);
      expect(findings.some((f) => f.flag === HONEYPOT_DETECTED_FLAG)).toBe(true);
      expect(findings.some((f) => f.flag === EXCESSIVE_TAX_FLAG)).toBe(true);
      expect(findings.some((f) => f.flag === UNVERIFIED_SOURCE_FLAG)).toBe(true);
    });

    it('returns empty findings for clean contract', async () => {
      const mockCleanPort: EvmHoneypotPort = {
        checkTokenSecurity: async () => ({
          isHoneypot: false,
          buyTax: 0.0,
          sellTax: 0.0,
          isOpenSource: true,
          cannotSellAll: false
        })
      };

      const check = evmHoneypotCheck(mockCleanPort);
      const findings = await check({
        chain: 'base',
        baseTokenMint: 'base:0xTokenClean',
        quoteTokenMint: 'base:0xUsdc',
        poolAddress: 'base:0xPool'
      });

      expect(findings).toHaveLength(0);
    });
  });
});
