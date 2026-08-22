import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  deleteWalletCascade,
  getIngestionHealth24h,
  getWallet,
  listWallets,
  upsertWallet,
  query,
  getAttributionDashboard,
  getAttributionLatencyReport,
  getLatestExpectancyReport,
  getLiveShadowCostReport
} from '@swat/db';
import {
  buildIngestionHealthSnapshots,
  chainFromTokenMint,
  chainSchema,
  createWalletBackfillJob,
  initLogger,
  isValidAddressForChain,
  prefixChainValue,
  QUEUES,
  REDIS_CHANNELS,
  tradeQueueForChain,
  walletAddressSchema,
  walletInputSchema
} from '@swat/shared';
import type { Chain } from '@swat/shared';
import {
  emergencyOff,
  executionModeUpdateSchema,
  getTradingControlStatus,
  updateTradingMode
} from './trading-control.js';
import { registerAttributionRoutes } from './attribution-routes.js';

initLogger('api');

const app = Fastify({ logger: true });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const tradeQueueConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
// One trade queue per chain (D6 / S3-25). Manual executions route by the
// signal's own chain-prefixed mint, using the same derivation the executor
// applies — a mismatch would enqueue onto a queue whose worker serves a
// different venue.
const tradeQueues = new Map<Chain, Queue>(
  (['solana', 'polygon', 'robinhood-chain'] as const).map((chain) => [
    chain,
    new Queue(tradeQueueForChain(chain), { connection: tradeQueueConnection })
  ])
);
const backfillQueue = new Queue(QUEUES.walletBackfill, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) });
// On-chain token discovery: the indexer's tokenDiscovery worker consumes this.
const tokenDiscoveryQueue = new Queue(QUEUES.tokenDiscovery, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) });

// Enqueue a backfill so the indexer fetches a wallet's transaction history.
// jobId is keyed by address; `backfillQueue.add` is a no-op if an identical
// job is already pending, so callers can fire this freely.
type WalletChain = 'solana' | 'polygon' | 'robinhood-chain';

async function enqueueBackfill(address: string, chain: WalletChain = 'solana') {
  const job = createWalletBackfillJob(address, chain);
  await backfillQueue.add(job.name, job.data, job.options);
}

function parseChain(raw: unknown, fallback: WalletChain = 'solana'): WalletChain {
  const parsed = chainSchema.safeParse(raw);
  return parsed.success ? parsed.data : fallback;
}

