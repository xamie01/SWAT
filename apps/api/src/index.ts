import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import {
  deleteWallet,
  getWallet,
  listWallets,
  upsertWallet,
  query
} from '@swat/db';
import { walletAddressSchema, walletInputSchema } from '@swat/shared';

const app = Fastify({ logger: true });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const tradeQueue = new Queue('swat-trades', { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }) });

// ─── Auth ─────────────────────────────────────────────────────────────────────

const API_KEY = process.env.API_KEY || 'swat-dev-key';

app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/v1/health') return;
  const apiKey = request.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
});

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
  return { inserted: inserted.length, wallets: inserted };
});

app.delete('/v1/wallets/:address', async (req, reply) => {
  const parsed = walletAddressSchema.safeParse((req.params as { address: string }).address);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid wallet' });
  await deleteWallet(parsed.data);
  return reply.code(204).send();
});

app.get('/v1/wallets/:address/history', async (req, reply) => {
  const address = (req.params as { address: string }).address;
  const { limit = 50, before } = req.query as { limit?: number; before?: string };

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

  const nextCursor = rows.length === Number(limit)
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
  if (!tokenMint) return reply.code(400).send({ error: 'tokenMint required' });

  // Publish to Redis so the discovery service picks it up
  await redis.publish('swat:discovery:seed-token', JSON.stringify({ tokenMint }));

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

  return { ingested, tokenMint };
});

app.post('/v1/discovery/run', async () => {
  await redis.publish('swat:discovery:run', JSON.stringify({ trigger: 'manual' }));
  return { queued: true };
});

app.get('/v1/discovery/log', async (req) => {
  const { limit = 50 } = req.query as { limit?: number };
  const rows = await query(`
    SELECT id, source, seed_value, wallets_discovered, ran_at
    FROM discovery_log
    ORDER BY ran_at DESC
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
  await redis.publish('swat:cluster:refresh', JSON.stringify({ clusterId: id }));
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
  const { status, min_score, pattern, limit = 100 } = req.query as {
    status?: string; min_score?: number; pattern?: string; limit?: number;
  };

  let sql = `SELECT * FROM signals WHERE 1=1`;
  const params: unknown[] = [];
  let i = 1;

  if (status) { sql += ` AND status = $${i++}`; params.push(status); }
  if (min_score) { sql += ` AND signal_score >= $${i++}`; params.push(min_score); }
  if (pattern) { sql += ` AND pattern_type = $${i++}`; params.push(pattern); }
  sql += ` ORDER BY created_at DESC LIMIT $${i++}`;
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

app.post('/v1/config', async (req) => {
  const updates = req.body as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    await query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, JSON.stringify(value)]
    );
  }
  return { updated: true };
});

// ─── Start ────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3001);
app.listen({ host: '0.0.0.0', port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
