import { describe, expect, it, vi } from 'vitest';
import { buildPosition } from './build-position.js';

describe('legacy LP numeric builder is not financial authority', () => {
  it.each(['paper', 'live', 'off'] as const)('%s cannot acquire through numeric/source-label seam', async mode => {
    const persist = vi.fn(), value = vi.fn(), guard = vi.fn();
    await expect(buildPosition({ executionMode: { resolveMode: async () => mode }, persistPosition: persist,
      valuation: { value }, deployGuard: { assertDeployAllowed: guard } } as any, { userId: 'alice' } as any,
      { chain: 'solana', poolAddress: 'solana:pool', depositAsset: 'solana:mint', depositAmount: 1, operationKey: 'key' } as any)).rejects.toThrow('legacy numeric');
    expect(persist).not.toHaveBeenCalled(); expect(value).not.toHaveBeenCalled(); expect(guard).not.toHaveBeenCalled();
  });
});
