/**
 * SWAT Wallet Starter Pack Discoverer
 * 
 * A standalone tool for new users to generate a customized, high-performance
 * "starter pack" of profitable Solana wallets.
 * 
 * Requirements:
 * - A Helius API Key in your local `.env` file (HELIUS_API_KEY=your_key)
 * - Node.js v20.6.0+ (for native --env-file support)
 * 
 * Usage:
 *   npx tsx --env-file=.env discover-starter-pack.ts
 */

import * as fs from 'fs';
import {
  clampInteger,
  collectSignaturesToOldest,
  createStarterPackScoreTracker,
  isValidSolanaAddress
} from '@swat/shared';

// ============================================================================
// ⚙️ CONFIGURATION SECTION (EDIT THESE VALUES TO ADJUST THE SEARCH)
// ============================================================================

const CONFIG = {
  // 1. Search Queries: Exposes 30 highly queried Solana names/narratives.
  // Add or remove keywords here to change what DexScreener searches for.
  SEARCH_KEYWORDS: [
    // Base & Infrastructure
    'pump', 'solana', 'sol', 'raydium',
    // Major Narratives (AI, DePIN, RWA)
    'ai', 'agent', 'gpt', 'depin', 'rwa', 'ai16z', 'eliza', 'goat', 'act',
    // PolitiFi / Culture
    'trump', 'usa', 'biden',
    // Iconic Memecoins / Animals
    'wif', 'bonk', 'popcat', 'pengu', 'giga', 'mew', 'bome', 'slerf', 'pepe', 'doge', 'shib', 'pnut', 'moodeng'
  ],

  // 2. Token Selection limits
  TARGET_TOKEN_COUNT: 8,       // How many high-volume tokens to analyze in total
  TOKEN_MAX_AGE_DAYS: 30,      // Max age of the token (ignores tokens older than this)
  DEX_CHAIN_ID: process.env.DEX_CHAIN_ID ?? 'solana', // e.g. 'solana' | 'robinhood-chain'

  // 3. Scan limits per token (Higher values gather more data but use more RPC requests)
  LAUNCH_WINDOW_TXS: clampInteger(process.env.STARTER_LAUNCH_WINDOW_TXS, 50, 1, 1000),
  LAUNCH_SIGNATURE_CAP: clampInteger(
    process.env.STARTER_LAUNCH_SIGNATURE_CAP,
    20_000,
    1000,
    100_000
  ),
  MAX_SNIPERS_TO_TRACE: 15,    // How many early snipers to trace funding sources for
  SNIPER_TRACE_DEPTH: 8,       // How many snipers to deep-trace buy/sell history for (Pattern 1 & 3)

  // 4. Trace depth per wallet
  WALLET_SIGNATURE_LIMIT: clampInteger(
    process.env.STARTER_WALLET_SIGNATURE_LIMIT,
    30,
    1,
    1000
  ),
  FUNDER_SIGNATURE_CAP: clampInteger(
    process.env.STARTER_FUNDER_SIGNATURE_CAP,
    5000,
    1000,
    100_000
  ),
  FUNDER_TX_SCAN_LIMIT: clampInteger(
    process.env.STARTER_FUNDER_TX_SCAN_LIMIT,
    50,
    1,
    1000
  ),

  // 5. Pattern thresholds
  MIN_SCALE_OUT_ROI: 1.5,      // Minimum return multiplier to qualify as a Scale-Out win (1.5 = 1.5x)
};

// ============================================================================
// 🛠️ IMPLEMENTATION (RUNS UNDER THE HOOD)
// ============================================================================

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_API_KEY || HELIUS_API_KEY === '') {
  console.error('\n❌ ERROR: HELIUS_API_KEY is not set in your .env file.');
  console.error('Please create a .env file and add: HELIUS_API_KEY=your_helius_key\n');
  process.exit(1);
}

const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzGfpg1b6955vabT2crbV635C6JHfjCoRPpL56';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const KNOWN_PROGRAM_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  PUMP_FUN_PROGRAM,
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'
]);

if (CONFIG.DEX_CHAIN_ID !== 'solana') {
  throw new Error(
    `discover-starter-pack.ts uses Helius and supports only solana; received DEX_CHAIN_ID=${CONFIG.DEX_CHAIN_ID}`
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type HeliusSignature = {
  signature: string;
  blockTime?: number | null;
};

type TokenBalance = {
  mint?: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
  };
};

type AnalyzedTrade = {
  direction: 'buy' | 'sell';
  sol: number;
  isPumpFun: boolean;
};

// Robust Helius client with automatic backoff for 429 rate limits
async function heliusRpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params })
      });
      
      if (response.status === 429) {
        const wait = 1000 * Math.pow(2, attempt);
        console.log(`     ⚠️  Rate limit (429) hit. Retrying in ${wait}ms...`);
        await sleep(wait);
        continue;
      }
      
      if (!response.ok) throw new Error(`Status ${response.status}`);
      const json = (await response.json()) as any;
      if (json.error) throw new Error(json.error.message);
      return json.result as T;
    } catch (e: any) {
      if (attempt === 4) throw new Error(`Helius RPC error: ${e.message}`);
      const wait = 1000 * Math.pow(2, attempt);
      await sleep(wait);
    }
  }
  throw new Error('Helius RPC request failed');
}

