import { describe, expect, it } from 'vitest';
import { parseStarterPackWallets, parseWalletChain, resolveStarterPackPath } from './starter-pack.js';
const SOLANA_A = '11111111111111111111111111111111';
const EVM_A = '0xabcdef0123456789abcdef0123456789abcdef01';
describe('starter pack input validation', () => {
    it('parses a validated Solana string array and removes duplicates', () => {
        expect(parseStarterPackWallets(JSON.stringify([SOLANA_A, `solana:${SOLANA_A}`]), 'solana')).toEqual([{ address: SOLANA_A, chain: 'solana' }]);
    });
    it('preserves explicit chain identity for prefixed and object entries', () => {
        expect(parseStarterPackWallets(JSON.stringify([
            `polygon:0x${EVM_A.slice(2).toUpperCase()}`,
            { address: EVM_A, chain: 'robinhood-chain' }
        ]), 'solana')).toEqual([
            { address: EVM_A, chain: 'polygon' },
            { address: EVM_A, chain: 'robinhood-chain' }
        ]);
    });
    it('rejects malformed arrays, invalid addresses, and invalid chain settings', () => {
        expect(() => parseStarterPackWallets('{}', 'solana')).toThrow(/must be an array/);
        expect(() => parseStarterPackWallets(JSON.stringify(['not-a-wallet']), 'solana')).toThrow(/valid solana address/);
        expect(() => parseWalletChain('avalanche')).toThrow(/WALLET_CHAIN/);
    });
    it('resolves the default starter-pack path from the module location', () => {
        expect(resolveStarterPackPath('file:///repo/apps/scorer/_ingest_wallets.ts')).toBe('/repo/wallet-starter-pack.json');
    });
});
//# sourceMappingURL=starter-pack.test.js.map