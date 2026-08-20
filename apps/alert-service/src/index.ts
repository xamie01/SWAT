import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import {
  completeIngestionHealthAlert,
  getIngestionHealth24h,
  query,
  releaseIngestionHealthAlert,
  reserveIngestionHealthAlert
} from '@swat/db';
import { clampInteger, initLogger, QUEUES, REDIS_CHANNELS } from '@swat/shared';
import { createRedisAlertBridge } from './alert-bridge.js';
import { deliverQueuedAlert } from './alert-delivery.js';
import type { SignalAlertPayload } from './alert-payload.js';
import { checkIngestionHealth } from './ingestion-health.js';

initLogger('alert-service');

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const bridgeRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });
const alertQueue = new Queue(QUEUES.alerts, { connection: bridgeRedis });
redis.on('error', (error) => console.error('[alert-service] worker Redis error', error));
bridgeRedis.on('error', (error) => console.error('[alert-service] bridge Redis error', error));
alertQueue.on('error', (error) => console.error('[alert-service] alert queue error', error));
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(message: string, maxRetries = 3) {
  if (!telegramToken || !telegramChatId) {
    throw new Error('Telegram is not configured for alert delivery');
  }

  // Enforce Telegram message limit (4096 characters)
  const text = message.length > 4096 ? message.slice(0, 4093) + '...' : message;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        parse_mode: 'HTML'
      })
    });

    if (response.ok) return;

    if (response.status === 429) {
      const data = await response.json().catch(() => ({}));
      const retryAfter = data?.parameters?.retry_after ?? 5;
      console.warn(`[alert-service] Telegram rate limited. Retrying after ${retryAfter}s...`);
      if (attempt === maxRetries) {
        throw new Error('Telegram rate limit exceeded after max retries');
      }
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      continue;
    }

    throw new Error(`Telegram error: ${response.status}`);
  }
}

async function sendIngestionHealthTelegram(message: string) {
  if (!telegramToken || !telegramChatId) {
    throw new Error('Telegram is not configured for ingestion-health alerts');
  }
  await sendTelegram(message);
}

async function sendOperationalTelegram(message: string) {
  if (!telegramToken || !telegramChatId) {
    throw new Error('Telegram is not configured for system and expectancy alerts');
  }
  await sendTelegram(message);
}

const ingestionHealthPollMs = clampInteger(
  process.env.INGESTION_HEALTH_POLL_MS,
  60_000,
  10_000,
  15 * 60_000
);
let ingestionHealthCheckRunning = false;

async function pollIngestionHealth() {
  if (ingestionHealthCheckRunning) return;
  ingestionHealthCheckRunning = true;
  try {
    await checkIngestionHealth({
      loadHealth: getIngestionHealth24h,
      reserve: reserveIngestionHealthAlert,
      complete: completeIngestionHealthAlert,
      release: releaseIngestionHealthAlert,
      send: sendIngestionHealthTelegram,
      logError: (message, error) => console.error(message, error)
    });
  } catch (error) {
    console.error('[alert-service] ingestion health poll failed', error);
  } finally {
    ingestionHealthCheckRunning = false;
  }
}

void pollIngestionHealth();
const ingestionHealthTimer = setInterval(
  () => void pollIngestionHealth(),
  ingestionHealthPollMs
);
ingestionHealthTimer.unref();

// ─── Token metadata helper ────────────────────────────────────────────────────

async function getTokenMeta(mint: string) {
  const rows = await query<{ symbol: string | null; name: string | null }>(
    `SELECT symbol, name FROM tokens WHERE mint = $1`, [mint]
  );
  return rows[0] ?? { symbol: null, name: null };
}

async function getPolymarketMarketDetails(mint: string) {
  const rows = await query<{
    question: string | null;
    outcome_count: number | null;
    outcome_name: string | null;
  }>(`
    SELECT m.question, m.outcome_count, o.outcome AS outcome_name
    FROM polymarket_outcomes o
    JOIN polymarket_markets m ON o.condition_id = m.condition_id
    WHERE o.token_id = $1
      AND m.context_complete = TRUE
  `, [mint]);
  return rows[0] ?? null;
}

