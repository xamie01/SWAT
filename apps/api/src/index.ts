import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  deleteWallet,
  getWallet,
  listWallets,
  upsertWallet,
  query
} from '@swat/db';
import { walletAddressSchema, walletInputSchema, REDIS_CHANNELS, QUEUES } from '@swat/shared';

const app = Fastify({ logger: true });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const tradeQueue = new Queue('swat-trades', { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) });
// Same queue/job contract the indexer worker consumes (see apps/indexer/src/index.ts).
const backfillQueue = new Queue('swat-backfill-wallet', { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) });
// On-chain token discovery: the indexer's tokenDiscovery worker consumes this.
const tokenDiscoveryQueue = new Queue(QUEUES.tokenDiscovery, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) });

// Enqueue a backfill so the indexer fetches a wallet's transaction history.
// jobId is keyed by address; `backfillQueue.add` is a no-op if an identical
// job is already pending, so callers can fire this freely.
async function enqueueBackfill(address: string) {
  await backfillQueue.add(
    'backfill-wallet',
    { address },
    { jobId: `backfill-${address}`, removeOnComplete: true, removeOnFail: 1000 }
  );
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

app.addHook('onRequest', async (request, reply) => {
  // Let CORS preflight requests through untouched.
  if (request.method === 'OPTIONS') return;
  if (request.url === '/v1/health') return;
  if (!isValidApiKey(request.headers['x-api-key'])) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
});

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

app.get('/v1/wallets', async () => listWallets());

app.get('/v1/wallets/:address', async (req, reply) => {
  const parsed = walletAddressSchema.safeParse((req.params as { address: string }).address);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid wallet' });
  const wallet = await getWallet(parsed.data);
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
  await Promise.all(inserted.map((w: any) => enqueueBackfill(w.address)));
  return { inserted: inserted.length, wallets: inserted, backfillQueued: inserted.length };
});

// Re-index: enqueue a backfill for every tracked wallet. Powers the
// "Start indexer" button in the web UI.
app.post('/v1/wallets/reindex', async () => {
  const wallets = await listWallets();
  await Promise.all(wallets.map((w: any) => enqueueBackfill(w.address)));
  return { queued: wallets.length };
});

app.delete('/v1/wallets/:address', async (req, reply) => {
  const parsed = walletAddressSchema.safeParse((req.params as { address: string }).address);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid wallet' });
  await deleteWallet(parsed.data);
  return reply.code(204).send();
});

app.get('/v1/wallets/:address/history', async (req, reply) => {
  const address = (req.params as { address: string }).address;
  const q = req.query as { limit?: string; before?: string };
  const limit = clampLimit(q.limit, 50, 200);
  const before = q.before;

  const parsed = walletAddressSchema.safeParse(address);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid wallet address' });

  const rows = await query(`
    SELECT id, signature, direction, target_token, amount_in, amount_out,
           amount_in_usd, amount_out_usd, program_id, timestamp
    FROM transactions
    WHERE wallet_address = $1
      ${before ? `AND timestamp < $3` : ''}
    ORDER BY timestamp DESC
    LIMIT $2
  `, before ? [address, limit, before] : [address, limit]);

  const nextCursor = rows.length === limit
    ? (rows[rows.length - 1] as any).timestamp
    : null;

  return { items: rows, nextCursor };
});

app.get('/v1/wallets/:address/holdings', async (req, reply) => {
  const address = (req.params as { address: string }).address;
  const parsed = walletAddressSchema.safeParse(address);
  if (!parsed.success) return reply.code(400).send({ error: 'Invalid wallet address' });

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
    LEFT JOIN tokens tok ON t.target_token = tok.mint
    WHERE t.wallet_address = $1
    GROUP BY t.target_token, tok.symbol, tok.name
    HAVING SUM(CASE WHEN direction = 'buy' THEN amount_out ELSE 0 END)
         > SUM(CASE WHEN direction = 'sell' THEN amount_in  ELSE 0 END)
    ORDER BY cost_basis_usd DESC NULLS LAST
  `, [address]);

  return { items: rows };
});

// ─── Discovery ────────────────────────────────────────────────────────────────

app.post('/v1/discovery/from-token', async (req, reply) => {
  const { tokenMint } = (req.body ?? {}) as { tokenMint?: string };
  // A token mint is a Solana address; reuse the address schema to reject garbage
  // before it pollutes discovery_log / Redis.
  const parsedMint = walletAddressSchema.safeParse(tokenMint);
  if (!parsedMint.success) return reply.code(400).send({ error: 'Valid tokenMint required' });

  // Publish to Redis so the discovery service picks it up
  await redis.publish(REDIS_CHANNELS.discoverySeedToken, JSON.stringify({ tokenMint }));

  // Also run inline early-buyer extraction
  const earlyBuyers = await query<{ wallet_address: string }>(`
    SELECT wallet_address
    FROM transactions
    WHERE target_token = $1
      AND direction = 'buy'
      AND timestamp < (
        SELECT MIN(timestamp) + INTERVAL '10 minutes'
        FROM transactions WHERE target_token = $1
      )
    GROUP BY wallet_address
    HAVING SUM(amount_in::bigint) > 500000000
    ORDER BY MIN(timestamp) ASC
    LIMIT 50
  `, [tokenMint]);

  let ingested = 0;
  for (const row of earlyBuyers) {
    await upsertWallet({ address: row.wallet_address, source: 'discovered' });
    ingested++;
  }

  await query(
    `INSERT INTO discovery_log (source, seed_value, wallets_discovered) VALUES ($1, $2, $3)`,
    ['token', tokenMint, ingested]
  );

  // Additionally kick off the deeper ON-CHAIN scan: the indexer pages the token's
  // history back to launch and seeds its early + biggest buyers (then backfills
  // and scores them). This is async — the immediate `ingested` count above comes
  // from data we already had; `queued` signals the chain scan has started. jobId
  // keyed by mint dedupes concurrent requests for the same token.
  await tokenDiscoveryQueue.add(
    'token-discovery',
    { tokenMint },
    { jobId: `token-discovery-${tokenMint}`, removeOnComplete: true, removeOnFail: 1000 }
  );

  return { ingested, queued: true, tokenMint };
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
  await query(`UPDATE signals SET status = 'ignored' WHERE id = $1`, [id]);
  return { ignored: true };
});

app.post('/v1/signals/:id/execute', async (req, reply) => {
  const { id } = req.params as { id: string };
  const [signal] = await query<{ token_mint: string; signal_score: number }>(
    `SELECT token_mint, signal_score FROM signals WHERE id = $1`, [id]
  );
  if (!signal) return reply.code(404).send({ error: 'Signal not found' });

  // Enqueue to trade executor via BullMQ (not redis pubsub)
  await tradeQueue.add('signal-trade', {
    signalId: id,
    score: signal.signal_score,
    tokenMint: signal.token_mint,
    manual: true
  }, { removeOnComplete: true });
  return { queued: true };
});

// ─── Tokens ───────────────────────────────────────────────────────────────────

app.get('/v1/tokens/:mint', async (req, reply) => {
  const { mint } = req.params as { mint: string };
  const [token] = await query(`SELECT * FROM tokens WHERE mint = $1`, [mint]);
  if (!token) return reply.code(404).send({ error: 'Token not found' });
  return { item: token };
});

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

// ─── Trading ──────────────────────────────────────────────────────────────────

app.get('/v1/trading/status', async () => ({
  mode: process.env.TRADING_MODE ?? 'paper',
  autoExecute: process.env.AUTO_EXECUTE === 'true',
  minScore: Number(process.env.AUTO_EXECUTE_MIN_SCORE ?? 90),
  basePositionSol: Number(process.env.BASE_POSITION_SOL ?? 0.5)
}));

app.get('/v1/trading/portfolio', async () => {
  const positions = await query(`
    SELECT token_mint, SUM(amount_sol) AS total_sol, SUM(amount_usd) AS total_usd, direction
    FROM trades
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
  return perf ?? { win_rate: 0, total_pnl_usd: 0, total_signals: 0 };
});

// ─── Config ───────────────────────────────────────────────────────────────────

app.get('/v1/config', async () => {
  const rows = await query(`SELECT key, value FROM config ORDER BY key`);
  return Object.fromEntries((rows as any[]).map((r) => [r.key, r.value]));
});

// Only these config keys may be written through the API. Prevents an arbitrary
// caller from creating junk rows or shadowing keys consumers don't expect.
const ALLOWED_CONFIG_KEYS = new Set(['signals', 'trading', 'risk', 'discovery']);

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