// ─── CORS ───────────────────────────────────────────────────────────────────
// Allow the web UI (any LAN origin / device) to call the API from the browser.
// CORS_ORIGIN can pin this to a specific origin in production.
const corsOrigin = process.env.CORS_ORIGIN;
await app.register(cors, {
  origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Api-Key']
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Fail fast in production rather than silently falling back to a publicly-known
// dev key (which is also baked into the web client bundle).
if (!process.env.API_KEY && process.env.NODE_ENV === 'production') {
  throw new Error('[api] API_KEY must be set in production');
}
const API_KEY = process.env.API_KEY || 'swat-dev-key';
const API_KEY_HASH = createHash('sha256').update(API_KEY).digest();

/** Constant-time API key check (hash both sides so lengths always match). */
function isValidApiKey(provided: string | string[] | undefined): boolean {
  const value = Array.isArray(provided) ? provided[0] ?? '' : provided ?? '';
  const providedHash = createHash('sha256').update(value).digest();
  return timingSafeEqual(providedHash, API_KEY_HASH);
}

import { randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { registerAuth, registerAdminOnlyGlobals } from './auth/plugin.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerMeRoutes } from './routes/me.js';
import { registerExecutionSettingsRoutes } from './routes/execution-settings.js';

await app.register(cookie);

// Blunts credential stuffing at the app layer. Cloudflare supplies the edge
// limits (D10); this is the second layer, and the one that still applies when
// traffic reaches the box directly.
await app.register(rateLimit, {
  max: Number(process.env.RATE_LIMIT_MAX ?? 300),
  timeWindow: '1 minute',
  allowList: () => false
});

// Order matters: the auth hook must be registered BEFORE any route scope it
// needs to serve. Fastify applies a parent's hooks only to children registered
// after `addHook`, so registering the auth routes first would leave them without
// a populated `request.principal` — and `POST /v1/auth/wallet/verify` would then
// treat an authenticated link request as an anonymous wallet-only login.
await registerAuth(app, {
  legacyKeyHash: API_KEY_HASH,
  isProduction: process.env.NODE_ENV === 'production',
  // `del` returns the number of keys removed, so a ticket can only ever be
  // consumed once even under concurrent requests.
  consumeSseTicket: async (ticket) => (await redis.del(`swat:ticket:${ticket}`)) === 1
});

await registerAdminOnlyGlobals(app);

// Stricter bucket for the credential endpoints specifically. Registered as a
// scoped plugin so the tighter limit cannot leak onto ordinary read routes.
await app.register(async (scope) => {
  await scope.register(rateLimit, {
    max: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
    timeWindow: '15 minutes',
    // Keyed on IP + email so one attacker cannot lock out an entire NAT, and a
    // single account cannot be sprayed from one address.
    keyGenerator: (request) => {
      const body = request.body as { email?: unknown } | undefined;
      const email = typeof body?.email === 'string' ? body.email.toLowerCase() : '';
      return `${request.ip}:${email}`;
    }
  });
  await registerAuthRoutes(scope, {
    redis,
    isProduction: process.env.NODE_ENV === 'production',
    domain: process.env.AUTH_DOMAIN ?? 'localhost:3000',
    uri: process.env.AUTH_URI ?? 'http://localhost:3000'
  });
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  // If it's a validation error or known client error, you can let it through.
  // Fastify validation errors have a validation property.
  const err = error as any;
  if (err.validation) {
    return reply.code(400).send({ error: 'Bad Request', message: err.message });
  }
  // PostgreSQL invalid uuid error (22P02) or similar can be mapped to 400
  if (err.code === '22P02') {
    return reply.code(400).send({ error: 'Bad Request', message: 'Invalid parameter format' });
  }
  // Fastify's own client errors (malformed JSON, empty body, payload too large)
  // already carry a 4xx statusCode. Without this they fell through to the 500
  // below, reporting the caller's mistake as a server fault — which hides real
  // 500s in the logs and tells the client to retry something that cannot work.
  if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: 'Bad Request', message: err.message });
  }
  // Return stable public error for anything else to prevent leaking DB details
  reply.code(500).send({ error: 'Internal Server Error' });
});

app.post('/v1/auth/ticket', async () => {
  const ticket = randomBytes(16).toString('hex');
  // Ticket expires in 60 seconds
  await redis.set(`swat:ticket:${ticket}`, '1', 'EX', 60);
  return { ticket };
});

await registerMeRoutes(app, { backfillQueue, tokenDiscoveryQueue });
await registerExecutionSettingsRoutes(app);

// ─── Query-param coercion helpers ───────────────────────────────────────────
// Query-string values are always strings. Coerce + bound them so a caller can't
// pass `?limit=99999999` (full table scan) or `?min_score=abc` (DB type error
// → 500 → broken pagination).
function clampLimit(raw: unknown, def = 100, max = 200): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}
function parseOptionalNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/v1/health', async () => ({
  status: 'ok',
  service: 'api',
  ts: new Date().toISOString()
}));

app.get('/v1/health/ingestion', async () => {
  const generatedAt = new Date();
  const rows = await getIngestionHealth24h();
  return {
    generatedAt: generatedAt.toISOString(),
    items: buildIngestionHealthSnapshots(rows, generatedAt)
  };
});

// ─── Stats (real data) ────────────────────────────────────────────────────────

