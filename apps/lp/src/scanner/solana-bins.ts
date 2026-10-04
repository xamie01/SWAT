import bs58 from 'bs58';
import type { MeteoraBin } from './active-tvl.js';
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

export const DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const BIN_ARRAY_DISCRIMINATOR = Buffer.from([92, 142, 92, 220, 5, 148, 70, 181]);
export const BINS_PER_BIN_ARRAY = 70;
export const BIN_STRIDE = 144;
const BIN_ARRAY_HEADER = 56;
const BIN_ARRAY_LB_PAIR_OFFSET = 24;
const LB_PAIR_ACTIVE_ID_OFFSET = 76;
const LB_PAIR_BIN_STEP_OFFSET = 80;
const LB_PAIR_TOKEN_X_MINT_OFFSET = 88;
const LB_PAIR_TOKEN_Y_MINT_OFFSET = 120;
const Q64 = 2n ** 64n;

export interface SolanaRpcBinPort {
  /** getAccountInfo, base64 data; null when the account does not exist. */
  getAccountInfoBase64(address: string): Promise<string | null>;
  /** getProgramAccounts with one memcmp filter, base64, full data. */
  getProgramAccountsMemcmp(programId: string, offset: number, bytesBase58: string): Promise<{ pubkey: string; dataBase64: string }[]>;
  /** SPL mint decimals. */
  getTokenDecimals(mint: string): Promise<number>;
}

/** Raw JSON-RPC over fetch, matching the indexer's heliusRpc pattern. */
export function createWeb3SolanaBinPort(rpcUrl: string): SolanaRpcBinPort {
  let nextId = 0;
  const rpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params })
    });
    if (!response.ok) {
      throw new Error(`Solana RPC ${method} returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { result?: T; error?: { message?: string } };
    if (payload.error) {
      throw new Error(`Solana RPC ${method} failed: ${payload.error.message ?? 'unknown'}`);
    }
    return payload.result as T;
  };

  return {
    async getAccountInfoBase64(address) {
      const result = await rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', [
        address,
        { encoding: 'base64' }
      ]);
      return result.value ? result.value.data[0] : null;
    },
    async getProgramAccountsMemcmp(programId, offset, bytesBase58) {
      const result = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>(
        'getProgramAccounts',
        [
          programId,
          {
            filters: [{ memcmp: { offset, bytes: bytesBase58 } }],
            encoding: 'base64'
          }
        ]
      );
      return result.map((entry) => ({ pubkey: entry.pubkey, dataBase64: entry.account.data[0] }));
    },
    async getTokenDecimals(mint) {
      const result = await rpc<{ value: { decimals: number } }>('getTokenSupply', [mint]);
      return result.value.decimals;
    }
  };
}

export function readU128LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset) + buffer.readBigUInt64LE(offset + 8) * 2n ** 64n;
}

/** Decoded pair state, raw units. */
export function decodeLbPairState(data: Buffer): {
  activeBinId: number;
  binStep: number;
  tokenXMint: string;
  tokenYMint: string;
} {
  if (data.length < LB_PAIR_TOKEN_Y_MINT_OFFSET + 32) {
    throw new Error(`LbPair account too short: ${data.length} bytes`);
  }
  return {
    activeBinId: data.readInt32LE(LB_PAIR_ACTIVE_ID_OFFSET),
    binStep: data.readUInt16LE(LB_PAIR_BIN_STEP_OFFSET),
    tokenXMint: bs58.encode(data.subarray(LB_PAIR_TOKEN_X_MINT_OFFSET, LB_PAIR_TOKEN_X_MINT_OFFSET + 32)),
    tokenYMint: bs58.encode(data.subarray(LB_PAIR_TOKEN_Y_MINT_OFFSET, LB_PAIR_TOKEN_Y_MINT_OFFSET + 32))
  };
}

export interface DecodedBin {
  readonly binId: number;
  readonly rawAmountX: bigint;
  readonly rawAmountY: bigint;
  readonly priceQ64: bigint;
}

export function decodeBinArrayBins(data: Buffer): { index: number; bins: DecodedBin[] } {
  if (data.length < BIN_ARRAY_HEADER) {
    throw new Error(`BinArray account too short: ${data.length} bytes`);
  }
  if (!data.subarray(0, 8).equals(BIN_ARRAY_DISCRIMINATOR)) {
    throw new Error('account is not a DLMM BinArray (discriminator mismatch)');
  }
  const index = Number(data.readBigInt64LE(8));
  const capacity = Math.min(BINS_PER_BIN_ARRAY, Math.floor((data.length - BIN_ARRAY_HEADER) / BIN_STRIDE));
  const bins: DecodedBin[] = [];
  for (let i = 0; i < capacity; i += 1) {
    const base = BIN_ARRAY_HEADER + i * BIN_STRIDE;
    bins.push({
      binId: index * BINS_PER_BIN_ARRAY + i,
      rawAmountX: data.readBigUInt64LE(base),
      rawAmountY: data.readBigUInt64LE(base + 8),
      priceQ64: readU128LE(data, base + 16)
    });
  }
  return { index, bins };
}

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
export function createRpcSolanaBinSource(options: RpcSolanaBinSourceOptions = {}): MeteoraBinSource {
  const port = options.port ?? createWeb3SolanaBinPort(options.rpcUrl ?? 'https://api.mainnet-beta.solana.com');
  const binsEachSide = options.binsEachSide ?? 10;

  return {
    async fetchBins(poolAddress) {
      const rawPool = poolAddress.startsWith('solana:') ? poolAddress.slice('solana:'.length) : poolAddress;

      const lbPairBase64 = await port.getAccountInfoBase64(rawPool);
      if (!lbPairBase64) {
        throw new Error(`DLMM pair ${rawPool} not found`);
      }
      const state = decodeLbPairState(Buffer.from(lbPairBase64, 'base64'));

      const arrays = await port.getProgramAccountsMemcmp(
        DLMM_PROGRAM_ID,
        BIN_ARRAY_LB_PAIR_OFFSET,
        rawPool // already base58 of the 32-byte pubkey; memcmp bytes accepts it directly
      );

      const [decX, decY] = await Promise.all([
        port.getTokenDecimals(state.tokenXMint),
        port.getTokenDecimals(state.tokenYMint)
      ]);
      const decimalAdjustment = 10 ** (decX - decY);

      const bins: MeteoraBin[] = [];
      for (const array of arrays) {
        const { bins: decoded } = decodeBinArrayBins(Buffer.from(array.dataBase64, 'base64'));
        for (const bin of decoded) {
          if (Math.abs(bin.binId - state.activeBinId) > binsEachSide) continue;
          bins.push({
            binId: bin.binId,
            price: (Number(bin.priceQ64) / Number(Q64)) * decimalAdjustment,
            baseAmount: Number(bin.rawAmountX) / 10 ** decX,
            quoteAmount: Number(bin.rawAmountY) / 10 ** decY
          });
        }
      }

      return { bins, activeBinId: state.activeBinId, binStep: state.binStep };
    }
  };
}
