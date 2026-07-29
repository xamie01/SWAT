import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { query, recordIngestionBatch } from '@swat/db';
import { processTransaction } from './index.js';

vi.mock('@swat/db', () => ({
  query: vi.fn(),
  recordIngestionBatch: vi.fn(),
  refreshWalletActivity: vi.fn()
}));

vi.mock('./index.js', () => ({
  processTransaction: vi.fn()
}));

const wallet = '11111111111111111111111111111111';
let app: typeof import('./webhook.js').app;

describe('Solana webhook source lifecycle failure handling', () => {
  beforeAll(async () => {
    vi.stubEnv('HELIUS_WEBHOOK_SECRET', 'test-webhook-secret');
    vi.stubEnv('NODE_ENV', 'test');
    ({ app } = await import('./webhook.js'));
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue([{ address: `solana:${wallet}` }]);
    vi.mocked(recordIngestionBatch).mockResolvedValue();
  });

  it('returns a retryable status when canonical lifecycle persistence fails', async () => {
    vi.mocked(processTransaction).mockRejectedValueOnce(
      new Error('canonical lifecycle unavailable')
    );

    const response = await app.inject({
      method: 'POST',
      url: '/webhook/helius',
      headers: { authorization: 'test-webhook-secret' },
      payload: {
        blockTime: 1_760_000_000,
        transaction: {
          signatures: ['webhook-lifecycle-signature'],
          message: { accountKeys: [wallet], instructions: [] }
        },
        meta: {}
      }
    });

    expect(response.statusCode).toBe(503);
    expect(recordIngestionBatch).toHaveBeenCalledWith(expect.objectContaining({
      inserted: 0,
      skipped: 0,
      failed: 1
    }));
  });
});