app.get('/v1/stats', async () => {
  const [walletStats] = await query<{
    wallets: number;
    active: number;
    elite: number;
    pro: number;
  }>(`
    SELECT
      COUNT(*)                                    AS wallets,
      COUNT(*) FILTER (WHERE status = 'active')  AS active,
      COUNT(*) FILTER (WHERE tier = 'elite')     AS elite,
      COUNT(*) FILTER (WHERE tier = 'pro')       AS pro
    FROM wallets
  `);

  const [signalStats] = await query<{ signals: number; today: number }>(`
    SELECT
      COUNT(*)                                                          AS signals,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS today
    FROM signals
  `);

  const [tradeStats] = await query<{ trades: number; paper: number }>(`
    SELECT
      COUNT(*)                                                  AS trades,
      COUNT(*) FILTER (WHERE execution_mode = 'paper') AS paper
    FROM trades
    WHERE execution_mode IS NULL OR execution_mode != 'shadow'
  `);

  const [clusterStats] = await query<{ clusters: number }>(`
    SELECT COUNT(*) AS clusters FROM wallet_clusters WHERE status = 'active'
  `);

  return {
    wallets:  Number(walletStats?.wallets  ?? 0),
    active:   Number(walletStats?.active   ?? 0),
    elite:    Number(walletStats?.elite    ?? 0),
    pro:      Number(walletStats?.pro      ?? 0),
    signals:  Number(signalStats?.signals  ?? 0),
    signalsToday: Number(signalStats?.today ?? 0),
    trades:   Number(tradeStats?.trades    ?? 0),
    paperTrades: Number(tradeStats?.paper  ?? 0),
    clusters: Number(clusterStats?.clusters ?? 0)
  };
});

// ─── Wallets ──────────────────────────────────────────────────────────────────

app.get('/v1/wallets', async (req) => {
  const q = req.query as { chain?: string };
  return listWallets(q.chain ? parseChain(q.chain) : undefined);
});

app.get('/v1/wallets/:address', async (req, reply) => {
  const address = (req.params as { address: string }).address;
  const q = req.query as { chain?: string };
  const chain = parseChain(q.chain);
  if (!isValidAddressForChain(address, chain)) return reply.code(400).send({ error: 'Invalid wallet' });
  const wallet = await getWallet(address, chain);
  if (!wallet) return reply.code(404).send({ error: 'Wallet not found' });
  return wallet;
});

app.post('/v1/wallets', async (req, reply) => {
  const payload = (req.body ?? {}) as { wallets?: unknown[] };
  const items = Array.isArray(payload.wallets) ? payload.wallets : [];
  const parsed = items.map((item) => walletInputSchema.safeParse(item));
  const invalid = parsed.filter((r) => !r.success);
  if (invalid.length > 0) return reply.code(400).send({ error: 'Invalid wallet payload' });
  const inserted = await Promise.all(parsed.map((r) => upsertWallet((r as any).data)));
  // Kick off indexing so wallets added via the UI actually get their history.
  await Promise.all(inserted.map((w: any) => enqueueBackfill(w.address, w.chain ?? 'solana')));
  return { inserted: inserted.length, wallets: inserted, backfillQueued: inserted.length };
});

// Re-index: enqueue a backfill for every tracked wallet. Powers the
// "Start indexer" button in the web UI.
app.post('/v1/wallets/reindex', async () => {
  const wallets = await listWallets();
  await Promise.all(wallets.map((w: any) => enqueueBackfill(w.address, w.chain ?? 'solana')));
  return { queued: wallets.length };
});

app.delete('/v1/wallets/:address', async (req, reply) => {
  const q = req.query as { chain?: string };
  const address = (req.params as { address: string }).address;
  const chain = parseChain(q.chain);
  if (!isValidAddressForChain(address, chain)) return reply.code(400).send({ error: 'Invalid wallet' });
  const wallet = await getWallet(address, chain);
  if (!wallet) return reply.code(404).send({ error: 'Wallet not found' });
  await deleteWalletCascade(wallet.address, chain);
  return reply.code(204).send();
});

