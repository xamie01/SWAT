import Fastify from 'fastify';
import { listSignals } from '@swat/db';
import { deleteWallet, getWallet, listWallets, upsertWallet } from '@swat/db';
import { walletAddressSchema, walletInputSchema } from '@swat/shared';

const app = Fastify({ logger: true });

const API_KEY = process.env.API_KEY || 'swat-dev-key';

app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/v1/health')) return;
  const apiKey = request.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
});

app.get('/v1/health', async () => ({ status: 'ok', service: 'api', ts: new Date().toISOString() }));

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
  const inserted = await Promise.all(parsed.map((r) => upsertWallet((r as { success: true; data: any }).data)));
  return { inserted: inserted.length, wallets: inserted };
});

app.delete('/v1/wallets/:address', async (req, reply) => {
  const parsed = walletAddressSchema.safeParse((req.params as { address: string }).address);
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid wallet' });
  await deleteWallet(parsed.data);
  return reply.code(204).send();
});

app.get('/v1/wallets/:address/history', async () => ({ items: [], nextCursor: null }));
app.get('/v1/wallets/:address/holdings', async () => ({ items: [] }));

app.get('/v1/clusters', async () => ({ items: [] }));
app.get('/v1/clusters/:id', async () => ({ members: [], metrics: null }));
app.get('/v1/clusters/:id/performance', async () => ({ realizedRoi: null, unrealizedRoi: null }));
app.post('/v1/clusters/:id/refresh', async () => ({ queued: true }));
app.get('/v1/clusters/:id/timeline', async () => ({ events: [] }));

app.get('/v1/signals', async () => ({ items: await listSignals(100) }));
app.get('/v1/signals/:id', async () => ({ item: null }));
app.post('/v1/signals/:id/execute', async () => ({ queued: true }));
app.post('/v1/signals/:id/ignore', async () => ({ ignored: true }));
app.get('/v1/signals/stats', async () => ({ total: 0, executed: 0, alerted: 0 }));

app.get('/v1/tokens', async () => ({ items: [] }));
app.get('/v1/tokens/:mint', async () => ({ item: null }));
app.get('/v1/tokens/trending', async () => ({ items: [] }));
app.get('/v1/tokens/:mint/holders', async () => ({ items: [] }));

app.get('/v1/trading/status', async () => ({ mode: process.env.TRADING_MODE ?? 'paper', enabled: false }));
app.post('/v1/trading/mode', async () => ({ updated: true }));
app.get('/v1/trading/portfolio', async () => ({ valueUsd: 0, positions: [] }));
app.get('/v1/trading/performance', async () => ({ pnlUsd: 0, winRate: 0 }));
app.post('/v1/trading/execute', async () => ({ queued: true }));

app.get('/v1/stats', async () => ({ wallets: 0, signals: 0, trades: 0 }));
app.post('/v1/config', async () => ({ updated: true }));

const port = Number(process.env.PORT ?? 3001);

app.listen({ host: '0.0.0.0', port }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
