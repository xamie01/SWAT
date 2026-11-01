import type { LpChain, LpProtocol } from '@swat/shared';
import type { ObservedPosition } from '../wallets/types.js';
import type { MasterLpEvent } from './sizing.js';

export interface WalletPositionState {
  readonly positionAddress: string;
  readonly poolAddress: string;
  readonly positionValueUsd: number;
  readonly uncollectedFeesUsd: number;
  readonly inRange: boolean;
  readonly firstObservedAt: Date;
}

/**
 * Compares two snapshots of a master wallet's open positions and emits
 * discrete MasterLpEvent notifications (mint, increase, decrease, burn, collect).
 */
export function diffMasterPositions(
  masterWalletAddress: string,
  chain: LpChain,
  venue: LpProtocol,
  previousPositions: ReadonlyMap<string, WalletPositionState>,
  currentPositions: readonly ObservedPosition[],
  now = new Date()
): {
  readonly events: readonly MasterLpEvent[];
  readonly nextState: Map<string, WalletPositionState>;
} {
  const events: MasterLpEvent[] = [];
  const nextState = new Map<string, WalletPositionState>();

  const currentMap = new Map<string, ObservedPosition>();
  for (const pos of currentPositions) {
    currentMap.set(pos.positionAddress, pos);
  }

  // 1. Detect new positions (mint) or updates (increase, decrease, collect)
  for (const pos of currentPositions) {
    const prev = previousPositions.get(pos.positionAddress);
    if (!prev) {
      // Newly opened position!
      const openedAt = now;
      nextState.set(pos.positionAddress, {
        positionAddress: pos.positionAddress,
        poolAddress: pos.poolAddress,
        positionValueUsd: pos.positionValueUsd,
        uncollectedFeesUsd: pos.uncollectedFeesUsd,
        inRange: pos.inRange,
        firstObservedAt: openedAt
      });

      events.push({
        masterWalletAddress,
        chain,
        venue,
        masterPositionId: pos.positionAddress,
        poolAddress: pos.poolAddress,
        action: 'mint',
        masterDepositUsd: pos.positionValueUsd,
        openedAt
      });
    } else {
      // Position existed before - check for adjustments
      const openedAt = prev.firstObservedAt;
      const valueDiff = pos.positionValueUsd - prev.positionValueUsd;
      const feeDiff = pos.uncollectedFeesUsd - prev.uncollectedFeesUsd;

      // Significant deposit increase (> 5% and > $5)
      if (valueDiff > 5 && valueDiff > prev.positionValueUsd * 0.05) {
        events.push({
          masterWalletAddress,
          chain,
          venue,
          masterPositionId: pos.positionAddress,
          poolAddress: pos.poolAddress,
          action: 'increase',
          masterDepositUsd: valueDiff,
          openedAt
        });
      }
      // Significant position decrease (> 5% and > $5)
      else if (valueDiff < -5 && Math.abs(valueDiff) > prev.positionValueUsd * 0.05) {
        events.push({
          masterWalletAddress,
          chain,
          venue,
          masterPositionId: pos.positionAddress,
          poolAddress: pos.poolAddress,
          action: 'decrease',
          masterDepositUsd: Math.abs(valueDiff),
          openedAt
        });
      }

      // Fee collection detected (fees dropped by > $2 without value decrease)
      if (feeDiff < -2.0) {
        events.push({
          masterWalletAddress,
          chain,
          venue,
          masterPositionId: pos.positionAddress,
          poolAddress: pos.poolAddress,
          action: 'collect',
          masterDepositUsd: Math.abs(feeDiff),
          openedAt
        });
      }

      nextState.set(pos.positionAddress, {
        positionAddress: pos.positionAddress,
        poolAddress: pos.poolAddress,
        positionValueUsd: pos.positionValueUsd,
        uncollectedFeesUsd: pos.uncollectedFeesUsd,
        inRange: pos.inRange,
        firstObservedAt: openedAt
      });
    }
  }

  // 2. Detect closed positions (burn)
  for (const [posAddress, prev] of previousPositions.entries()) {
    if (!currentMap.has(posAddress)) {
      events.push({
        masterWalletAddress,
        chain,
        venue,
        masterPositionId: posAddress,
        poolAddress: prev.poolAddress,
        action: 'burn',
        masterDepositUsd: prev.positionValueUsd,
        openedAt: prev.firstObservedAt
      });
    }
  }

  return { events, nextState };
}
