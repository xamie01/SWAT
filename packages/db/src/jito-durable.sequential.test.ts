import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
const mocks = vi.hoisted(() => ({ canonical: vi.fn(), financial: vi.fn() }));
vi.mock('./copy-trade-lifecycle.js', () => ({ getCopyExecutionByIdWithClient: mocks.canonical }));
vi.mock('./worker-settlement.js', () => ({ reconcileWorkerFillWithClient: mocks.financial }));
import { claimJitoPendingWithClient, prepareJitoPendingWithClient, saveJitoBundleWithClient, type DurableJitoPending, type JitoPendingRow } from './jito-pending.js';
import { settleJitoReceiptWithClient, type QuantifiedJitoReceipt } from './jito-receipt.js';
import { createDatabaseJitoStore } from './jito-store.js';
const execution = { executionId: 'execution',clientOrderId: 'order',userId: null,chain: 'solana',targetAccount: 'solana:wallet' } as const;
const attempt = { executionId: 'execution',userId: null,fence: '1',policyRevision: 'revision',riskEpoch: null };
const intent = { inputMint: 'token',outputMint: 'So11111111111111111111111111111111111111112',inputAmountRaw: '1000',minimumOutputAmountRaw: '900',
  slippageBps: 100,recipient: 'wallet',tokenDecimals: 3,maxFeeLamports: '1000000',maxFeeUsd: '1' };
const pending: DurableJitoPending = { clientOrderId: 'order',bundleId: null,execution,intent,attempt,signedTransactions: ['c3dhcA==','dGlw'],
  signatures: ['swap-signature','tip-signature'],lastValidBlockHeight: 1000,expiresAt: new Date('2026-11-16T00:10:00Z'),tipLamports: 10000 };
const receipt: QuantifiedJitoReceipt = { execution,signature: 'swap-signature',slot: 42,inputMint: 'token',outputMint: intent.outputMint,
  inputAmountRaw: '1000',outputAmountRaw: '942',feeLamports: '15000',feeUsd: '0.1',quoteUsd: '10',baseQuantity: '1',
  recipient: 'wallet',confirmationState: 'finalized',occurredAt: new Date('2026-11-16T00:00:01Z') };
function row(): JitoPendingRow { return { client_order_id: 'order',state: 'prepared',execution_identity: execution,intent,attempt,
  signed_transactions: [...pending.signedTransactions],signatures: [...pending.signatures],bundle_id: null,last_valid_block_height: '1000',
  expires_at: pending.expiresAt,tip_lamports: '10000' }; }
