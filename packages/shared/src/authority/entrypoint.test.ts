import { describe, expect, it } from 'vitest';
import {
  ROBINHOOD_CHAIN_ENTRYPOINTS,
  PINNED_ENTRYPOINT_VERSION,
  PINNED_ENTRYPOINT_ADDRESS,
  assertPinnedEntryPoint
} from './entrypoint.js';

describe('ERC-4337 EntryPoint Pinning (S4-P11)', () => {
  it('pins v0.7.0 as the active EntryPoint version', () => {
    expect(PINNED_ENTRYPOINT_VERSION).toBe('v0_7');
    expect(PINNED_ENTRYPOINT_ADDRESS).toBe('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
  });

  it('contains expected deployed EntryPoint addresses on chain 4663', () => {
    expect(ROBINHOOD_CHAIN_ENTRYPOINTS.v0_6).toBe('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789');
    expect(ROBINHOOD_CHAIN_ENTRYPOINTS.v0_7).toBe('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
    expect(ROBINHOOD_CHAIN_ENTRYPOINTS.v0_8).toBe('0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108');
  });

  it('accepts the pinned address (case-insensitive)', () => {
    expect(assertPinnedEntryPoint(PINNED_ENTRYPOINT_ADDRESS)).toBe(PINNED_ENTRYPOINT_ADDRESS);
    expect(assertPinnedEntryPoint(PINNED_ENTRYPOINT_ADDRESS.toLowerCase())).toBe(
      PINNED_ENTRYPOINT_ADDRESS.toLowerCase()
    );
  });

  it('rejects an unpinned EntryPoint version (e.g. v0.6 or v0.8)', () => {
    expect(() => assertPinnedEntryPoint(ROBINHOOD_CHAIN_ENTRYPOINTS.v0_6)).toThrow(
      /expected 0x0000000071727De22E5E9d8BAf0edAc6f37da032 \(v0_7\)/
    );
    expect(() => assertPinnedEntryPoint(ROBINHOOD_CHAIN_ENTRYPOINTS.v0_8)).toThrow(
      /expected 0x0000000071727De22E5E9d8BAf0edAc6f37da032 \(v0_7\)/
    );
  });

  it('defaults to PINNED_ENTRYPOINT_ADDRESS when no address or env is passed', () => {
    const original = process.env.ENTRYPOINT_ADDRESS;
    try {
      delete process.env.ENTRYPOINT_ADDRESS;
      expect(assertPinnedEntryPoint()).toBe(PINNED_ENTRYPOINT_ADDRESS);
    } finally {
      if (original !== undefined) {
        process.env.ENTRYPOINT_ADDRESS = original;
      }
    }
  });

  it('asserts against process.env.ENTRYPOINT_ADDRESS when configured', () => {
    const original = process.env.ENTRYPOINT_ADDRESS;
    try {
      process.env.ENTRYPOINT_ADDRESS = '0x1111111111111111111111111111111111111111';
      expect(() => assertPinnedEntryPoint()).toThrow(/Invalid EntryPoint address/);
    } finally {
      if (original !== undefined) {
        process.env.ENTRYPOINT_ADDRESS = original;
      } else {
        delete process.env.ENTRYPOINT_ADDRESS;
      }
    }
  });
});