async function getSignatureHistory(address: string, maxTotal: number) {
  return collectSignaturesToOldest<HeliusSignature>(
    ({ before, limit }) =>
      heliusRpc<HeliusSignature[]>('getSignaturesForAddress', [
        address,
        before ? { limit, before } : { limit }
      ]),
    { maxTotal, pageSize: 1000 }
  );
}

// Find early funding source (parent wallet)
async function getFunderAddress(address: string): Promise<string | null> {
  try {
    const history = await getSignatureHistory(address, CONFIG.FUNDER_SIGNATURE_CAP);
    if (!history.reachedOldest) {
      console.warn(
        `     Funding history cap reached for ${address}; skipping unverified funder.`
      );
      return null;
    }

    const oldest = [...history.signatures]
      .reverse()
      .slice(0, CONFIG.FUNDER_TX_SCAN_LIMIT);

    for (const signature of oldest) {
      const tx = await heliusRpc<any>('getTransaction', [
        signature.signature,
        { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' }
      ]).catch(() => null);
      if (!tx) continue;

      const instructions = tx.transaction?.message?.instructions ?? [];
      const innerInstructions = (tx.meta?.innerInstructions ?? [])
        .flatMap((item: any) => item.instructions ?? []);

      for (const ix of [...instructions, ...innerInstructions]) {
        if (ix.programId === SYSTEM_PROGRAM_ID && ix.parsed?.type === 'transfer') {
          const info = ix.parsed.info;
          if (
            info.destination === address &&
            info.source !== address &&
            isValidSolanaAddress(info.source) &&
            !KNOWN_PROGRAM_IDS.has(info.source)
          ) {
            return info.source;
          }
        }
      }
    }
  } catch (error) {
    console.warn(`     Failed to resolve funder for ${address}:`, error);
  }
  return null;
}

// Get recent high-volume tokens from DexScreener
async function getRecentHighVolumeTokens() {
  console.log(`📡 Fetching trending Solana pairs from DexScreener using ${CONFIG.SEARCH_KEYWORDS.length} keywords...`);
  const tokens = new Map<string, {
    address: string;
    symbol: string;
    name: string;
    volume: number;
    pairCreatedAt: number;
    poolAddresses: Set<string>;
  }>();
  const ageLimitMs = CONFIG.TOKEN_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const cutoffTime = Date.now() - ageLimitMs;

  for (const q of CONFIG.SEARCH_KEYWORDS) {
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${q}`);
      if (!res.ok) continue;
      const data = await res.json() as any;
      const pairs = data.pairs || [];
      for (const p of pairs) {
        if (p.chainId !== CONFIG.DEX_CHAIN_ID) continue;
        const pairCreatedAt = Number(p.pairCreatedAt);
        if (!Number.isFinite(pairCreatedAt) || pairCreatedAt <= 0) continue;
        if (pairCreatedAt < cutoffTime) continue;
        const base = p.baseToken;
        if (!base?.address) continue;
        if (base.address === SOL_MINT || base.address === USDC_MINT || base.address === USDT_MINT) continue;
        
        const vol = p.volume?.h24 ?? 0;
        const existing = tokens.get(base.address);
        if (!existing) {
          tokens.set(base.address, {
            address: base.address,
            symbol: base.symbol,
            name: base.name,
            volume: vol,
            pairCreatedAt,
            poolAddresses: new Set(p.pairAddress ? [p.pairAddress] : [])
          });
        } else {
          existing.pairCreatedAt = Math.min(existing.pairCreatedAt, pairCreatedAt);
          if (p.pairAddress) existing.poolAddresses.add(p.pairAddress);
          if (vol > existing.volume) {
            existing.symbol = base.symbol;
            existing.name = base.name;
            existing.volume = vol;
          }
        }
      }
      await sleep(100); // polite rate limit spacing for DexScreener
    } catch {}
  }
  
  return Array.from(tokens.values())
    .sort((a, b) => b.volume - a.volume)
    .slice(0, CONFIG.TARGET_TOKEN_COUNT);
}

function getSignerAddresses(tx: any): Set<string> {
  const accountKeys = tx.transaction?.message?.accountKeys ?? [];
  const signers = new Set<string>();

  accountKeys.forEach((key: any, index: number) => {
    const address = typeof key === 'string' ? key : key.pubkey;
    if (!address) return;
    if (key.signer === true || index === 0) signers.add(address);
  });

  return signers;
}

function getInstructionProgramIds(tx: any): Set<string> {
  const instructions = tx.transaction?.message?.instructions ?? [];
  const innerInstructions = (tx.meta?.innerInstructions ?? [])
    .flatMap((item: any) => item.instructions ?? []);
  return new Set(
    [...instructions, ...innerInstructions]
      .map((instruction: any) => instruction.programId)
      .filter((programId: unknown): programId is string => typeof programId === 'string')
  );
}

function isCandidateBuyer(
  owner: string,
  mint: string,
  tx: any,
  poolAddresses: Set<string>
): boolean {
  if (!isValidSolanaAddress(owner)) return false;
  if (owner === mint || poolAddresses.has(owner)) return false;
  if (KNOWN_PROGRAM_IDS.has(owner)) return false;
  if (getInstructionProgramIds(tx).has(owner)) return false;
  return getSignerAddresses(tx).has(owner);
}

async function discover() {
  console.log('============================================================');
  console.log('🚀 SWAT STARTER PACK GENERATOR (FLEXIBLE CONFIG EDITION)');
  console.log('============================================================');
  
  const tokens = await getRecentHighVolumeTokens();
  console.log(`\nFound ${tokens.length} high-volume target tokens:`);
  console.table(tokens.map(t => ({ Symbol: t.symbol, Name: t.name, 'Volume (24h)': `$${t.volume.toLocaleString()}`, Mint: t.address })));

  const scoreTracker = createStarterPackScoreTracker();

  for (const token of tokens) {
    console.log(`\n🔍 Analysing token: ${token.symbol} (${token.name})`);
    
    try {
      // Walk to the account origin before choosing the launch window. A capped
      // newest-only sample cannot prove when the token actually launched.
      const history = await getSignatureHistory(
        token.address,
        CONFIG.LAUNCH_SIGNATURE_CAP
      );
      if (history.signatures.length === 0) continue;
      if (!history.reachedOldest) {
        console.warn(
          `  Skipped ${token.symbol}: launch history cap reached before account origin.`
        );
        continue;
      }

      const launchSigs = [...history.signatures]
        .reverse()
        .filter((signature) => Number.isFinite(signature.blockTime))
        .slice(0, CONFIG.LAUNCH_WINDOW_TXS);
      if (launchSigs.length === 0) continue;
      const BATCH = 5;

      const launchTxs = [];
      for (let i = 0; i < launchSigs.length; i += BATCH) {
        const batch = launchSigs.slice(i, i + BATCH);
        const details = await Promise.all(
          batch.map(s => 
            heliusRpc<any>('getTransaction', [
              s.signature,
              { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' }
            ]).catch(() => null)
          )
        );
        launchTxs.push(...details.filter(Boolean));
        await sleep(150);
      }

      // Isolate early buyers
      const earlyBuyers = new Set<string>();
      for (const tx of launchTxs) {
        const post = (tx.meta?.postTokenBalances ?? []) as TokenBalance[];
        const pre = (tx.meta?.preTokenBalances ?? []) as TokenBalance[];
        for (const item of post) {
          if (
            item.mint === token.address &&
            item.owner &&
            isCandidateBuyer(item.owner, token.address, tx, token.poolAddresses)
          ) {
            const preBal = pre.find(
              (balance) =>
                balance.owner === item.owner && balance.mint === token.address
            );
            if (BigInt(item.uiTokenAmount?.amount ?? '0') > BigInt(preBal?.uiTokenAmount?.amount ?? '0')) {
              earlyBuyers.add(item.owner);
            }
          }
        }
      }

      const snipers = Array.from(earlyBuyers).slice(0, CONFIG.MAX_SNIPERS_TO_TRACE);
      
      // Pattern 2: Stealth Multi-Wallet Parent
      const fundingSources = new Map<string, string[]>();
      for (const sniper of snipers.slice(0, CONFIG.MAX_SNIPERS_TO_TRACE)) {
        const funder = await getFunderAddress(sniper);
        if (funder && funder !== sniper && funder !== SYSTEM_PROGRAM_ID) {
          const targets = fundingSources.get(funder) || [];
          targets.push(sniper);
          fundingSources.set(funder, targets);
        }
        await sleep(100);
      }

      for (const [funder, targets] of fundingSources.entries()) {
        if (targets.length >= 2) {
          console.log(`     🔥 Pattern matched: Stealth Multi-Wallet Parent -> ${funder}`);
          scoreTracker.recordPattern(funder, 'Stealth Parent', token.address);
        }
      }

      // Pattern 1 & 3: Scale-Out Snipers & Graduates
      for (const sniper of snipers.slice(0, CONFIG.SNIPER_TRACE_DEPTH)) {
        try {
          const walletSigs = await heliusRpc<any[]>('getSignaturesForAddress', [sniper, { limit: CONFIG.WALLET_SIGNATURE_LIMIT }]);
          if (walletSigs.length === 0) continue;
          
          const details = [];
          for (let i = 0; i < walletSigs.length; i += BATCH) {
            const batch = walletSigs.slice(i, i + BATCH);
            const txs = await Promise.all(
              batch.map(s => 
                heliusRpc<any>('getTransaction', [
                  s.signature,
                  { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' }
                ]).catch(() => null)
              )
            );
            details.push(...txs.filter(Boolean));
            await sleep(150);
          }

          const trades: AnalyzedTrade[] = [];
          for (const tx of details) {
            const pre = (tx.meta?.preTokenBalances ?? []) as TokenBalance[];
            const post = (tx.meta?.postTokenBalances ?? []) as TokenBalance[];
            const preBal = pre.find(
              (balance) =>
                balance.owner === sniper && balance.mint === token.address
            );
            const postBal = post.find(
              (balance) =>
                balance.owner === sniper && balance.mint === token.address
            );
            
            const delta = BigInt(postBal?.uiTokenAmount?.amount ?? '0') - BigInt(preBal?.uiTokenAmount?.amount ?? '0');
            if (delta === 0n) continue;

            const accountKeys = tx.transaction?.message?.accountKeys ?? [];
            const walletIdx = accountKeys.findIndex((k: any) => (typeof k === 'string' ? k : k.pubkey) === sniper);
            let solValue = 0;
            if (walletIdx >= 0 && tx.meta?.preBalances && tx.meta?.postBalances) {
              solValue = Math.abs(tx.meta.postBalances[walletIdx] - tx.meta.preBalances[walletIdx]) / 1e9;
            }

            trades.push({
              direction: delta > 0n ? 'buy' : 'sell',
              sol: solValue,
              isPumpFun: tx.transaction?.message?.instructions?.some((i: any) => i.programId === PUMP_FUN_PROGRAM)
            });
          }

          const buys = trades.filter(t => t.direction === 'buy');
          const sells = trades.filter(t => t.direction === 'sell');

          if (buys.length > 0 && sells.length > 0) {
            const cost = buys.reduce((a, c) => a + c.sol, 0);
            const returns = sells.reduce((a, c) => a + c.sol, 0);
            if (cost > 0) {
              scoreTracker.recordTradeOutcome(
                sniper,
                token.address,
                returns > cost
              );
            }
          }

          // Pattern 1: Scale-Out
          if (buys.length > 0 && sells.length >= 2) {
            const cost = buys.reduce((a, c) => a + c.sol, 0);
            const returns = sells.reduce((a, c) => a + c.sol, 0);
            if (cost > 0 && returns > cost * CONFIG.MIN_SCALE_OUT_ROI) {
              console.log(`     🔥 Pattern matched: Scale-Out Sniper -> ${sniper} (${(returns/cost).toFixed(1)}x)`);
              scoreTracker.recordPattern(sniper, 'Scale-Out Sniper', token.address);
            }
          }

          // Pattern 3: Bonding-Curve Graduate
          const buyOnPump = buys.some(b => b.isPumpFun);
          const sellOnRaydium = sells.some(s => !s.isPumpFun);
          if (buyOnPump && sellOnRaydium) {
            console.log(`     🔥 Pattern matched: Bonding-Curve Graduate -> ${sniper}`);
            scoreTracker.recordPattern(
              sniper,
              'Bonding-Curve Graduate',
              token.address
            );
          }

        } catch (error) {
          console.warn(`     Failed to trace sniper ${sniper}:`, error);
        }
      }

    } catch (e: any) {
      console.error(`  Skipped token: ${e.message}`);
    }
  }

  // Compile and sort by repeatability (score) first, then win rate
  const starterPack = scoreTracker.results()
    .sort((a, b) => {
      const winRateA = a.winRate ?? -1;
      const winRateB = b.winRate ?? -1;
      return b.score - a.score || winRateB - winRateA;
    });

  console.log('\n============================================================');
  console.log('🏆 WALLET STARTER PACK CURATED');
  console.log('============================================================');
  
  if (starterPack.length === 0) {
    console.log('No wallets matched the sniper patterns on these tokens.');
  } else {
    console.table(starterPack.map(w => ({
      Address: w.address,
      Patterns: w.patterns.join(', '),
      'Win Rate': w.winRate === null ? 'N/A' : `${w.winRate}%`,
      'Pattern Matches (Repeatability)': w.score
    })));

    // Save output
    const jsonOutput = JSON.stringify(starterPack.map(w => w.address), null, 2);
    fs.writeFileSync('wallet-starter-pack.json', jsonOutput);
    console.log('\n💾 Curated starter pack saved to `wallet-starter-pack.json`');
  }
}

discover().catch(console.error);