app.get('/v1/wallets/:address/history', async (req, reply) => {
  const address = (req.params as { address: string }).address;
  const q = req.query as { limit?: string; before?: string; chain?: string };
  const chain = parseChain(q.chain);
  const limit = clampLimit(q.limit, 50, 200);
  const before = q.before;

  if (!isValidAddressForChain(address, chain)) return reply.code(400).send({ error: 'Invalid wallet address' });
  const prefixedAddress = prefixChainValue(address, chain);

  const rows = await query(`
    SELECT id, signature, direction, target_token, amount_in, amount_out,
           amount_in_usd, amount_out_usd, program_id, timestamp
    FROM transactions
    WHERE wallet_address = $1
      AND chain = $2
      ${before ? `AND timestamp < $4` : ''}
    ORDER BY timestamp DESC
    LIMIT $3
  `, before ? [prefixedAddress, chain, limit, before] : [prefixedAddress, chain, limit]);

  const nextCursor = rows.length === limit
    ? (rows[rows.length - 1] as any).timestamp
    : null;

  return { items: rows, nextCursor };
});

app.get('/v1/wallets/:address/holdings', async (req, reply) => {
  const address = (req.params as { address: string }).address;
  const q = req.query as { chain?: string };
  const chain = parseChain(q.chain);
  if (!isValidAddressForChain(address, chain)) return reply.code(400).send({ error: 'Invalid wallet address' });
  const prefixedAddress = prefixChainValue(address, chain);

  // Calculate net token positions (bought - sold)
  const rows = await query(`
    SELECT
      target_token AS mint,
      tok.symbol,
      tok.name,
      SUM(CASE WHEN direction = 'buy'  THEN amount_out ELSE 0 END)::bigint AS total_bought,
      SUM(CASE WHEN direction = 'sell' THEN amount_in  ELSE 0 END)::bigint AS total_sold,
      SUM(CASE WHEN direction = 'buy'  THEN amount_in_usd  ELSE 0 END) AS cost_basis_usd,
      SUM(CASE WHEN direction = 'sell' THEN amount_out_usd ELSE 0 END) AS realized_usd
    FROM transactions t
    LEFT JOIN tokens tok ON t.target_token = tok.mint AND tok.chain = $2
    WHERE t.wallet_address = $1
      AND t.chain = $2
    GROUP BY t.target_token, tok.symbol, tok.name
    HAVING SUM(CASE WHEN direction = 'buy' THEN amount_out ELSE 0 END)
         > SUM(CASE WHEN direction = 'sell' THEN amount_in  ELSE 0 END)
    ORDER BY cost_basis_usd DESC NULLS LAST
  `, [prefixedAddress, chain]);

  return { items: rows };
});

// ─── Discovery ────────────────────────────────────────────────────────────────

app.post('/v1/discovery/from-token', async (req, reply) => {
  const { tokenMint, chain = 'solana' } = (req.body ?? {}) as { tokenMint?: string; chain?: WalletChain };
  if (chain !== 'solana') return reply.code(400).send({ error: 'Discovery from token currently supports only solana' });
  // A token mint is a Solana address; reuse the address schema to reject garbage
  // before it pollutes discovery_log / Redis.
  const parsedMint = walletAddressSchema.safeParse(tokenMint);
  if (!parsedMint.success) return reply.code(400).send({ error: 'Valid tokenMint required' });

  // The indexer owns token-seeded discovery. Queue exactly one canonical scan;
  // its deterministic job ID deduplicates concurrent requests for the same mint.
  await tokenDiscoveryQueue.add(
    'token-discovery',
    { tokenMint: parsedMint.data, chain },
    {
      jobId: `token-discovery-${chain}-${parsedMint.data}`,
      removeOnComplete: true,
      removeOnFail: 1000
    }
  );

  return { queued: true, tokenMint: parsedMint.data, chain };
});

app.post('/v1/discovery/run', async () => {
  await redis.publish(REDIS_CHANNELS.discoveryRun, JSON.stringify({ trigger: 'manual' }));
  return { queued: true };
});

app.get('/v1/discovery/log', async (req) => {
  const limit = clampLimit((req.query as { limit?: string }).limit, 50, 200);
  const rows = await query(`
    SELECT id, source, seed_value, wallets_discovered, ran_at
    FROM discovery_log
    ORDER BY ran_at DESC, id DESC
    LIMIT $1
  `, [limit]);
  return { items: rows };
});

// ─── Clusters (real data) ─────────────────────────────────────────────────────

