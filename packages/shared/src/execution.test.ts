import { describe, it, expect } from 'vitest';
import { parseExecutionMode, mapLegacyTradingMode, parseLiveEnabledChains } from './execution.js';

describe('execution mode utilities', () => {
  describe('parseExecutionMode', () => {
    it('parses valid modes natively', () => {
      expect(parseExecutionMode('off')).toBe('off');
      expect(parseExecutionMode('paper')).toBe('paper');
      expect(parseExecutionMode('live')).toBe('live');
      expect(parseExecutionMode('live+shadow')).toBe('live+shadow');
    });

    it('requires exact values so live cannot be enabled accidentally', () => {
      expect(parseExecutionMode('LIVE')).toBe('paper');
      expect(parseExecutionMode(' live')).toBe('paper');
      expect(parseExecutionMode('live ')).toBe('paper');
      expect(parseExecutionMode('\tpaper\n')).toBe('paper');
    });

    it('fails closed to paper for unknown or empty values', () => {
      expect(parseExecutionMode('')).toBe('paper');
      expect(parseExecutionMode(null)).toBe('paper');
      expect(parseExecutionMode(undefined)).toBe('paper');
      expect(parseExecutionMode('invalid_mode')).toBe('paper');
      expect(parseExecutionMode('unknown')).toBe('paper');
    });
  });

  describe('mapLegacyTradingMode', () => {
    it('maps valid live modes when the chain is enabled', () => {
      expect(mapLegacyTradingMode('live', 'solana', ['solana'])).toBe('live');
      expect(mapLegacyTradingMode('live+shadow', 'robinhood-chain', ['solana', 'robinhood-chain'])).toBe('live+shadow');
    });

    it('clamps live modes to paper when the chain is not in the certified allowlist', () => {
      expect(mapLegacyTradingMode('live', 'polygon', ['solana'])).toBe('paper');
      expect(mapLegacyTradingMode('live+shadow', 'solana', [])).toBe('paper');
    });

    it('preserves non-live modes regardless of enabled chains', () => {
      expect(mapLegacyTradingMode('off', 'solana', [])).toBe('off');
      expect(mapLegacyTradingMode('paper', 'polygon', [])).toBe('paper');
    });

    it('fails closed for invalid legacy inputs', () => {
      expect(mapLegacyTradingMode('random_typo', 'solana', ['solana'])).toBe('paper');
      expect(mapLegacyTradingMode(' LIVE ', 'solana', ['solana'])).toBe('paper');
    });
  });

  describe('parseLiveEnabledChains', () => {
    it('parses comma-separated valid chains', () => {
      expect(parseLiveEnabledChains('solana, polygon')).toEqual(['solana', 'polygon']);
      expect(parseLiveEnabledChains('robinhood-chain,solana')).toEqual(['robinhood-chain', 'solana']);
    });

    it('ignores invalid chains and preserves valid ones', () => {
      expect(parseLiveEnabledChains('solana, garbage, polygon')).toEqual(['solana', 'polygon']);
    });

    it('handles empty input gracefully', () => {
      expect(parseLiveEnabledChains('')).toEqual([]);
      expect(parseLiveEnabledChains(null)).toEqual([]);
    });
  });
});
