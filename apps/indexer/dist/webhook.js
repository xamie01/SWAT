import Fastify from 'fastify';
import fastifyRawBody from 'fastify-raw-body';
import crypto from 'node:crypto';
import { upsertWallet, refreshWalletActivity } from '@swat/db';
import { processTransaction } from './index.js';
const webhookSecret = process.env.HELIUS_WEBHOOK_SECRET;
const webhookPort = Number(process.env.WEBHOOK_PORT ?? 3002);
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
    if (!webhookSecret) {
        console.warn('[webhook] HELIUS_WEBHOOK_SECRET not set — skipping signature verification');
        return true;
    }
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
    for (const event of events) {
        // Helius enhanced webhook format has accountData + instructions
        // The wallet that triggered the webhook is the fee payer
        const walletAddress = event.feePayer ?? event.accountData?.[0]?.account;
        if (!walletAddress)
            continue;
        // Ensure wallet exists in DB (it should since we only subscribe to tracked wallets)
        await upsertWallet({ address: walletAddress, source: 'manual' });
        // Re-use the same tx processing logic as backfill
        const result = await processTransaction(event, walletAddress);
        if (result === 'inserted') {
            processed++;
            await refreshWalletActivity(walletAddress, new Date(), 1);
        }
    }
    return reply.code(200).send({ processed });
});
app.get('/webhook/health', async () => ({ status: 'ok', service: 'indexer-webhook' }));
app.listen({ host: '0.0.0.0', port: webhookPort }).then(() => {
    console.log(`[indexer] Helius webhook listening on port ${webhookPort}`);
}).catch((err) => {
    console.error('[indexer] webhook server failed to start', err);
});
//# sourceMappingURL=webhook.js.map