import type { MeteoraBinSource } from './meteora-pools.js';
/**
 * The live Solana bin source (Track I1) — reads DLMM bin liquidity straight
 * from RPC, with no SDK. `@meteora-ag/dlmm@1.9.14` cannot be imported in this
 * environment (broken ESM re-exports, CJS build missing the DLMM class), so
 * this module speaks the program's wire format directly. Every offset below
 * was verified byte-by-byte against mainnet (layout source:
 * `idls/dlmm.json` from MeteoraAg/dlmm-sdk).
 *
 * Layouts (all little-endian):
 *
 *   LbPair (borsh):
 *     0..8     anchor discriminator
 *     8..40    StaticParameters (32 bytes)
 *     40..72   VariableParameters (32 bytes)
 *     72       bump_seed u8
 *     73..75   bin_step_seed [u8;2]
 *     75       pair_type u8
 *     76..80   active_id i32            ← read
 *     80..82   bin_step u16             ← read
 *     82..88   status, require_base_factor_seed, base_factor_seed, activation,
 *              creator_pool_on_off_control
 *     88..120  token_x_mint pubkey      ← read
 *     120..152 token_y_mint pubkey      ← read
 *
 *   BinArray (zero-copy, C repr):
 *     0..8     discriminator [92,142,92,220,5,148,70,181]
 *     8..16    index i64                ← read (array covers index*70 … index*70+69)
 *     16..24   version u8 + padding
 *     24..56   lb_pair pubkey           ← memcmp filter offset (24, not 16 —
 *                                          verified: 16 returns zero accounts)
 *     56..     Bin[70], stride 144:
 *                +0   amount_x u64      ← read (raw, smallest unit)
 *                +8   amount_y u64      ← read
 *                +16  price u128, Q64.64 per-lamport  ← read
 */
export declare const DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export declare const BINS_PER_BIN_ARRAY = 70;
export declare const BIN_STRIDE = 144;
export interface SolanaRpcBinPort {
    /** getAccountInfo, base64 data; null when the account does not exist. */
    getAccountInfoBase64(address: string): Promise<string | null>;
    /** getProgramAccounts with one memcmp filter, base64, full data. */
    getProgramAccountsMemcmp(programId: string, offset: number, bytesBase58: string): Promise<{
        pubkey: string;
        dataBase64: string;
    }[]>;
    /** SPL mint decimals. */
    getTokenDecimals(mint: string): Promise<number>;
}
/** Raw JSON-RPC over fetch, matching the indexer's heliusRpc pattern. */
export declare function createWeb3SolanaBinPort(rpcUrl: string): SolanaRpcBinPort;
export declare function readU128LE(buffer: Buffer, offset: number): bigint;
/** Decoded pair state, raw units. */
export declare function decodeLbPairState(data: Buffer): {
    activeBinId: number;
    binStep: number;
    tokenXMint: string;
    tokenYMint: string;
};
export interface DecodedBin {
    readonly binId: number;
    readonly rawAmountX: bigint;
    readonly rawAmountY: bigint;
    readonly priceQ64: bigint;
}
export declare function decodeBinArrayBins(data: Buffer): {
    index: number;
    bins: DecodedBin[];
};
export interface RpcSolanaBinSourceOptions {
    readonly rpcUrl?: string;
    readonly port?: SolanaRpcBinPort;
    /** Bins each side of the active bin to return. */
    readonly binsEachSide?: number;
}
/**
 * The MeteoraBinSource the scanner and the live preview consume. Returns
 * human-scale amounts and quote-per-base prices — the on-chain Q64.64
 * per-lamport price with the decimals adjustment `× 10^(decX − decY)`
 * (verified on mainnet: MET/USDC, both 6 decimals, price 0.299 matches the
 * implied (1+binStep/10000)^activeId).
 */
export declare function createRpcSolanaBinSource(options?: RpcSolanaBinSourceOptions): MeteoraBinSource;
//# sourceMappingURL=solana-bins.d.ts.map