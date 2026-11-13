import Fastify from 'fastify';
import {
  query,
  recordIngestionBatch,
  refreshWalletActivity
} from '@swat/db';
import { prefixChainValue } from '@swat/shared';
import { processTransaction } from './index.js';
import { observedIngestionEvidence } from './ingestion-health.js';
import {
  enhancedEventToTransaction,
  getEnhancedWalletCandidates,
  isRawHeliusTransaction,
  verifyStaticAuthorization,
  type EnhancedWebhookEvent
} from './webhook-helpers.js';

const webhookSecret = process.env.HELIUS_WEBHOOK_SECRET;
const webhookPort = Number(process.env.WEBHOOK_PORT ?? 3002);

if (!webhookSecret) {
  console.warn(
    '[webhook] HELIUS_WEBHOOK_SECRET is not set — the /webhook/helius endpoint will reject all requests.'
  );
}

export const app = Fastify({ logger: true });

async function getTrackedWallets(candidates: string[]): Promise<string[]> {
  const raw = [...new Set(candidates)].filter(Boolean);
  if (raw.length === 0) return [];
  const prefixed = raw.map((address) => prefixChainValue(address, 'solana'));
  const rows = await query<{ address: string }>(
    `SELECT address FROM wallets WHERE chain = 'solana' AND address = ANY($1::text[])`,
    [prefixed]
  );
  return rows.map((row) => row.address.slice('solana:'.length));
}

app.post('/webhook/helius', async (req, reply) => {
  const authHeader = req.headers.authorization as string | undefined;
  if (!verifyStaticAuthorization(authHeader, webhookSecret)) {
    return reply.code(401).send({ error: 'Invalid authorization' });
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  let processed = 0;
  let skipped = 0;
  let observed = 0;
  let quarantined = 0;
  let accepted = 0;
  let failed = 0;
  let lastEventAt: Date | null = null;

  for (const event of events) {
    try {
      const candidates = isRawHeliusTransaction(event)
        ? (event.transaction?.message?.accountKeys ?? [])
            .map((key) => typeof key === 'string' ? key : key.pubkey)
            .filter((key): key is string => Boolean(key))
        : getEnhancedWalletCandidates(event as EnhancedWebhookEvent);
      const wallets = await getTrackedWallets(candidates);
      if (wallets.length === 0) {
        skipped++;
        continue;
      }

      for (const walletAddress of wallets) {
        try {
          const transaction = isRawHeliusTransaction(event)
            ? event
            : enhancedEventToTransaction(event as EnhancedWebhookEvent, walletAddress);
          const blockTime = transaction.blockTime;
          if (blockTime) {
            const eventAt = new Date(blockTime * 1000);
            if (!lastEventAt || eventAt > lastEventAt) lastEventAt = eventAt;
          }

          const result = await processTransaction(transaction, walletAddress, 'solana-webhook', (outcome) => {
            observed++;
            if (outcome === 'quarantined') quarantined++;
            else accepted++;
          });
          if (result === 'inserted') {
            processed++;
            await refreshWalletActivity(
              prefixChainValue(walletAddress, 'solana'),
              blockTime ? new Date(blockTime * 1000) : null,
              1
            );
          } else {
            skipped++;
          }
        } catch (error) {
          failed++;
          req.log.error(
            { error, walletAddress },
            '[webhook] tracked wallet processing failed'
          );
        }
      }
    } catch (error) {
      failed++;
      req.log.error({ error }, '[webhook] event processing failed');
    }
  }

  await recordIngestionBatch({
    chain: 'solana',
    source: 'solana-webhook',
    lastEventAt,
    inserted: processed,
    skipped,
    failed,
    evidence: observedIngestionEvidence(observed, quarantined, accepted,
      failed > 0 ? 'partial' : 'unknown', 'delivery'),
    errorMessage: failed > 0 ? `${failed} webhook item(s) failed` : null
  });

  if (failed > 0) {
    return reply.code(503).send({
      processed,
      skipped,
      failed,
      error: 'Webhook batch requires retry'
    });
  }
  return reply.code(200).send({ processed, skipped, failed });
});

app.get('/webhook/health', async () => ({ status: 'ok', service: 'indexer-webhook' }));

if (process.env.NODE_ENV !== 'test') {
  app.listen({ host: '0.0.0.0', port: webhookPort }).then(() => {
    console.log(`[indexer] Helius webhook listening on port ${webhookPort}`);
  }).catch((error) => {
    console.error('[indexer] webhook server failed to start', error);
  });
}
