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
  LAUNCH_WINDOW_TXS: 50,       // How many transactions to scan from the token's block launch
  MAX_SNIPERS_TO_TRACE: 15,    // How many early snipers to trace funding sources for
  SNIPER_TRACE_DEPTH: 8,       // How many snipers to deep-trace buy/sell history for (Pattern 1 & 3)

  // 4. Trace depth per wallet
  WALLET_SIGNATURE_LIMIT: 30,  // How many transactions to fetch per sniper to audit their trades

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// Find early funding source (parent wallet)
async function getFunderAddress(address: string): Promise<string | null> {
  try {
    const txs = await heliusRpc<any[]>('getSignaturesForAddress', [address, { limit: 10 }]);
    if (txs.length === 0) return null;
    txs.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
    
    const tx = await heliusRpc<any>('getTransaction', [
      txs[0].signature,
      { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'jsonParsed' }
    ]);
    if (!tx) return null;

    const instructions = tx.transaction?.message?.instructions ?? [];
    const innerInstructions = (tx.meta?.innerInstructions ?? []).flatMap((i: any) => i.instructions ?? []);
    const allInstructions = [...instructions, ...innerInstructions];

    for (const ix of allInstructions) {
      if (ix.programId === SYSTEM_PROGRAM_ID && ix.parsed?.type === 'transfer') {
        const info = ix.parsed.info;
        if (info.destination === address && info.source !== address) {
          return info.source;
        }
      }
    }
  } catch {}
  return null;
}

// Get recent high-volume tokens from DexScreener
async function getRecentHighVolumeTokens() {
  console.log(`📡 Fetching trending Solana pairs from DexScreener using ${CONFIG.SEARCH_KEYWORDS.length} keywords...`);
  const tokens = new Map<string, { address: string; symbol: string; name: string; volume: number }>();
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
        if (p.pairCreatedAt && p.pairCreatedAt < cutoffTime) continue;
        const base = p.baseToken;
        if (!base?.address) continue;
        if (base.address === SOL_MINT || base.address === USDC_MINT || base.address === USDT_MINT) continue;
        
        const vol = p.volume?.h24 ?? 0;
        const existing = tokens.get(base.address);
        if (!existing || vol > existing.volume) {
          tokens.set(base.address, {
            address: base.address,
            symbol: base.symbol,
            name: base.name,
            volume: vol
          });
        }
      }
      await sleep(100); // polite rate limit spacing for DexScreener
    } catch {}
  }
  
  return Array.from(tokens.values())
    .sort((a, b) => b.volume - a.volume)
    .slice(0, CONFIG.TARGET_TOKEN_COUNT);
}

async function discover() {
  console.log('============================================================');
  console.log('🚀 SWAT STARTER PACK GENERATOR (FLEXIBLE CONFIG EDITION)');
  console.log('============================================================');
  
  const tokens = await getRecentHighVolumeTokens();
  console.log(`\nFound ${tokens.length} high-volume target tokens:`);
  console.table(tokens.map(t => ({ Symbol: t.symbol, Name: t.name, 'Volume (24h)': `$${t.volume.toLocaleString()}`, Mint: t.address })));

  const scoredWallets = new Map<string, {
    address: string;
    patterns: string[];
    successfulTrades: number;
    totalTrades: number;
    winRate: number;
    score: number;
  }>();

  function trackPatternMatch(address: string, pattern: string, isWin = true) {
    const cur = scoredWallets.get(address) || {
      address,
      patterns: [],
      successfulTrades: 0,
      totalTrades: 0,
      winRate: 0,
      score: 0
    };
    
    if (!cur.patterns.includes(pattern)) {
      cur.patterns.push(pattern);
    }
    cur.totalTrades++;
    if (isWin) cur.successfulTrades++;
    cur.winRate = Math.round((cur.successfulTrades / cur.totalTrades) * 100);
    cur.score = cur.totalTrades;
    scoredWallets.set(address, cur);
  }

  for (const token of tokens) {
    console.log(`\n🔍 Analysing token: ${token.symbol} (${token.name})`);
    
    try {
      // Fetch launch transactions
      const sigs = await heliusRpc<any[]>('getSignaturesForAddress', [token.address, { limit: 1000 }]);
      if (sigs.length === 0) continue;
      sigs.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
      
      const launchSigs = sigs.slice(0, CONFIG.LAUNCH_WINDOW_TXS);
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
        const post = tx.meta?.postTokenBalances ?? [];
        const pre = tx.meta?.preTokenBalances ?? [];
        for (const item of post) {
          if (item.mint === token.address && item.owner && item.owner !== SYSTEM_PROGRAM_ID) {
            const preBal = pre.find(b => b.owner === item.owner && b.mint === token.address);
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
          trackPatternMatch(funder, 'Stealth Parent');
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

          const trades = [];
          for (const tx of details) {
            const pre = tx.meta?.preTokenBalances ?? [];
            const post = tx.meta?.postTokenBalances ?? [];
            const preBal = pre.find(b => b.owner === sniper && b.mint === token.address);
            const postBal = post.find(b => b.owner === sniper && b.mint === token.address);
            
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

          // Pattern 1: Scale-Out
          if (buys.length > 0 && sells.length >= 2) {
            const cost = buys.reduce((a, c) => a + c.sol, 0);
            const returns = sells.reduce((a, c) => a + c.sol, 0);
            if (returns > cost * CONFIG.MIN_SCALE_OUT_ROI) {
              console.log(`     🔥 Pattern matched: Scale-Out Sniper -> ${sniper} (${(returns/cost).toFixed(1)}x)`);
              trackPatternMatch(sniper, 'Scale-Out Sniper');
            }
          }

          // Pattern 3: Bonding-Curve Graduate
          const buyOnPump = buys.some(b => b.isPumpFun);
          const sellOnRaydium = sells.some(s => !s.isPumpFun);
          if (buyOnPump && sellOnRaydium) {
            console.log(`     🔥 Pattern matched: Bonding-Curve Graduate -> ${sniper}`);
            trackPatternMatch(sniper, 'Bonding-Curve Graduate');
          }

        } catch {}
      }

    } catch (e: any) {
      console.error(`  Skipped token: ${e.message}`);
    }
  }

  // Compile and sort by repeatability (score) first, then win rate
  const starterPack = Array.from(scoredWallets.values())
    .sort((a, b) => b.score - a.score || b.winRate - a.winRate);

  console.log('\n============================================================');
  console.log('🏆 WALLET STARTER PACK CURATED');
  console.log('============================================================');
  
  if (starterPack.length === 0) {
    console.log('No wallets matched the sniper patterns on these tokens.');
  } else {
    console.table(starterPack.map(w => ({
      Address: w.address,
      Patterns: w.patterns.join(', '),
      'Win Rate': `${w.winRate}%`,
      'Pattern Matches (Repeatability)': w.score
    })));

    // Save output
    const jsonOutput = JSON.stringify(starterPack.map(w => w.address), null, 2);
    fs.writeFileSync('wallet-starter-pack.json', jsonOutput);
    console.log('\n💾 Curated starter pack saved to `wallet-starter-pack.json`');
  }
}

discover().catch(console.error);
