import type { SolanaRpcPort } from './solana-checks.js';

/**
 * Raw JSON-RPC adapter over HTTP for the Solana risk checks — the indexer's
 * `heliusRpc` pattern (fetch with timeout and 429 retry), narrowed to the one
 * method the checks need.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;

export function createJsonRpcSolanaPort(rpcUrl: string, options: {
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
} = {}): SolanaRpcPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const fetchImpl = options.fetchImpl ?? fetch;
  let nextRequestId = 0;

  async function callOnce<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextRequestId, method, params })
    });
    if (!response.ok) {
      throw new Error(`Solana RPC ${method} returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as { result?: T; error?: { message?: string } };
    if (payload.error) {
      throw new Error(`Solana RPC ${method} failed: ${payload.error.message ?? 'unknown error'}`);
    }
    return payload.result as T;
  }

  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          return await callOnce<T>(method, params);
        } catch (error) {
          lastError = error;
          const status = error instanceof Error && /HTTP 429/.test(error.message) ? 429 : 0;
          if (attempt === maxRetries) break;
          // Exponential backoff; 429 backs off harder.
          const delayMs = status === 429 ? 500 * 2 ** attempt * 2 : 250 * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      throw lastError;
    }
  };
}
