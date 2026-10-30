/**
 * Pinned EntryPoint configuration for ERC-4337 on Robinhood Chain (S4-P11).
 *
 * Robinhood Chain (chain ID 4663) has three deployed EntryPoint versions:
 * - v0.6.0: 0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789
 * - v0.7.0: 0x0000000071727De22E5E9d8BAf0edAc6f37da032
 * - v0.8.0: 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108
 *
 * Paymaster interfaces, UserOperation packing, and gas accounting differ across
 * versions. An implicit or unpinned default creates silent-mismatch defects at
 * bundle submission. We pin v0.7.0 and assert it at runtime.
 */

export const ROBINHOOD_CHAIN_ENTRYPOINTS = {
  v0_6: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  v0_7: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  v0_8: '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'
} as const;

export type EntryPointVersion = keyof typeof ROBINHOOD_CHAIN_ENTRYPOINTS;

export const PINNED_ENTRYPOINT_VERSION: EntryPointVersion = 'v0_7';
export const PINNED_ENTRYPOINT_ADDRESS = ROBINHOOD_CHAIN_ENTRYPOINTS[PINNED_ENTRYPOINT_VERSION];

/**
 * Validates that an EntryPoint address matches the pinned v0.7.0 address.
 * Throws a descriptive error on mismatch.
 */
export function assertPinnedEntryPoint(address?: string): string {
  const target = address ?? process.env.ENTRYPOINT_ADDRESS ?? PINNED_ENTRYPOINT_ADDRESS;
  if (target.toLowerCase() !== PINNED_ENTRYPOINT_ADDRESS.toLowerCase()) {
    throw new Error(
      `[authority] Invalid EntryPoint address: expected ${PINNED_ENTRYPOINT_ADDRESS} (${PINNED_ENTRYPOINT_VERSION}), got ${target}`
    );
  }
  return target;
}
