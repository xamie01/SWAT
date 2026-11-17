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
    expect(proposal).toContain('LP operation admission requires pending state without receipt');
    expect(proposal).toContain('BEFORE INSERT OR UPDATE OR DELETE ON lp_exact_operations');
    expect(proposal).toContain("NEW.data->'receipt' IS DISTINCT FROM 'null'::jsonb");
    expect(proposal).toContain('r.position_id=op.position_id');
    expect(proposal).toContain("r.data=op.data->'receipt'");
    expect(proposal).toContain('LP completion requires immutable durable receipt');
    expect(proposal).toContain('LP position update requires completed revision-bound receipt');
    expect(proposal).toContain('LP acquisition retry snapshot must equal initial committed position');
    expect(proposal).toContain('NEW.acquisition_data IS DISTINCT FROM OLD.acquisition_data');
    expect(proposal).toContain('LP exact closed inventory cannot be reopened by legacy state');
    expect(proposal).toContain("NEW.data->'plan' IS DISTINCT FROM OLD.data->'plan'");
    expect(proposal).toContain('FORCE ROW LEVEL SECURITY'); expect(proposal).not.toContain('SECURITY DEFINER');
  });
});
