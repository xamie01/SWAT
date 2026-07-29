export interface RedisHashClient {
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, field: string, value: string): Promise<unknown>;
}

const TYPE_KEY = '__swatRuntimeType';

export function encodeRuntimeValue(value: unknown): string {
  return JSON.stringify(value, function (key, current) {
    const original = key === '' ? value : (this as Record<string, unknown>)[key];
    if (original instanceof Date) {
      return { [TYPE_KEY]: 'date', value: original.toISOString() };
    }
    if (typeof original === 'bigint') {
      return { [TYPE_KEY]: 'bigint', value: original.toString() };
    }
    return current;
  });
}

export function decodeRuntimeValue<T>(encoded: string): T {
  return JSON.parse(encoded, (_key, current: unknown) => {
    if (!current || typeof current !== 'object') return current;
    const tagged = current as { [TYPE_KEY]?: unknown; value?: unknown };
    if (tagged[TYPE_KEY] === 'date' && typeof tagged.value === 'string') {
      const date = new Date(tagged.value);
      if (!Number.isFinite(date.getTime())) throw new Error('Stored runtime state contains an invalid date');
      return date;
    }
    if (tagged[TYPE_KEY] === 'bigint' && typeof tagged.value === 'string' && /^-?\d+$/.test(tagged.value)) {
      return BigInt(tagged.value);
    }
    return current;
  }) as T;
}
