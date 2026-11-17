import { describe, expect, it, vi } from 'vitest';
vi.mock('@swat/db', () => ({ resolveChainMode: vi.fn(), forUser: (userId: string) => ({ userId }) }));
import { createLpExecutionMode, processLpOperationJob, recoverLpOperations, requestLpOperation } from './operations.js';

describe('legacy operation seams cannot falsely complete', () => {
  it('missing exact domain refuses admission and worker even with complete callback', async () => {
    const complete = vi.fn(); const d = { complete, executionMode: { resolveMode: async () => 'paper' } } as any;
    await expect(requestLpOperation(d, { userId: 'alice' } as any, { positionId: 'p', operationKey: 'close', kind: 'close' })).rejects.toThrow('receipt operations unavailable');
    await expect(processLpOperationJob(d, { operationId: 'op', userId: 'alice', chain: 'solana' })).rejects.toThrow('receipt worker unavailable');
    expect(complete).not.toHaveBeenCalled();
  });
  it('recovery cannot silently fabricate cross-tenant capability', async () => {
    expect(await recoverLpOperations({} as any)).toEqual({ queued: 0, deferred: 0, capabilityUnavailable: true });
  });
  it('mode adapter always requests fresh mode', async () => {
    const resolve = vi.fn().mockResolvedValueOnce({ effectiveMode: 'paper' }).mockResolvedValue({ effectiveMode: 'off' });
    const mode = createLpExecutionMode(resolve);
    expect(await mode.resolveMode('solana')).toBe('paper'); expect(await mode.resolveMode('solana')).toBe('off');
    expect(resolve.mock.calls).toEqual([['solana', { forceFresh: true }], ['solana', { forceFresh: true }]]);
  });
});
