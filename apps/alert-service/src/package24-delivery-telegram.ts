export type TelegramTransport = (url: string, init: RequestInit) => Promise<{
  ok: boolean;
  json(): Promise<unknown>;
}>;

/** Single bounded attempt. Timeout/rejection is uncertain, never safe to resend. */
export async function sendSignalTelegram(
  message: string,
  options: { token?: string; chatId?: string; transport: TelegramTransport; timeoutMs?: number }
): Promise<void> {
  if (!options.token || !options.chatId) throw new Error('Telegram is not configured for alert delivery');
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new Error('Telegram deadline must be an integer in 1..10000 milliseconds');
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Telegram deadline exceeded; delivery outcome uncertain'));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      (async () => {
        const response = await options.transport(`https://api.telegram.org/bot${options.token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ chat_id: options.chatId, text: message.length > 4096 ? message.slice(0, 4093) + '...' : message, parse_mode: 'HTML' })
        });
        const body = await response.json();
        if (!response.ok || typeof body !== 'object' || body === null || !('ok' in body) || body.ok !== true) {
          throw new Error('Telegram did not confirm delivery');
        }
      })(),
      timeout
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
