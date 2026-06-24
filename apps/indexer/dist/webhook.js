import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import crypto from 'node:crypto';
import { upsertWallet, refreshWalletActivity } from '@swat/db';
import { processTransaction } from './index.js';
const webhookSecret = process.env.HELIUS_WEBHOOK_SECRET;
const webhookPort = Number(process.env.WEBHOOK_PORT ?? 3002);
if (!webhookSecret) {
    console.warn('[webhook] HELIUS_WEBHOOK_SECRET is not set — the /webhook/helius endpoint ' +
        'will REJECT all requests (fail closed). Set the secret to enable real-time ingestion.');
}
const app = Fastify({ logger: true });
// Register raw body plugin — needed to access the unparsed body for HMAC verification
await app.register(fastifyRawBody, {
    field: 'rawBody',
    global: false, // Only attach to routes that opt in
    encoding: false, // Return Buffer, not string
    runFirst: true // Run before JSON parser
});
/**
 * Helius sends a SHA-256 HMAC in the 'Authorization' header.
 * Verify it to ensure the request is authentic.
 */
function verifyHeliusSignature(rawBody, authHeader) {
    // FAIL CLOSED: if no secret is configured we cannot authenticate the caller,
    // so reject. (Previously this returned true — a forgotten env var turned the
    // endpoint into an unauthenticated public write path.) Startup also guards
    // against running without a secret unless explicitly allowed.
    if (!webhookSecret)
        return false;
    if (!authHeader || !rawBody)
        return false;
    const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
    }
    catch {
        // timingSafeEqual throws if lengths differ
        return false;
    }
}
/**
 * POST /webhook/helius
 * Receives enhanced transaction webhooks from Helius.
 * Parses them exactly like the backfill path, but in real-time.
 */
app.post('/webhook/helius', {
    config: { rawBody: true }
}, async (req, reply) => {
    const rawBody = req.rawBody;
    const authHeader = req.headers['authorization'];
    if (!verifyHeliusSignature(rawBody, authHeader)) {
        return reply.code(401).send({ error: 'Invalid signature' });
    }
    const events = req.body;
    if (!Array.isArray(events) || events.length === 0) {
        return reply.code(200).send({ processed: 0 });
    }
    let processed = 0;
    let failed = 0;
    for (const event of events) {
        // Helius enhanced webhook format has accountData + instructions
        // The wallet that triggered the webhook is the fee payer
        const walletAddress = event.feePayer ?? event.accountData?.[0]?.account;
        if (!walletAddress)
            continue;
        // Isolate each event: one bad event must not abort the whole batch and force
        // Helius to retry (and re-process) the events that already succeeded.
        try {
            // Ensure wallet exists in DB (it should since we only subscribe to tracked wallets)
            await upsertWallet({ address: walletAddress, source: 'manual' });
            // Re-use the same tx processing logic as backfill
            const result = await processTransaction(event, walletAddress);
            if (result === 'inserted') {
                processed++;
                // Use the transaction's own block time (not now()) so retries/replays
                // don't push last_active to wall-clock time; refreshWalletActivity keeps
                // it monotonic.
                const blockTime = event.blockTime ?? event.timestamp;
                const lastActive = blockTime ? new Date(blockTime * 1000) : null;
                await refreshWalletActivity(walletAddress, lastActive, 1);
            }
        }
        catch (err) {
            failed++;
            req.log.error({ err, walletAddress }, '[webhook] event processing failed');
        }
    }
    // Always ack with 200 — we've durably handled what we could; failures are
    // logged rather than triggering a full-batch retry.
    return reply.code(200).send({ processed, failed });
});
app.get('/webhook/health', async () => ({ status: 'ok', service: 'indexer-webhook' }));
app.listen({ host: '0.0.0.0', port: webhookPort }).then(() => {
    console.log(`[indexer] Helius webhook listening on port ${webhookPort}`);
}).catch((err) => {
    console.error('[indexer] webhook server failed to start', err);
});
//# sourceMappingURL=webhook.js.map