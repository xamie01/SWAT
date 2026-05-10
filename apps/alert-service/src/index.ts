import { Worker } from 'bullmq';
import IORedis from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });

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

new Worker(
  'swat:alerts',
  async (job) => {
    const payload = job.data as { signalId: string; pattern: string };
    await sendTelegram(`🎯 SIGNAL: ${payload.pattern}\nSignal ID: ${payload.signalId}`);
    return { sent: true };
  },
  { connection: redis }
);

console.log('[alert-service] service running');
