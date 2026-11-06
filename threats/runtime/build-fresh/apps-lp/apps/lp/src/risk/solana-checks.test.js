import { describe, expect, it } from 'vitest';
import { detectBundledWallets } from './bundled-wallets.js';
import { fetchHolderConcentration, holderConcentrationFinding, liquidityLockFinding, mintAuthorityFindings, parseSplMintAuthorities } from './solana-checks.js';
const t0 = Date.parse('2026-10-04T00:00:00Z');
function edge(wallet, fundedFrom, minutesAfterLaunch) {
    return { wallet, fundedFrom, fundedAt: new Date(t0 + minutesAfterLaunch * 60_000) };
}
describe('detectBundledWallets', () => {
    it('flags three wallets funded from one source inside the window', () => {
        const finding = detectBundledWallets([
            edge('w1', 'funder-a', 0),
            edge('w2', 'funder-a', 2),
            edge('w3', 'funder-a', 5)
        ]);
        expect(finding?.flag).toBe('bundled_launch');
        expect(finding?.sources).toEqual(['funder-a']);
        expect(finding?.walletCount).toBe(3);
    });
    it('the same source spread over hours is not a bundle', () => {
        const finding = detectBundledWallets([
            edge('w1', 'funder-a', 0),
            edge('w2', 'funder-a', 60),
            edge('w3', 'funder-a', 120)
        ]);
        expect(finding).toBeNull();
    });
    it('two wallets from one source do not meet the bundle bar', () => {
        expect(detectBundledWallets([edge('w1', 'funder-a', 0), edge('w2', 'funder-a', 1)])).toBeNull();
    });
    it('an empty allocation graph is not a finding', () => {
        expect(detectBundledWallets([])).toBeNull();
    });
});
describe('holder concentration', () => {
    it('flags when the top 10 hold at least half the supply', () => {
        const snapshot = {
            top10Amounts: [60, 5, 5, 5, 5, 4, 4, 4, 4, 4],
            supply: 100
        };
        const finding = holderConcentrationFinding(snapshot);
        expect(finding?.top10Share).toBe(1);
        expect(finding?.flag).toBe('holder_concentration');
    });
    it('a healthy distribution is not a finding', () => {
        const snapshot = {
            top10Amounts: Array.from({ length: 10 }, () => 2),
            supply: 100
        };
        expect(holderConcentrationFinding(snapshot)).toBeNull();
    });
    it('zero supply reads as no finding, not as infinite concentration', () => {
        expect(holderConcentrationFinding({ top10Amounts: [1], supply: 0 })).toBeNull();
    });
    it('fetches largest accounts and supply through the RPC port', async () => {
        const calls = [];
        const port = {
            call: async (method, params) => {
                calls.push({ method, params });
                if (method === 'getTokenLargestAccounts') {
                    return { value: [{ amount: '60' }, { amount: '5' }] };
                }
                return { value: { amount: '100' } };
            }
        };
        const snapshot = await fetchHolderConcentration(port, 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
        expect(snapshot.top10Amounts).toEqual([60, 5]);
        expect(snapshot.supply).toBe(100);
        expect(calls[0]?.method).toBe('getTokenLargestAccounts');
    });
});
describe('parseSplMintAuthorities', () => {
    function mintAccountBytes(options) {
        const data = Buffer.alloc(82);
        if (options.mintAuthority) {
            data.writeUInt32LE(1, 0);
            Buffer.from(options.mintAuthority, 'hex').copy(data, 4);
        }
        if (options.freezeAuthority) {
            data.writeUInt32LE(1, 46);
            Buffer.from(options.freezeAuthority, 'hex').copy(data, 50);
        }
        return data.toString('base64');
    }
    it('reads both authorities as active when set', () => {
        const authorities = parseSplMintAuthorities(mintAccountBytes({ mintAuthority: 'aa'.repeat(32), freezeAuthority: 'bb'.repeat(32) }));
        expect(authorities.mintAuthority).toBe('aa'.repeat(32));
        expect(authorities.freezeAuthority).toBe('bb'.repeat(32));
        expect(mintAuthorityFindings(authorities)).toHaveLength(2);
    });
    it('revoked authorities produce no findings', () => {
        const authorities = parseSplMintAuthorities(mintAccountBytes({}));
        expect(authorities.mintAuthority).toBeNull();
        expect(authorities.freezeAuthority).toBeNull();
        expect(mintAuthorityFindings(authorities)).toEqual([]);
    });
    it('rejects truncated account data', () => {
        expect(() => parseSplMintAuthorities(Buffer.alloc(10).toString('base64'))).toThrow('82');
    });
});
describe('liquidityLockFinding', () => {
    it('flags when most LP tokens sit in movable wallets', () => {
        const snapshot = { lockedOrBurnedAmount: 10, movableAmount: 90 };
        expect(liquidityLockFinding(snapshot)?.flag).toBe('liquidity_unlocked');
    });
    it('burned or locked LP is not a finding', () => {
        const snapshot = { lockedOrBurnedAmount: 99, movableAmount: 1 };
        expect(liquidityLockFinding(snapshot)).toBeNull();
    });
    it('no LP tokens at all is silence, not a flag', () => {
        expect(liquidityLockFinding({ lockedOrBurnedAmount: 0, movableAmount: 0 })).toBeNull();
    });
});
//# sourceMappingURL=solana-checks.test.js.map