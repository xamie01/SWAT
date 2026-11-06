import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { BINS_PER_BIN_ARRAY, BIN_STRIDE, createRpcSolanaBinSource, decodeBinArrayBins, decodeLbPairState, readU128LE } from './solana-bins.js';
/**
 * Layout fixtures encode the wire format exactly as verified on mainnet
 * (pool 5hbf9JP8…: active_id −604, bin_step 20, MET/USDC 6/6 decimals) so a
 * regression in the offsets cannot pass silently.
 */
const LB_PAIR_DISCRIMINATOR = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);
const BIN_ARRAY_DISCRIMINATOR = Buffer.from([92, 142, 92, 220, 5, 148, 70, 181]);
const LB_PAIR_SIZE = 8 + 32 + 32 + 1 + 2 + 1 + 4 + 2 + 1 + 1 + 2 + 1 + 1 + 32 + 32 + 32 + 32;
const B58_MET = 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL';
const B58_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function writeU128LE(buffer, offset, value) {
    buffer.writeBigUInt64LE(value & 0xffffffffffffffffn, offset);
    buffer.writeBigUInt64LE(value >> 64n, offset + 8);
}
function encodeLbPair(activeBinId, binStep) {
    const data = Buffer.alloc(LB_PAIR_SIZE);
    LB_PAIR_DISCRIMINATOR.copy(data, 0);
    // StaticParameters @8 (32B), VariableParameters @40 (32B) — zeros are fine.
    data.writeInt32LE(activeBinId, 76);
    data.writeUInt16LE(binStep, 80);
    Buffer.from(bs58.decode(B58_MET)).copy(data, 88);
    Buffer.from(bs58.decode(B58_USDC)).copy(data, 120);
    return data;
}
function encodeBinArray(index, bins) {
    const data = Buffer.alloc(56 + BINS_PER_BIN_ARRAY * BIN_STRIDE);
    BIN_ARRAY_DISCRIMINATOR.copy(data, 0);
    data.writeBigInt64LE(BigInt(index), 8);
    data[16] = 2; // version, as seen on mainnet
    for (const bin of bins) {
        const i = bin.binId - index * BINS_PER_BIN_ARRAY;
        if (i < 0 || i >= BINS_PER_BIN_ARRAY)
            continue;
        const base = 56 + i * BIN_STRIDE;
        data.writeBigUInt64LE(bin.rawX, base);
        data.writeBigUInt64LE(bin.rawY, base + 8);
        writeU128LE(data, base + 16, bin.priceQ64);
    }
    return data;
}
const Q64 = 2n ** 64n;
const priceQ64 = (humanPrice) => BigInt(Math.round(humanPrice * Number(Q64)));
function portWith(overrides = {}) {
    const calls = [];
    const lbPair = encodeLbPair(-604, 20);
    const arrays = [
        // One account per real array (mainnet never duplicates a bin across
        // accounts): index -9 covers -630..-561 and holds everything near active;
        // index -8 covers -560..-491 — outside ±10, must be filtered out entirely.
        encodeBinArray(-9, [
            { binId: -606, rawX: 0n, rawY: 910000000n, priceQ64: priceQ64(0.29806) },
            { binId: -605, rawX: 0n, rawY: 900000000n, priceQ64: priceQ64(0.298657) },
            { binId: -595, rawX: 0n, rawY: 940000000n, priceQ64: priceQ64(0.3026) }
        ]),
        encodeBinArray(-8, [{ binId: -560, rawX: 4099893529n, rawY: 0n, priceQ64: priceQ64(0.326645) }])
    ];
    return {
        calls,
        async getAccountInfoBase64(address) {
            calls.push(`info:${address}`);
            return lbPair.toString('base64');
        },
        async getProgramAccountsMemcmp(programId, offset, bytes) {
            calls.push(`gpa:${programId}:${offset}:${bytes}`);
            return arrays.map((data) => ({ pubkey: 'arr', dataBase64: data.toString('base64') }));
        },
        async getTokenDecimals(mint) {
            calls.push(`dec:${mint}`);
            return 6; // both MET and USDC carry 6 — verified on mainnet
        },
        ...overrides
    };
}
describe('decodeLbPairState (mainnet-verified offsets)', () => {
    it('reads active_id @76, bin_step @80, and the mints @88/@120', () => {
        const state = decodeLbPairState(encodeLbPair(-604, 20));
        expect(state.activeBinId).toBe(-604);
        expect(state.binStep).toBe(20);
        expect(state.tokenXMint).toBe(B58_MET);
        expect(state.tokenYMint).toBe(B58_USDC);
    });
    it('rejects a truncated account before reading out of bounds', () => {
        expect(() => decodeLbPairState(Buffer.alloc(100))).toThrow('too short');
    });
});
describe('decodeBinArrayBins', () => {
    it('validates the discriminator and maps index → bin ids', () => {
        const { index, bins } = decodeBinArrayBins(encodeBinArray(-8, [{ binId: -560, rawX: 1n, rawY: 2n, priceQ64: 3n }]));
        expect(index).toBe(-8);
        expect(bins).toHaveLength(BINS_PER_BIN_ARRAY);
        expect(bins[0]?.binId).toBe(-560); // -8 * 70 + 0
        expect(bins[69]?.binId).toBe(-491);
    });
    it('rejects a non-BinArray account', () => {
        const wrong = Buffer.alloc(56 + 70 * BIN_STRIDE);
        expect(() => decodeBinArrayBins(wrong)).toThrow('discriminator');
    });
    it('reads the Q64.64 price across the u128 boundary', () => {
        const data = Buffer.alloc(56 + BIN_STRIDE);
        BIN_ARRAY_DISCRIMINATOR.copy(data, 0);
        writeU128LE(data, 56 + 16, (1n << 64n) + 5n); // 1.000000000000000005
        const { bins } = decodeBinArrayBins(data);
        expect(bins[0]?.priceQ64).toBe((1n << 64n) + 5n);
        expect(readU128LE(data, 56 + 16)).toBe((1n << 64n) + 5n);
    });
});
describe('createRpcSolanaBinSource', () => {
    it('humanizes amounts and prices, filters to ±binsEachSide, and filters by memcmp @24', async () => {
        const port = portWith();
        const source = createRpcSolanaBinSource({ port, binsEachSide: 10 });
        const { bins, activeBinId } = await source.fetchBins('solana:5hbf9JP8k5zdrZp9pokPypFQoBse5mGCmW6nqodurGcd');
        expect(activeBinId).toBe(-604);
        // Array -9's span (-630..-561) fully covers the ±10 window, so every bin
        // -614..-594 comes back — zero-liquidity ones included, exactly like the
        // live mainnet response (21 bins there too). Array -8's -560 stays out.
        const ids = bins.map((bin) => bin.binId).sort((a, b) => a - b);
        expect(ids).toHaveLength(21);
        expect(ids[0]).toBe(-614);
        expect(ids.at(-1)).toBe(-594);
        expect(bins.some((bin) => bin.binId === -560)).toBe(false);
        const below = bins.find((bin) => bin.binId === -605);
        expect(below?.quoteAmount).toBeCloseTo(900, 6);
        const above = bins.find((bin) => bin.binId === -595);
        expect(above?.quoteAmount).toBeCloseTo(940, 6);
        expect(below?.quoteAmount).toBeCloseTo(900, 6); // 900_000000 / 10^6
        expect(below?.baseAmount).toBe(0);
        // Q64.64 price × 10^(decX − decY) = human quote-per-base
        expect(below?.price).toBeCloseTo(0.298657, 8);
        expect(above?.price).toBeCloseTo(0.3026, 8);
        // the memcmp filter used the verified lb_pair offset, not the folk 16
        expect(port.calls.some((call) => call.startsWith('gpa:') && call.includes(':24:'))).toBe(true);
    });
    it('throws when the pair account does not exist', async () => {
        const source = createRpcSolanaBinSource({
            port: portWith({ getAccountInfoBase64: async () => null })
        });
        await expect(source.fetchBins('solana:5hbf9JP8k5zdrZp9pokPypFQoBse5mGCmW6nqodurGcd')).rejects.toThrow('not found');
    });
    it('passes a bare base58 pool address through unchanged', async () => {
        const port = portWith();
        const source = createRpcSolanaBinSource({ port });
        await source.fetchBins('5hbf9JP8k5zdrZp9pokPypFQoBse5mGCmW6nqodurGcd');
        expect(port.calls[0]).toBe('info:5hbf9JP8k5zdrZp9pokPypFQoBse5mGCmW6nqodurGcd');
    });
});
//# sourceMappingURL=solana-bins.test.js.map