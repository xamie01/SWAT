import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import {
  decodeRaydiumPoolState,
  createRaydiumClmmPoolFetcher,
  type RaydiumRpcPort
} from './raydium-clmm.js';

function buildMockRaydiumBuffer(): Buffer {
  const buf = Buffer.alloc(300);

  // Discriminator (0..8)
  buf.set([1, 2, 3, 4, 5, 6, 7, 8], 0);

  // Mint0 Pubkey at offset 73 (32 bytes)
  const mint0Bytes = Buffer.alloc(32, 1);
  mint0Bytes.copy(buf, 73);

  // Mint1 Pubkey at offset 105 (32 bytes)
  const mint1Bytes = Buffer.alloc(32, 2);
  mint1Bytes.copy(buf, 105);

  // Mint0 decimals at 233
  buf.writeUInt8(9, 233); // e.g. SOL (9 decimals)

  // Mint1 decimals at 234
  buf.writeUInt8(6, 234); // e.g. USDC (6 decimals)

  // Tick spacing at 235 (u16 LE)
  buf.writeUInt16LE(10, 235);

  // Liquidity at 237 (u128 LE)
  buf.writeBigUInt64LE(50000n, 237);
  buf.writeBigUInt64LE(0n, 245);

  // SqrtPriceX64 at 253 (u128 LE)
  // For price 1: sqrtPriceX64 = 2^64 (low 64 bits = 0, high 64 bits = 1)
  buf.writeBigUInt64LE(0n, 253);
  buf.writeBigUInt64LE(1n, 261);

  // TickCurrent at 269 (i32 LE)
  buf.writeInt32LE(0, 269);

  // FeeRate at 277 (u32 LE)
  buf.writeUInt32LE(2500, 277); // 25 bps

  return buf;
}

describe('decodeRaydiumPoolState', () => {
  it('decodes pool state offsets accurately', () => {
    const buffer = buildMockRaydiumBuffer();
    const state = decodeRaydiumPoolState('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', buffer);

    expect(state.mint0Decimals).toBe(9);
    expect(state.mint1Decimals).toBe(6);
    expect(state.tickSpacing).toBe(10);
    expect(state.tickCurrent).toBe(0);
    expect(state.feeRate).toBe(2500);
    expect(state.liquidity).toBe(50000n);
    expect(state.sqrtPriceX64).toBe(2n ** 64n);
  });

  it('throws on truncated buffer', () => {
    expect(() => decodeRaydiumPoolState('test', Buffer.alloc(100))).toThrow(/too short/);
  });
});

describe('createRaydiumClmmPoolFetcher', () => {
  it('fetches and normalizes a Raydium CLMM pool on Solana', async () => {
    const buffer = buildMockRaydiumBuffer();
    const rpcPort: RaydiumRpcPort = {
      getAccountInfoBase64: async () => buffer.toString('base64')
    };

    const fetcher = createRaydiumClmmPoolFetcher({
      rpcPort,
      configuredPools: ['solana:3ucNos4J5sZqm1NiaKz1g9yUqA6K9qT3n3k4nJ7k8h9v'],
      priceSource: {
        priceUsd: async () => 180 // SOL price
      }
    });

    expect(fetcher.chain).toBe('solana');
    expect(fetcher.protocol).toBe('raydium-clmm');

    const pools = await fetcher.fetch();
    expect(pools).toHaveLength(1);
    expect(pools[0]!.chain).toBe('solana');
    expect(pools[0]!.protocol).toBe('raydium-clmm');
    expect(pools[0]!.poolAddress).toBe('solana:3ucNos4J5sZqm1NiaKz1g9yUqA6K9qT3n3k4nJ7k8h9v');
    expect(pools[0]!.feeBps).toBe(25);
    expect(pools[0]!.tickSpacing).toBe(10);
  });
});
