import { describe, expect, it, vi } from 'vitest';

vi.mock('@swat/db', () => ({ resolveChainMode: vi.fn() }));

import {
  getLastRobinhoodOpsAlert,
  verifyRobinhoodEnvironment
} from './robinhood-startup.js';

const values = {
  ROBINHOOD_CHAIN_ID: '4663',
  ROBINHOOD_RPC_URL: 'http://rpc.invalid',
  ROBINHOOD_SWAP_ROUTER: '0x1111111111111111111111111111111111111111',
  ROBINHOOD_QUOTER: '0x2222222222222222222222222222222222222222',
  ROBINHOOD_WETH9: '0x3333333333333333333333333333333333333333',
  ROBINHOOD_BASE_ASSET: '0x3333333333333333333333333333333333333333',
  ROBINHOOD_SANITY_TOKEN: '0x4444444444444444444444444444444444444444',
  ROBINHOOD_FEE_TIERS: '3000',
  ROBINHOOD_ROUTER_ABI_VERSION: 'uniswap-v3-swap-router-01',
  ROBINHOOD_QUOTER_ABI_VERSION: 'uniswap-v3-quoter-v2',
  ROBINHOOD_BASE_ASSET_MODE: 'native-weth'
};

describe('Robinhood startup runtime readiness', () => {
  it('clamps live readiness and emits the ops alert when durable runtime setup fails', async () => {
    const emitOpsAlert = vi.fn().mockResolvedValue(undefined);
    const result = await verifyRobinhoodEnvironment({
      values,
      resolveMode: vi.fn().mockResolvedValue({
        requestedMode: 'live',
        effectiveMode: 'live',
        certified: true
      }),
      runtimeCheck: () => {
        throw new Error('durable pending store unavailable');
      },
      emitOpsAlert
    });

    expect(result).toMatchObject({ ready: false, reason: 'durable pending store unavailable' });
    expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ROBINHOOD_LIVE_NOT_READY',
      chain: 'robinhood-chain',
      severity: 'critical'
    }));
    expect(getLastRobinhoodOpsAlert()).toMatchObject({
      type: 'ROBINHOOD_LIVE_NOT_READY',
      reason: 'durable pending store unavailable'
    });

    await verifyRobinhoodEnvironment({
      resolveMode: vi.fn().mockResolvedValue({
        requestedMode: 'paper',
        effectiveMode: 'paper',
        certified: false
      })
    });
    expect(getLastRobinhoodOpsAlert()).toBeNull();
  });
});
