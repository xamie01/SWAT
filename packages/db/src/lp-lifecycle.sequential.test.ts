import { describe, expect, it, vi } from 'vitest';
vi.mock('./tenancy.js', () => ({ withTenantTransaction: vi.fn() }));
import { assertLpValuation, createValuedLpPosition, createValuedLpPositionWithClient, requestLpPaperOperation,
  completeLpPaperOperation, completeLpPaperOperationWithClient, listPendingLpPaperOperations } from './lp-lifecycle.js';
import { readFileSync } from 'node:fs';

describe('legacy LP numeric and receiptless lifecycle is explicitly disabled', () => {
  it('source strings do not authorize numeric valuation', () => {
    expect(() => assertLpValuation({ source: 'trusted-fixture' } as any, 'solana', 'solana:mint', 1)).toThrow('not trusted');
  });
  it('legacy acquisition does not even open a transaction', async () => {
    const client = { query: vi.fn() };
    await expect(createValuedLpPosition({ userId: 'alice' } as any, {} as any)).rejects.toThrow('legacy float');
    await expect(createValuedLpPositionWithClient(client as any, { userId: 'alice' } as any, {} as any)).rejects.toThrow('legacy float');
    expect(client.query).not.toHaveBeenCalled();
  });
  it('admission and completion cannot mark paper closed without immutable receipt', async () => {
    const client = { query: vi.fn() };
    await expect(requestLpPaperOperation({ userId: 'alice' } as any, { positionId: 'p', operationKey: 'close', kind: 'close' })).rejects.toThrow('receiptless');
    await expect(completeLpPaperOperation('alice', 'op')).rejects.toThrow('receipt required');
    await expect(completeLpPaperOperationWithClient(client as any, 'alice', 'op')).rejects.toThrow('receipt required');
    expect(client.query).not.toHaveBeenCalled();
  });
  it('legacy wildcard sweep does not create operator authority', async () => {
    await expect(listPendingLpPaperOperations({ userId: '*' } as any)).rejects.toThrow('bounded tenant');
  });
  it('source proposal retains076 immutable unknown acquisitions and083 receipt fencing (not SQL execution)', () => {
    const old = readFileSync(new URL('../sql/076_lp_valued_paper_lifecycle.sql', import.meta.url), 'utf8');
    const proposal = readFileSync(new URL('../../../threats/project-completion-20261117/083-lp-schema.proposal.sql', import.meta.url), 'utf8');
    expect(old).toContain("DEFAULT 'unknown'"); expect(old).toContain('LP acquisition evidence is immutable');
    expect(proposal).toContain('LP completion requires immutable durable receipt');
    expect(proposal).toContain('LP position update requires completed revision-bound receipt');
    expect(proposal).toContain('FORCE ROW LEVEL SECURITY'); expect(proposal).not.toContain('SECURITY DEFINER');
  });
});