async function getClusterMeta(clusterId: string) {
  const rows = await query<{
    name: string | null;
    confidence: number;
    total_realized_roi: number | null;
    avg_composite_score: number | null;
    wallet_count: number;
  }>(`SELECT name, confidence, total_realized_roi, avg_composite_score, wallet_count
      FROM wallet_clusters WHERE id = $1`, [clusterId]);
  return rows[0] ?? null;
}

// ─── Alert Formatter ─────────────────────────────────────────────────────────

function formatSafe(val: boolean | undefined): string {
  if (val === undefined) return '❓ Unknown';
  return val ? '✅ Passed' : '🛑 Failed';
}

function formatLiquidity(liquidity: number | null | undefined): string {
  if (liquidity == null) return '❓ Unknown';
  if (liquidity >= 1_000_000) return `$${(liquidity / 1_000_000).toFixed(1)}M ✅`;
  if (liquidity >= 50_000) return `$${(liquidity / 1000).toFixed(0)}K ✅`;
  return `$${(liquidity / 1000).toFixed(0)}K 🛑 LOW`;
}

function formatHolderConc(pct: number | null | undefined): string {
  if (pct == null) return '❓ Unknown';
  if (pct > 60) return `${pct}% 🛑 HIGH`;
  if (pct > 35) return `${pct}% ⚠️`;
  return `${pct}% ✅`;
}

function patternHeader(pattern: string, score: number | undefined): string {
  const scoreStr = score != null ? ` — Score: ${score}/100` : '';
  const icons: Record<string, string> = {
    snipe:        `🎯 SNIPE SIGNAL${scoreStr}`,
    accumulation: `📈 ACCUMULATION SIGNAL${scoreStr}`,
    rotation:     `🔄 ROTATION SIGNAL${scoreStr}`,
    exit:         `🔴 EXIT SIGNAL${scoreStr}`,
    stealth:      `🕵️ STEALTH BUY${scoreStr}`
  };
  return icons[pattern] ?? `⚡ SIGNAL [${pattern.toUpperCase()}]${scoreStr}`;
}

