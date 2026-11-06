import { describe, expect, it, vi } from 'vitest';
vi.mock('@swat/db', () => ({ resolveChainMode: vi.fn() }));
import { getLastRobinhoodOpsAlert, verifyRobinhoodEnvironment } from './robinhood-startup.js';
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
/**
 * Builds a client stub whose `getBytecode` returns empty for the named contracts.
 *
 * The default is a non-empty result for everything, so a test names only the
 * address it wants to be missing -- otherwise every one of these tests would
 * have to enumerate five contracts to say something about one.
 */
function clientWithEmptyCodeAt(missing) {
    const empty = new Set(missing.map((address) => address.toLowerCase()));
    return {
        getChainId: vi.fn().mockResolvedValue(4663),
        getBytecode: vi.fn(async ({ address }) => empty.has(address.toLowerCase()) ? '0x' : '0x60806040'),
        simulateContract: vi.fn().mockResolvedValue({ result: [1n] })
    };
}
const liveMode = () => vi.fn().mockResolvedValue({
    requestedMode: 'live',
    effectiveMode: 'live',
    certified: true
});
/**
 * The configured-address bytecode gate (S4-M39).
 *
 * This gate already existed and had **no test**, which is how a documented
 * Ethereum-mainnet quoter address survived in `.env.example` for chain 4663: the
 * check that would have caught it was never proven to run. An untested guard on
 * a funds path is indistinguishable from an absent one, so each configured
 * contract gets its own case -- a loop that silently skipped an entry would
 * otherwise pass.
 */
describe('Robinhood configured-address bytecode gate (S4-M39)', () => {
    it.each([
        ['router', values.ROBINHOOD_SWAP_ROUTER],
        ['quoter', values.ROBINHOOD_QUOTER],
        ['WETH9', values.ROBINHOOD_WETH9],
        ['sanity token', values.ROBINHOOD_SANITY_TOKEN]
    ])('refuses live when the configured %s has no deployed bytecode', async (label, address) => {
        const result = await verifyRobinhoodEnvironment({
            values,
            resolveMode: liveMode(),
            client: clientWithEmptyCodeAt([address]),
            emitOpsAlert: vi.fn().mockResolvedValue(undefined)
        });
        expect(result.ready).toBe(false);
        // The label is in the message on purpose: "no deployed bytecode" alone sends
        // an operator to check five addresses instead of one.
        expect(result.reason).toContain(label);
        expect(result.reason).toContain('no deployed bytecode');
    });
    it('alerts rather than failing quietly, because a refused boot is an ops event', async () => {
        const emitOpsAlert = vi.fn().mockResolvedValue(undefined);
        await verifyRobinhoodEnvironment({
            values,
            resolveMode: liveMode(),
            client: clientWithEmptyCodeAt([values.ROBINHOOD_QUOTER]),
            emitOpsAlert
        });
        expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
            type: 'ROBINHOOD_LIVE_NOT_READY',
            severity: 'critical'
        }));
    });
    it('refuses live when the RPC chain id does not match the configured one', async () => {
        // A wrong-chain RPC is the other half of the same defect class: the addresses
        // may all have code, just not on the chain we think we are trading on.
        const client = clientWithEmptyCodeAt([]);
        client.getChainId = vi.fn().mockResolvedValue(1);
        const result = await verifyRobinhoodEnvironment({
            values,
            resolveMode: liveMode(),
            client: client,
            emitOpsAlert: vi.fn().mockResolvedValue(undefined)
        });
        expect(result.ready).toBe(false);
        expect(result.reason).toContain('does not match RPC chain ID');
    });
    it('passes the gate when every configured address has code', async () => {
        // The complement, so the four refusals above are not passing for an
        // unrelated reason.
        const result = await verifyRobinhoodEnvironment({
            values,
            resolveMode: liveMode(),
            client: clientWithEmptyCodeAt([]),
            emitOpsAlert: vi.fn().mockResolvedValue(undefined)
        });
        expect(result).toMatchObject({ ready: true, reason: 'onchain_environment_verified_for_process' });
    });
});
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
//# sourceMappingURL=robinhood-startup.test.js.map