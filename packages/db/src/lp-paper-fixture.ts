import type { UserScope } from './tenancy.js';
import { lpSnapshot, type LpExactPosition, type LpExactOperation, type LpExactSubscription, type LpPaperQuote, type LpPaperReceipt } from './lp-exact.js';
import { createLpPaperService, lpResultAfterReceipt, type LpPaperServiceDeps, type LpPaperStore, type LpPaperTransaction } from './lp-paper-service.js';

/** Keyless test fixture, not PostgreSQL/runtime/provider evidence. Transaction copies model rollback explicitly. */
export function lpPaperFixture(plan: LpPaperServiceDeps['plan']) {
  const time = { now: new Date('2026-11-17T12:00:00.000Z') };
  const state = { positions: {} as Record<string, LpExactPosition>, operations: {} as Record<string, LpExactOperation>,
    subscriptions: {} as Record<string, LpExactSubscription>, next: 1, commits: [] as string[] };
  const policy = { totalMicroUsd: '0', poolMicroUsd: '0', unassessedPositions: 0, poolCapBps: 10000 };
  const fault = { settle: false, queue: false };
  const seen = { quotes: [] as unknown[], receipts: [] as unknown[], queue: [] as unknown[] };
  const transforms = { quote: (q: LpPaperQuote) => q, receipt: (r: LpPaperReceipt) => r };
  const mode = { value: 'paper' as 'paper' | 'off' | 'live' };
  const receipts = { available: false };
  const econ = { evidence: { basis: 'incremental-rebalance' as const, windowStart: time.now.toISOString(), windowEnd: '2026-11-18T12:00:00.000Z',
    extraFeesMicroUsd: '10000000', inventoryChangeMicroUsd: '-1000000', impermanentLossMicroUsd: '1000000', gasMicroUsd: '100000', repositionMicroUsd: '100000' } as LpPaperQuote['economics'] };
  const master = { event: { providerId: 'master-fixture', eventId: 'mint-event', chain: 'solana' as const, networkId: 'solana:test-fixture', protocol: 'meteora-dlmm' as const,
    masterWalletAddress: 'solana:master', masterPositionId: 'solana:nft', poolAddress: 'solana:pool', depositAsset: 'solana:mint', action: 'mint' as const,
    finality: 'finalized' as const, provenance: 'injected-mint-event' as const, openedAt: time.now.toISOString(), observedAt: time.now.toISOString(),
    masterDepositMicroUsd: '100000000', strategy: { distribution: 'spot' as const, rangeLower: 90, rangeUpper: 110, rungCount: 2 } } };
  const store: LpPaperStore = { transaction: async (scope: UserScope, action) => {
    if (!scope.userId || scope.userId === '*') throw new Error('tenant denied');
    const working = lpSnapshot(state);
    const owned = (p: LpExactPosition | undefined) => p?.userId === scope.userId ? p : null;
    const ownedOp = (op: LpExactOperation | undefined) => op?.userId === scope.userId ? op : null;
    const tx: LpPaperTransaction = {
      acquisition: async key => Object.values(working.positions).find(p => p.userId === scope.userId && p.acquisitionKey === key) ?? null,
      position: async id => owned(working.positions[id]), operation: async id => ownedOp(working.operations[id]),
      operationByKey: async key => Object.values(working.operations).find(op => op.userId === scope.userId && op.operationKey === key) ?? null,
      pendingForPosition: async id => Object.values(working.operations).find(op => op.userId === scope.userId && op.positionId === id && op.status === 'pending') ?? null,
      pending: async limit => Object.values(working.operations).filter(op => op.userId === scope.userId && op.status === 'pending').slice(0, limit),
      policy: async () => lpSnapshot(policy), subscription: async id => working.subscriptions[id]?.userId === scope.userId ? working.subscriptions[id]! : null,
      copyPosition: async (sub, event) => Object.values(working.positions).find(p => p.userId === scope.userId && p.copyOrigin?.subscriptionId === sub && p.copyOrigin.eventId === event) ?? null,
      copySpentMicroUsd: async sub => Object.values(working.positions).filter(p => p.userId === scope.userId && p.copyOrigin?.subscriptionId === sub).reduce((sum, p) => sum + BigInt(p.depositMicroUsd), 0n).toString(),
      insertAcquisition: async input => {
        const id = `position-${working.next++}`;
        const position: LpExactPosition = { id, userId: scope.userId, chain: input.request.chain, protocol: input.quote.pool.protocol, poolAddress: input.request.poolAddress,
          depositAsset: input.request.depositAsset, acquisitionKey: input.request.operationKey, acquisitionFingerprint: input.fingerprint, mode: 'paper',
          deposit: input.request.deposit, depositMicroUsd: input.quote.valueMicroUsd, acquisitionQuote: input.quote, copyOrigin: input.origin, currentAmount: input.request.deposit,
          plan: input.plan, revision: '0', state: 'active', autoRebalance: input.request.autoRebalance === true,
          cumulativeFeesMicroUsd: '0', cumulativeCostsMicroUsd: '0', realizedMicroUsd: null, lastReceiptKey: null };
        working.positions[id] = position; working.commits.push(input.origin ? 'acquisition+copy' : 'acquisition'); return lpSnapshot(position);
      },
      insertOperation: async input => {
        const id = `operation-${working.next++}`;
        const operation: LpExactOperation = { id, userId: scope.userId, positionId: input.position.id, operationKey: input.operationKey,
          fingerprint: input.fingerprint, action: input.action, positionRevision: input.position.revision, amountBefore: input.position.currentAmount,
          quote: input.quote, plan: input.plan, receiptKey: input.receiptKey, status: 'pending', receipt: null };
        working.operations[id] = operation; working.commits.push('operation'); return lpSnapshot(operation);
      },
      settle: async (op, position, receipt) => {
        working.positions[position.id] = lpResultAfterReceipt(position, op, receipt);
        const done = { ...op, status: 'completed' as const, receipt }; working.operations[op.id] = done;
        working.commits.push('receipt+position+operation');
        if (fault.settle) throw new Error('injected transaction failure');
        return lpSnapshot(done);
      }
    };
    const result = await action(tx); Object.assign(state, working); return result;
  } };
  const deps: LpPaperServiceDeps = { store, now: () => time.now, mode: async () => mode.value, plan,
    enqueue: async input => { seen.queue.push(lpSnapshot(input)); if (fault.queue) throw new Error('queue unavailable'); },
    master: { providerId: 'master-fixture', read: async () => lpSnapshot(master.event) },
    protocol: { providerId: 'paper-fixture', networks: { solana: 'solana:test-fixture', base: 'base:test-fixture' },
      quote: async input => {
        seen.quotes.push(lpSnapshot(input));
        const price = { raw: '1234567', scale: 6 };
        const value = (BigInt(input.deposit.raw) * BigInt(price.raw) / 10n ** BigInt(input.deposit.scale)).toString();
        const q: LpPaperQuote = { version: 1, providerId: 'paper-fixture', quoteId: `quote-${seen.quotes.length}`, userId: input.userId,
          intentHash: input.intentHash, action: input.action, mode: 'paper',
          pool: { chain: input.chain, networkId: `${input.chain}:test-fixture`, protocol: input.chain === 'solana' ? 'meteora-dlmm' : 'uniswap-v3', poolAddress: input.poolAddress,
            depositAsset: input.depositAsset, depositScale: input.deposit.scale, evidenceId: `pool-${seen.quotes.length}`, observedAt: time.now.toISOString(), currentPrice: 100,
            binStep: input.chain === 'solana' ? 10 : null, tickSpacing: input.chain === 'solana' ? null : 60 },
          deposit: input.deposit, unitPriceUsd: price, valueMicroUsd: value, amountAfter: input.action === 'close' ? { raw: '0', scale: input.deposit.scale } : input.deposit,
          proceedsMicroUsd: input.action === 'close' ? value : '0', observedAt: time.now.toISOString(), expiresAt: new Date(time.now.getTime() + 60_000).toISOString(),
          economics: input.action === 'rebalance' ? econ.evidence : null };
        return transforms.quote(q);
      },
      receipt: async ({ operation: op, position }) => {
        seen.receipts.push(lpSnapshot({ op, position })); if (!receipts.available) return null;
        const { lpExactHash } = await import('./lp-exact.js');
        return transforms.receipt({ version: 1, providerId: 'paper-fixture', receiptId: `receipt-${op.id}`, receiptKey: op.receiptKey,
          userId: op.userId, positionId: op.positionId, positionRevision: op.positionRevision, mode: 'paper', action: op.action,
          networkId: op.quote.pool.networkId, chain: position.chain, protocol: position.protocol, poolAddress: position.poolAddress, depositAsset: position.depositAsset,
          quoteId: op.quote.quoteId, quoteHash: lpExactHash(op.quote), amountBefore: op.amountBefore, amountAfter: op.quote.amountAfter,
          proceedsMicroUsd: op.quote.proceedsMicroUsd, collectedFeesMicroUsd: '100000', executionCostsMicroUsd: '50000', settledAt: time.now.toISOString(), finality: 'paper-settled' });
      }
    }
  };
  state.subscriptions.sub = { id: 'sub', userId: 'alice', masterWalletAddress: 'solana:master', chain: 'solana', venue: 'meteora-dlmm',
    budgetMicroUsd: '10000000', capMicroUsd: '6000000', status: 'active', createdAt: '2026-11-17T11:00:00.000Z', revision: 'initial-sub' };
  return { deps, service: createLpPaperService(deps), state, policy, fault, seen, transforms, mode, time, receipts, econ, master };
}
