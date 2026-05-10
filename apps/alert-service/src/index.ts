import { Worker } from 'bullmq';
import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(message: string) {
  if (!telegramToken || !telegramChatId) {
    console.log('[alert-service] telegram not configured, skipping send', message);
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: telegramChatId,
      text: message
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram API error: ${response.status}`);
  }
}

function formatSignalAlert(payload: {
  signalId: string;
  pattern: string;
  tokenMint?: string;
  clusterId?: string;
  buyerCount?: number;
  confidence?: number;
  score?: number;
  window?: string;
}) {
  const ca = payload.tokenMint ?? 'N/A';
  const lines = [
    '🚨 SWAT SIGNAL',
    '',
    `CA: ${ca}`,
    `Pattern: ${payload.pattern}`,
    `Score: ${payload.score ?? 'N/A'} | Confidence: ${payload.confidence ?? 'N/A'}%`,
    `Cluster: ${payload.clusterId ?? 'N/A'}`,
    `Buyers: ${payload.buyerCount ?? 'N/A'} in ${payload.window ?? 'N/A'}`,
    '',
    `Signal ID: ${payload.signalId}`,
    'Action: Paste CA into your execution bot.'
  ];
  return lines.join('\n');
}

new Worker(
  'swat:alerts',
  async (job) => {
    const payload = job.data as {
      signalId: string;
      pattern: string;
      tokenMint?: string;
      clusterId?: string;
      buyerCount?: number;
      confidence?: number;
      score?: number;
      window?: string;
    };
    await sendTelegram(formatSignalAlert(payload));
    return { sent: true };
  },
  { connection: redis }
);

console.log('[alert-service] service running');