let client: PoolClient; let events: string[]; let savedReceipt: { receipt: QuantifiedJitoReceipt;settled: boolean } | null;
beforeEach(() => { vi.clearAllMocks(); events = []; savedReceipt = null;
  mocks.canonical.mockResolvedValue({ id: 'execution',clientOrderId: 'order',userId: null,chain: 'solana',targetAccount: 'solana:wallet',
    tokenMint: 'solana:token',direction: 'sell',requestedBaseQuantity: '1',executionMode: 'live',state: 'reconciliation_required' });
  mocks.financial.mockImplementation(async (c: PoolClient, input: Parameters<typeof import('./worker-settlement.js').reconcileWorkerFillWithClient>[1],
    assertOwnership: Parameters<typeof import('./worker-settlement.js').reconcileWorkerFillWithClient>[2]) => {
    expect(c).toBe(client); await assertOwnership(c,input.attempt,input.evidence); events.push('financial');
    return { tradeId: 'trade',execution: { state: 'confirmed' },accountingComplete: true };
  });
  client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT target_account, token_mint, user_id')) return { rows: [{ target_account: 'solana:wallet',token_mint: 'solana:token',user_id: null }] };
    if (sql.includes('pg_advisory')) { events.push('position-lock'); return { rows: [] }; }
    if (sql.includes('SELECT * FROM jito_execution_pending')) { events.push('pending-lock'); return { rows: [row()] }; }
    if (sql.includes('SELECT r.execution_id')) { events.push('receipt-ownership'); return { rows: savedReceipt ? [{ execution_id: 'execution' }] : [] }; }
    if (sql.includes('SELECT receipt, settled')) { events.push('receipt-lock'); return { rows: savedReceipt ? [savedReceipt] : [] }; }
    if (sql.includes('INSERT INTO jito_execution_receipts')) { events.push('receipt-insert');
      const value = JSON.parse(values![4] as string) as QuantifiedJitoReceipt;
      savedReceipt = { receipt: { ...value,occurredAt: new Date(value.occurredAt) },settled: false }; return { rows: [] }; }
    if (sql.includes('UPDATE jito_execution_receipts')) { events.push('receipt-settled'); savedReceipt!.settled = true; return { rows: [] }; }
    if (sql.includes('SELECT execution_id FROM copy_execution_worker_attempts')) return { rows: [{ execution_id: 'execution' }] };
    if (sql.includes('INSERT INTO jito_execution_pending')) return { rows: [{ execution_id: 'execution' }] };
    if (sql.includes('UPDATE jito_execution_pending')) return { rows: [{ execution_id: 'execution' }] };
    if (sql.includes('SELECT receipt FROM jito_execution_receipts')) return { rows: savedReceipt?.settled ? [{ receipt: savedReceipt.receipt }] : [] };
    throw new Error(`Unexpected SQL ${sql}`);
  }) } as unknown as PoolClient;
});
describe('invoked durable SQL ownership/prewrite adapters', () => {
  it('claims only exact canonical identity and dispatched worker fence', async () => {
    expect(await claimJitoPendingWithClient(client,execution,intent,attempt)).toBe(true);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("state = 'dispatched'"),['execution',null,'1','revision',null]);
    mocks.canonical.mockResolvedValue({ id: 'foreign' });
    await expect(claimJitoPendingWithClient(client,execution,intent,attempt)).rejects.toThrow(/canonical claim identity/);
  });
  it('durable duplicate ownership cannot reclaim expired or lost preparation', async () => {
    vi.mocked(client.query).mockResolvedValue({ rows: [] } as never);
    await expect(claimJitoPendingWithClient(client,execution,intent,attempt)).rejects.toThrow(/scope/);
  });
  it('prepares exact two signed transactions/signatures using immutable attempt and intent match', async () => {
    await prepareJitoPendingWithClient(client,pending);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("state = 'claimed'"),expect.arrayContaining([
      JSON.stringify(pending.signedTransactions),JSON.stringify(pending.signatures),JSON.stringify(attempt)]));
    vi.mocked(client.query).mockResolvedValue({ rows: [] } as never);
    await expect(prepareJitoPendingWithClient(client,pending)).rejects.toThrow(/ownership/);
  });
  it('independently refuses changed canonical exact sell size before claiming or preparing', async () => {
    const canonical = await mocks.canonical();
    mocks.canonical.mockResolvedValue({ ...canonical,requestedBaseQuantity: '1.000000000000000001' });
    await expect(claimJitoPendingWithClient(client,execution,intent,attempt)).rejects.toThrow(/sell quantity mismatch/);
    expect(vi.mocked(client.query).mock.calls.some(call => String(call[0]).includes('INSERT INTO jito_execution_pending'))).toBe(false);
  });
  it('rejects post-response prewrite and mutated exact bytes', async () => {
    await expect(prepareJitoPendingWithClient(client,{ ...pending,bundleId: 'bundle' })).rejects.toThrow(/prewrite/);
    await expect(saveJitoBundleWithClient(client,{ ...pending,bundleId: 'bundle',signedTransactions: ['b3RoZXI=','dGlw'] })).rejects.toThrow(/exact bytes/);
  });
  it('response persistence accepts identical JSONB with reordered immutable fields', async () => {
    await saveJitoBundleWithClient(client,{ ...pending,execution: { targetAccount: execution.targetAccount,chain: 'solana',userId: null,
      clientOrderId: 'order',executionId: 'execution' },bundleId: 'bundle' });
  });
});
describe('bounded durable pending rotation', () => {
  it('more than 100 persistent unknowns cannot starve newer pending rows across restarts', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ ...row(),client_order_id: `order-${i}`,
      execution_identity: { ...execution,executionId: `execution-${i}`,clientOrderId: `order-${i}` },
      attempt: { ...attempt,executionId: `execution-${i}` },checked: 0,ordinal: i }));
    let clock = 0;
    const schedulingClient = { query: vi.fn(async (sql: string) => {
      // Stateful SQL-port model exercises the real adapter's bounded rotation
      // query; this is not a PostgreSQL locking/concurrency certificate.
      const rotated = sql.includes('last_checked_at = clock_timestamp()') && sql.includes('last_checked_at NULLS FIRST');
      const selected = [...rows].sort((a,b) => rotated ? a.checked - b.checked || a.ordinal - b.ordinal : a.ordinal - b.ordinal).slice(0,100);
      if (rotated) for (const r of selected) r.checked = ++clock;
      return { rows: selected };
    }) } as unknown as PoolClient;
    const transaction = async <T>(operation: (c: PoolClient) => Promise<T>) => operation(schedulingClient);
    const first = await createDatabaseJitoStore({ transaction }).listPending();
    const second = await createDatabaseJitoStore({ transaction }).listPending();
    const third = await createDatabaseJitoStore({ transaction }).listPending();
    expect(first).toHaveLength(100); expect(second).toHaveLength(100); expect(third).toHaveLength(100);
    expect(new Set([...first,...second,...third].map(p => p.clientOrderId)).size).toBe(205);
    expect(second.some(p => p.clientOrderId === 'order-100')).toBe(true);
    expect(third.some(p => p.clientOrderId === 'order-204')).toBe(true);
    expect(schedulingClient.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE SKIP LOCKED'));
    expect(rows.every(r => r.state === 'prepared')).toBe(true);
  });
});