app.get('/v1/clusters', async () => {
  const rows = await query(`
    SELECT id, name, cluster_type, confidence, wallet_count,
           total_realized_roi, avg_composite_score, status, last_active, created_at
    FROM wallet_clusters
    WHERE status = 'active'
    ORDER BY confidence DESC, wallet_count DESC
  `);
  return { items: rows };
});

app.get('/v1/clusters/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const [cluster] = await query(`SELECT * FROM wallet_clusters WHERE id = $1`, [id]);
  if (!cluster) return reply.code(404).send({ error: 'Cluster not found' });

  const members = await query(`
    SELECT w.address, w.tier, w.composite_score, w.win_rate, w.realized_roi,
           cm.confidence, cm.joined_at
    FROM cluster_memberships cm
    JOIN wallets w ON w.address = cm.wallet_address
    WHERE cm.cluster_id = $1
    ORDER BY w.composite_score DESC NULLS LAST
  `, [id]);

  return { cluster, members };
});

app.get('/v1/clusters/:id/performance', async (req) => {
  const { id } = req.params as { id: string };
  const [perf] = await query(`
    SELECT
      AVG(w.realized_roi)     AS avg_roi,
      AVG(w.win_rate)         AS avg_win_rate,
      AVG(w.composite_score)  AS avg_score,
      COUNT(*)                AS member_count
    FROM wallets w
    JOIN cluster_memberships cm ON w.address = cm.wallet_address
    WHERE cm.cluster_id = $1
  `, [id]);
  return perf ?? {};
});

app.post('/v1/clusters/:id/refresh', async (req) => {
  const { id } = req.params as { id: string };
  await redis.publish(REDIS_CHANNELS.clusterRefresh, JSON.stringify({ clusterId: id }));
  return { queued: true };
});

app.get('/v1/clusters/:id/timeline', async (req) => {
  const { id } = req.params as { id: string };
  const events = await query(`
    SELECT s.id, s.pattern_type, s.token_mint, s.signal_score, s.created_at
    FROM signals s
    WHERE s.cluster_id = $1
    ORDER BY s.created_at DESC
    LIMIT 30
  `, [id]);
  return { events };
});

// ─── Signals ──────────────────────────────────────────────────────────────────