function escapeHtml(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function formatSignalAlert(payload: SignalAlertPayload): Promise<string> {
  const ca = payload.tokenMint ?? 'N/A';
  const chain = payload.tokenMint?.includes(':') ? payload.tokenMint.split(':')[0] : 'solana';
  const rawCa = payload.tokenMint?.includes(':') ? payload.tokenMint.split(':')[1] : ca;

  const token = payload.tokenMint ? await getTokenMeta(payload.tokenMint) : null;
  const cluster = payload.clusterId ? await getClusterMeta(payload.clusterId) : null;

  let polymarketDetails = null;
  if (chain === 'polygon' && payload.tokenMint) {
    polymarketDetails = await getPolymarketMarketDetails(payload.tokenMint);
  }

  const isExit = payload.pattern === 'exit';
  const tokenLabel = polymarketDetails?.outcome_name
    ? escapeHtml(`$${polymarketDetails.outcome_name}`)
    : (token?.symbol ? escapeHtml(`$${token.symbol}`) : 'Unknown Token');
  const tokenName = escapeHtml(polymarketDetails?.question ?? (token?.name ?? ''));

  const lines: string[] = [
    `<b>${patternHeader(payload.pattern, payload.score)}</b>`,
    ''
  ];

  // ── CA block (most important) ──
  if (!isExit) {
    if (chain === 'polygon') {
      lines.push(`📋 <b>Token ID:</b> <code>${rawCa}</code>`);
      lines.push(`🏆 <b>Polymarket Market:</b> ${escapeHtml(polymarketDetails?.question) || 'Unknown Market'}`);
      lines.push(`🎯 <b>Traded Outcome:</b> ${escapeHtml(polymarketDetails?.outcome_name) || 'Unknown Outcome'}`);
      lines.push(`📊 <b>Outcomes Count:</b> ${polymarketDetails?.outcome_count ?? 2}`);
    } else {
      lines.push(`📋 <b>CA:</b> <code>${ca}</code>`);
      if (tokenLabel !== 'Unknown Token') {
        lines.push(`Token: ${tokenLabel}${tokenName ? ` (${tokenName})` : ''}`);
      }
    }
    lines.push('');
  } else {
    if (chain === 'polygon') {
      lines.push(`🏆 <b>Market:</b> ${escapeHtml(polymarketDetails?.question) || 'Unknown Market'}`);
      lines.push(`🎯 <b>Outcome:</b> ${escapeHtml(polymarketDetails?.outcome_name) || 'Unknown Outcome'} — <code>${rawCa}</code>`);
    } else {
      lines.push(`Token: ${tokenLabel} — <code>${ca}</code>`);
    }
    lines.push('');
  }

  // ── Cluster intel ──
  if (cluster) {
    const roi = cluster.total_realized_roi != null
      ? `${cluster.total_realized_roi >= 0 ? '+' : ''}${(cluster.total_realized_roi * 100).toFixed(0)}% ✅`
      : 'N/A';
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('<b>📊 CLUSTER INTEL</b>');
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push(`Cluster: ${escapeHtml(cluster.name) || payload.clusterId}`);
    lines.push(`Cluster 90d ROI: ${roi}`);
    lines.push(`Cluster confidence: ${Math.round(cluster.confidence * 100)}%`);
    lines.push(`Wallets triggered: ${payload.buyerCount ?? payload.sellerCount ?? '?'} of ${cluster.wallet_count}`);
    lines.push(`Pattern: ${payload.pattern.charAt(0).toUpperCase() + payload.pattern.slice(1)}`);
    if (payload.window) lines.push(`Window: ${payload.window}`);
    if (payload.buyVolume) lines.push(`Volume: $${payload.buyVolume.toLocaleString()}`);
    if (payload.exitVolume) lines.push(`Exit volume: $${payload.exitVolume.toLocaleString()}`);
    if (isExit && payload.sellerPct) lines.push(`Sellers: ${payload.sellerPct}% of cluster`);
    lines.push('');
  }

  // ── Token Safety ──
  if (!isExit) {
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('<b>🪙 TOKEN SAFETY</b>');
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push(`Safety check: ${formatSafe(payload.isSafe)}`);
    lines.push(`Liquidity: ${formatLiquidity(payload.liquidity)}`);
    lines.push(`Top 10 holders: ${formatHolderConc(payload.top10HolderPct)}`);

    if (payload.warnings && payload.warnings.length > 0) {
      lines.push('');
      lines.push('⚠️ <b>WARNINGS:</b>');
      payload.warnings.forEach(w => lines.push(`  - ${escapeHtml(w)}`));
    }
    lines.push('');
  }

  // ── Suggested execution ──
  if (!isExit && payload.isSafe) {
    const chain = payload.tokenMint?.includes(':') ? payload.tokenMint.split(':')[0] : 'solana';
    let sizeStr = '';
    if (chain === 'solana') {
      const baseSol = parseFloat(process.env.BASE_POSITION_SOL ?? '0.5');
      sizeStr = `${baseSol} SOL`;
    } else if (chain === 'polygon') {
      const baseUsdc = parseFloat(process.env.BASE_POSITION_USDC ?? '100');
      sizeStr = `${baseUsdc} USDC`;
    } else if (chain === 'robinhood-chain') {
      const baseEth = parseFloat(process.env.BASE_POSITION_ETH ?? '0.05');
      sizeStr = `${baseEth} ETH`;
    } else {
      sizeStr = '0.5 SOL';
    }

    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('<b>⚡ SUGGESTED EXECUTION</b>');
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push(`Size: ${sizeStr}`);
    lines.push(`Slippage: 15%`);
    lines.push(`TP1: 2x → sell 50%`);
    lines.push(`TP2: 3x → sell 25%`);
    lines.push(`SL: -25%`);
    lines.push('');
  }

  if (isExit) {
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push(`⚠️ Consider taking profit or tightening SL.`);
  } else if (!payload.isSafe) {
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('🛑 <b>EXECUTION BLOCKED — Safety check failed</b>');
  }

  lines.push('');
  lines.push(`Signal ID: <code>${payload.signalId}</code>`);

  if (payload.tokenMint) {
    if (chain === 'polygon') {
      lines.push([
        `<a href="https://dexscreener.com/polygon/${rawCa}">DexScreener</a>`,
        `<a href="https://polygonscan.com/token/${rawCa}">Polygonscan</a>`
      ].join(' | '));
    } else if (chain === 'robinhood-chain') {
      lines.push(`<code>${rawCa}</code> (Robinhood Network)`);
    } else {
      lines.push([
        `<a href="https://dexscreener.com/solana/${rawCa}">DexScreener</a>`,
        `<a href="https://solscan.io/token/${rawCa}">Solscan</a>`,
        `<a href="https://birdeye.so/token/${rawCa}">Birdeye</a>`
      ].join(' | '));
    }
  }

  return lines.join('\n');
}

// ─── Worker ───────────────────────────────────────────────────────────────────

async function deliverSignal(payload: SignalAlertPayload) {
  let lockKey = '';
  if (payload.signalId) {
    lockKey = `swat:alert:claim:${payload.signalId}`;
    const claimed = await redis.set(lockKey, '1', 'EX', 60, 'NX');
    if (!claimed) return { sent: false, reason: 'locked by another worker' };

    const [existing] = await query<{ alerted_at: Date | null }>(
      `SELECT alerted_at FROM signals WHERE id = $1`,
      [payload.signalId]
    );
    if (existing && existing.alerted_at) {
      await redis.del(lockKey);
      return { sent: false, reason: 'already alerted' };
    }
  }

  try {
    const message = await formatSignalAlert(payload);
    await sendTelegram(message);

    if (payload.signalId) {
      await query(
        `UPDATE signals SET alerted_at = NOW(), status = 'alerted' WHERE id = $1 AND alerted_at IS NULL`,
        [payload.signalId]
      );
    }

    return { sent: true };
  } finally {
    if (lockKey) {
      await redis.del(lockKey).catch(() => {});
    }
  }
}

const worker = new Worker(
  QUEUES.alerts,
  (job) => deliverQueuedAlert(job.data, {
    deliverSignal,
    sendOperational: sendOperationalTelegram
  }),
  { connection: redis }
).on('error', (err) => console.error('[alert-service] worker error', err));

// ─── Pub/Sub bridge ───────────────────────────────────────────────────────────

const bridge = createRedisAlertBridge({
  channel: REDIS_CHANNELS.alertQueue,
  enqueue: (name, payload, options) => alertQueue.add(name, payload, options),
  logRejected: (message, error) => console.warn(message, error)
});
const pendingBridgeDeliveries = new Set<Promise<unknown>>();

subscriber.on('message', (channel, message) => {
  const delivery = bridge.handleMessage(channel, message).catch((error) => {
    console.error('[alert-service] failed to bridge published alert', error);
  });
  pendingBridgeDeliveries.add(delivery);
  void delivery.finally(() => pendingBridgeDeliveries.delete(delivery));
});
subscriber.on('error', (error) => {
  console.error('[alert-service] alert subscriber error', error);
});

void subscriber.subscribe(REDIS_CHANNELS.alertQueue).then(() => {
  console.log(`[alert-service] subscribed to ${REDIS_CHANNELS.alertQueue}`);
}).catch((error) => {
  console.error('[alert-service] alert subscription failed', error);
});

// ─── Shutdown ─────────────────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[alert-service] ${signal} received; closing resources`);
  clearInterval(ingestionHealthTimer);

  const failures: unknown[] = [];
  try {
    await subscriber.unsubscribe(REDIS_CHANNELS.alertQueue);
  } catch (error) {
    failures.push(error);
  }

  const bridgeClosures = await Promise.allSettled([...pendingBridgeDeliveries]);
  for (const result of bridgeClosures) {
    if (result.status === 'rejected') failures.push(result.reason);
  }

  const serviceClosures = await Promise.allSettled([
    worker.close(),
    alertQueue.close()
  ]);
  for (const result of serviceClosures) {
    if (result.status === 'rejected') failures.push(result.reason);
  }

  const redisClosures = await Promise.allSettled([
    subscriber.quit(),
    bridgeRedis.quit(),
    redis.quit()
  ]);
  for (const result of redisClosures) {
    if (result.status === 'rejected') failures.push(result.reason);
  }

  if (failures.length > 0) {
    process.exitCode = 1;
    console.error('[alert-service] shutdown completed with errors', failures);
  } else {
    console.log('[alert-service] shutdown complete');
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

console.log('[alert-service] service running');
