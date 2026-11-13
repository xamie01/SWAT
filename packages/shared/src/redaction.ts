const PRIVATE_FIELD = /(?:password|passphrase|secret|private.?key|api.?key|authorization|cookie|signature|token|ticket|sealed)/i;

export function diagnosticEndpoint(value: string): string {
  try { return new URL(value).hostname; } catch { return '[invalid-endpoint]'; }
}

export function redactLogText(value: string): string {
  return value
    .replace(/(?:https?|wss?|rediss?|postgres(?:ql)?):\/\/[^\s<>"'`]+/gi, text => `[endpoint:${diagnosticEndpoint(text)}]`)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[REDACTED authorization]')
    .replace(/\b((?:api[_-]?key|password|passphrase|secret|private[_-]?key|token|ticket|signature|authorization|cookie))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1=[REDACTED]');
}

export function redactLogValue(value: unknown, seen = new WeakMap<object, unknown>(), depth = 0): unknown {
  if (typeof value === 'string') return redactLogText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (depth > 8) return '[truncated]';
  if (seen.has(value)) return seen.get(value);
  try {
    if (value instanceof Error) return new Error(redactLogText(value.message));
    if (value instanceof Date) return value;
    if (ArrayBuffer.isView(value)) return '[binary]';
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).slice(0, 100)) {
      const property = descriptors[key]!;
      if (!property.enumerable) continue;
      const safe = PRIVATE_FIELD.test(key) ? '[REDACTED]'
        : 'value' in property ? redactLogValue(property.value, seen, depth + 1) : '[Getter]';
      Object.defineProperty(result, key, { value: safe, enumerable: true, configurable: true });
    }
    return result;
  } catch { return '<Revoked Proxy>'; }
}