app.get('/v1/signals', async (req) => {
  const q = req.query as {
    status?: string; min_score?: string; pattern?: string; limit?: string;
  };
  const minScore = parseOptionalNumber(q.min_score);
  const limit = clampLimit(q.limit);

  let sql = `SELECT * FROM signals WHERE 1=1`;
  const params: unknown[] = [];
  let i = 1;

  if (q.status) { sql += ` AND status = $${i++}`; params.push(q.status); }
  if (minScore !== undefined) { sql += ` AND signal_score >= $${i++}`; params.push(minScore); }
  if (q.pattern) { sql += ` AND pattern_type = $${i++}`; params.push(q.pattern); }
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${i++}`;
  params.push(limit);

  return { items: await query(sql, params) };
});

// NOTE: /stats must be registered BEFORE /:id, otherwise Fastify matches 'stats' as an :id
app.get('/v1/signals/stats', async () => {
  const [stats] = await query(`
    SELECT
      COUNT(*)                                         AS total,
      COUNT(*) FILTER (WHERE status = 'alerted')      AS alerted,
      COUNT(*) FILTER (WHERE status = 'executed')     AS executed,
      COUNT(*) FILTER (WHERE status = 'rejected')     AS rejected,
      AVG(signal_score) FILTER (WHERE status = 'alerted') AS avg_score
    FROM signals
  `);
  return stats ?? {};
});

app.get('/v1/signals/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const [signal] = await query(`SELECT * FROM signals WHERE id = $1`, [id]);
  if (!signal) return reply.code(404).send({ error: 'Signal not found' });
  return { item: signal };
});

app.post('/v1/signals/:id/ignore', async (req, reply) => {
  const { id } = req.params as { id: string };
  await query(`UPDATE signals SET status = 'rejected' WHERE id = $1`, [id]);
  return { ignored: true };
});

app.post('/v1/signals/:id/execute', async (req, reply) => {
  const { id } = req.params as { id: string };
  const [signal] = await query<{
    token_mint: string | null;
    signal_score: number;
    cluster_tier: 'elite' | 'pro' | 'promising' | 'speculative';
  }>(
    `SELECT s.token_mint,
            s.signal_score,
            CASE
              WHEN wc.avg_composite_score >= 90 THEN 'elite'
              WHEN wc.avg_composite_score >= 75 THEN 'pro'
              WHEN wc.avg_composite_score >= 60 THEN 'promising'
              ELSE 'speculative'
            END AS cluster_tier
       FROM signals s
       LEFT JOIN wallet_clusters wc ON wc.id = s.cluster_id
      WHERE s.id = $1`,
    [id]
  );
  if (!signal) return reply.code(404).send({ error: 'Signal not found' });
  if (!signal.token_mint) {
    return reply.code(409).send({ error: 'Signal has no executable token' });
  }

  // Enqueue to trade executor via BullMQ (not redis pubsub), on the queue for
  // this signal's own chain (S3-25). An unsupported prefix is refused here
  // rather than enqueued: before the split it reached the shared queue and died
  // in the executor, which reported a failed job instead of a bad request.
  let chain: Chain;
  try {
    chain = chainFromTokenMint(signal.token_mint);
  } catch (error) {
    return reply.code(409).send({
      error: error instanceof Error ? error.message : 'Unsupported trade chain'
    });
  }
  const tradeQueue = tradeQueues.get(chain);
  if (!tradeQueue) {
    return reply.code(409).send({ error: `No trade queue configured for chain ${chain}` });
  }

  await tradeQueue.add('signal-trade', {
    signalId: id,
    score: signal.signal_score,
    tokenMint: signal.token_mint,
    clusterTier: signal.cluster_tier,
    manual: true
  }, {
    removeOnComplete: true,
    attempts: 4,
    backoff: { type: 'exponential', delay: 5000 }
  });
  return { queued: true };
});

// ─── Tokens ───────────────────────────────────────────────────────────────────


app.get('/v1/tokens/trending', async () => {
  const rows = await query(`
    SELECT t.target_token AS mint, tok.symbol, tok.name,
           COUNT(DISTINCT t.wallet_address) AS unique_buyers,
           SUM(t.amount_in_usd) AS volume_usd
    FROM transactions t
    LEFT JOIN tokens tok ON t.target_token = tok.mint
    WHERE t.direction = 'buy'
      AND t.timestamp > NOW() - INTERVAL '24 hours'
      AND t.amount_in_usd IS NOT NULL
    GROUP BY t.target_token, tok.symbol, tok.name
    ORDER BY unique_buyers DESC, volume_usd DESC
    LIMIT 20
  `);
  return { items: rows };
});

app.get('/v1/tokens/:mint', async (req, reply) => {
  const { mint } = req.params as { mint: string };
  const q = req.query as { chain?: string };
  const chain = parseChain(q.chain);
  const prefixedMint = prefixChainValue(mint, chain);
  const [token] = await query(`SELECT * FROM tokens WHERE mint = $1`, [prefixedMint]);
  if (!token) return reply.code(404).send({ error: 'Token not found' });
  return { item: token };
});

// ─── Trading ──────────────────────────────────────────────────────────────────

app.get('/v1/trading/status', async () => {
  const control = await getTradingControlStatus();

  return {
    ...control,
    autoExecute: process.env.AUTO_EXECUTE === 'true',
    minScore: Number(process.env.AUTO_EXECUTE_MIN_SCORE ?? 85),
    basePositionSol: Number(process.env.BASE_POSITION_SOL ?? 0.5),
    basePositionUsdc: Number(process.env.BASE_POSITION_USDC ?? 100),
    basePositionEth: Number(process.env.BASE_POSITION_ETH ?? 0.05),
    useDynamicBalanceSizing: process.env.USE_DYNAMIC_BALANCE_SIZING === 'true',
    usdcBalanceRiskPct: Number(process.env.USDC_BALANCE_RISK_PCT ?? 2.0),
    ethBalanceRiskPct: Number(process.env.ETH_BALANCE_RISK_PCT ?? 2.0)
  };
});

app.post('/v1/trading/mode', async (req, reply) => {
  const parsed = executionModeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: 'Body must contain exactly one valid chain and execution mode'
    });
  }

  return updateTradingMode(parsed.data);
});

app.post('/v1/trading/emergency-off', async () => {
  return emergencyOff();
});

app.get('/v1/trading/portfolio', async () => {
  const positions = await query(`
    SELECT token_mint, SUM(amount_sol) AS total_sol, SUM(amount_usd) AS total_usd, direction
    FROM trades
    WHERE execution_mode IS NULL OR execution_mode != 'shadow'
    GROUP BY token_mint, direction
  `);
  return { positions };
});

app.get('/v1/trading/performance', async () => {
  const [perf] = await query(`
    SELECT
      AVG(CASE WHEN pnl_usd > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
      SUM(pnl_usd) AS total_pnl_usd,
      COUNT(*) AS total_signals
    FROM signals
    WHERE pnl_usd IS NOT NULL
  `);
  return {
    win_rate: perf?.win_rate ?? 0,
    total_pnl_usd: perf?.total_pnl_usd ?? 0,
    total_signals: perf?.total_signals ?? 0
  };
});

app.get('/v1/trading/trades', async () => {
  const items = await query(`
    SELECT id, signal_id, token_mint, direction, amount_sol, amount_usd, token_amount, price_usd, slippage_bps, signature, execution_mode, executor, status, price_impact_pct, quote_slot, min_token_amount, executed_at
    FROM trades
    WHERE execution_mode IS NULL OR execution_mode != 'shadow'
    ORDER BY executed_at DESC, id DESC
    LIMIT 50
  `);
  return { items };
});

registerAttributionRoutes(app, {
  getDashboard: getAttributionDashboard,
  getExpectancy: getLatestExpectancyReport,
  getLatency: getAttributionLatencyReport,
  getShadowCost: getLiveShadowCostReport
});

// ─── Config ───────────────────────────────────────────────────────────────────

app.get('/v1/config', async () => {
  const rows = await query(`SELECT key, value FROM config ORDER BY key`);
  return Object.fromEntries((rows as any[]).map((r) => [r.key, r.value]));
});

app.post('/v1/scorer/run', async () => {
  await redis.publish(REDIS_CHANNELS.scorerRun, JSON.stringify({}));
  return { queued: true };
});

app.get('/v1/logs', async () => {
  const logs = await redis.lrange('swat:logs:list', 0, -1);
  return {
    items: logs.map(l => {
      try {
        return JSON.parse(l);
      } catch {
        return { timestamp: new Date().toISOString(), service: 'unknown', level: 'error', message: l };
      }
    })
  };
});

app.get('/v1/logs/stream', async (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  reply.hijack();
  
  const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await sub.subscribe('swat:logs:stream');
  
  sub.on('message', (channel, message) => {
    reply.raw.write(`data: ${message}\n\n`);
  });
  
  req.raw.on('close', async () => {
    await sub.quit();
  });
});


// Only these config keys may be written through the API. Prevents an arbitrary
// caller from creating junk rows or shadowing keys consumers don't expect.
const ALLOWED_CONFIG_KEYS = new Set(['signals', 'trading', 'risk', 'discovery', 'blacklist']);

app.post('/v1/config', async (req, reply) => {
  const body = req.body;
  // Guard against non-object bodies (Object.entries(null) throws → 500).
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return reply.code(400).send({ error: 'Body must be a JSON object of config keys' });
  }
  const entries = Object.entries(body as Record<string, unknown>);
  const unknown = entries.filter(([key]) => !ALLOWED_CONFIG_KEYS.has(key)).map(([key]) => key);
  if (unknown.length > 0) {
    return reply.code(400).send({ error: `Unknown config key(s): ${unknown.join(', ')}` });
  }
  for (const [key, value] of entries) {
    await query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }
  return { updated: entries.length };
});

// ─── Start ────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3001);
app.listen({ host: '0.0.0.0', port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