describe('same-client receipt ownership and financial settlement', () => {
  it('locks canonical position→pending→receipt, owns quantified evidence, invokes financial seam then marks receipt', async () => {
    expect(await settleJitoReceiptWithClient(client,pending,receipt)).toBe(true);
    expect(events).toEqual(['position-lock','pending-lock','receipt-lock','receipt-insert','receipt-ownership','financial','receipt-settled']);
    expect(mocks.financial).toHaveBeenCalledWith(client,expect.objectContaining({ attempt,risk: null,
      evidence: expect.objectContaining({ evidenceType: 'chain_receipt',evidenceId: 'swap-signature',baseQuantity: '1',feeUsd: '0.1' }) }),expect.any(Function));
  });
  it.each([{ direction: 'buy' },{ tokenMint: 'solana:foreign' },{ requestedBaseQuantity: '2' }])(
    'canonical direction/token/quantity mismatch refuses before receipt ownership or financial effects %j', async change => {
      const canonical = await mocks.canonical(); mocks.canonical.mockResolvedValue({ ...canonical,...change });
      await expect(settleJitoReceiptWithClient(client,pending,receipt)).rejects.toThrow(/durable identity mismatch/);
      expect(mocks.financial).not.toHaveBeenCalled(); expect(events).not.toContain('receipt-insert');
    });
  it('duplicate receipt settles only once and rejects changed payload even after marker', async () => {
    await settleJitoReceiptWithClient(client,pending,receipt); await settleJitoReceiptWithClient(client,pending,receipt);
    expect(mocks.financial).toHaveBeenCalledOnce();
    await expect(settleJitoReceiptWithClient(client,pending,{ ...receipt,quoteUsd: '11' })).rejects.toThrow(/collision/);
  });
  it('financial rollback throws before receipt-settled; durable transaction rollback is not fake success', async () => {
    mocks.financial.mockRejectedValue(new Error('risk write failed'));
    await expect(settleJitoReceiptWithClient(client,pending,receipt)).rejects.toThrow('risk write failed');
    expect(events).not.toContain('receipt-settled'); expect(savedReceipt?.settled).toBe(false);
  });
  it('confirmed financial COMMIT/ack loss recovers a finalized observation without rewriting economics', async () => {
    const confirmed = { ...receipt,confirmationState: 'confirmed' as const };
    expect(await settleJitoReceiptWithClient(client,pending,confirmed)).toBe(true);
    const originalQuery = vi.mocked(client.query).getMockImplementation()!;
    let loseAcknowledgement = true;
    vi.mocked(client.query).mockImplementation(async (...args: unknown[]) => {
      if (loseAcknowledgement && String(args[0]).includes("SET state = 'settled'")) {
        loseAcknowledgement = false; throw new Error('acknowledgement write lost');
      }
      return originalQuery(...args as never) as never;
    });
    const store = createDatabaseJitoStore({ transaction: async operation => operation(client) });
    const confirmedResolution = { status: 'filled',clientOrderId: 'order',signature: receipt.signature,slot: receipt.slot,receipt: confirmed } as const;
    await expect(store.resolve('order',confirmedResolution)).rejects.toThrow('acknowledgement write lost');
    expect(savedReceipt!.settled).toBe(true); // Previous financial COMMIT survives separate acknowledgement failure.
    mocks.financial.mockClear(); events = [];
    expect(await settleJitoReceiptWithClient(client,pending,receipt)).toBe(true);
    expect(mocks.financial).not.toHaveBeenCalled(); expect(events).not.toContain('receipt-settled');
    const resolution = { ...confirmedResolution,receipt };
    await store.resolve('order',resolution);
    const acks = vi.mocked(client.query).mock.calls.filter(call => String(call[0]).includes("SET state = 'settled'"));
    const ack = acks.at(-1)!;
    expect(JSON.parse((ack[1] as unknown[])[1] as string).receipt).toEqual(JSON.parse(JSON.stringify(confirmed)));
    expect(savedReceipt!.receipt.confirmationState).toBe('confirmed');
    await expect(store.resolve('order',{ ...resolution,receipt: { ...receipt,quoteUsd: '11' } })).rejects.toThrow(/collision/);
  });
  it('finalized committed evidence refuses a confirmed observation regression', async () => {
    savedReceipt = { receipt,settled: true };
    await expect(settleJitoReceiptWithClient(client,pending,{ ...receipt,confirmationState: 'confirmed' })).rejects.toThrow(/regression/);
    expect(mocks.financial).not.toHaveBeenCalled();
  });
  it('store acknowledgement rejects missing financial marker even if caller says filled', async () => {
    const s = createDatabaseJitoStore({ transaction: async operation => { const result = await operation(client); events.push('COMMIT'); return result; } });
    const resolution = { status: 'filled',clientOrderId: 'order',signature: receipt.signature,slot: 42,receipt } as const;
    await expect(s.resolve('order',resolution)).rejects.toThrow(/before financial commit/);
    await settleJitoReceiptWithClient(client,pending,receipt); await s.resolve('order',resolution);
    expect(events.at(-1)).toBe('COMMIT');
  });
});
