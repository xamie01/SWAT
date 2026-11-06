import { describe, it, expect, vi } from 'vitest';
const dbMocks = vi.hoisted(() => ({
    createLpCopyExecution: vi.fn(),
    updateLpCopyExecutionStatus: vi.fn()
}));
vi.mock('@swat/db', () => dbMocks);
import { evaluateLpCopyEligibility } from './sizing.js';
import { diffMasterPositions } from './master-listener.js';
import { processLpCopyJob } from './copy-worker.js';
describe('Track 2: Forward-Only LP Copy-Trading Engine', () => {
    const baseSubDate = new Date('2026-10-31T12:00:00Z');
    const mockSub = {
        id: 'sub-1',
        userId: 'user-42',
        masterWalletAddress: 'solana:MasterWhale11111111111111111111111111111',
        chain: 'solana',
        venue: 'meteora-dlmm',
        allocatedBudgetUsd: 1000,
        maxCapitalPerPositionUsd: 500,
        status: 'active',
        createdAt: baseSubDate,
        updatedAt: baseSubDate
    };
    describe('sizing.ts — evaluateLpCopyEligibility', () => {
        it('enforces forward-only copying by rejecting positions opened prior to subscription', () => {
            const priorEvent = {
                masterWalletAddress: mockSub.masterWalletAddress,
                chain: 'solana',
                venue: 'meteora-dlmm',
                masterPositionId: 'solana:pos-old',
                poolAddress: 'solana:pool-1',
                action: 'mint',
                masterDepositUsd: 2000,
                openedAt: new Date(baseSubDate.getTime() - 60_000) // 1 minute before subscription
            };
            const result = evaluateLpCopyEligibility(mockSub, priorEvent);
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain('forward_only_violation');
            expect(result.followerDepositUsd).toBe(0);
        });
        it('approves positions opened after subscription and scales proportionally to budget', () => {
            const freshEvent = {
                masterWalletAddress: mockSub.masterWalletAddress,
                chain: 'solana',
                venue: 'meteora-dlmm',
                masterPositionId: 'solana:pos-new',
                poolAddress: 'solana:pool-1',
                action: 'mint',
                masterDepositUsd: 10_000,
                openedAt: new Date(baseSubDate.getTime() + 60_000) // 1 minute after subscription
            };
            // budget = 1000, maxCapital = 500, master = 10000
            // ratio = min(1.0, 1000 / 10000) = 0.1
            // raw follower deposit = 10000 * 0.1 = 1000
            // clamped by maxCapital = 500
            // effective scaleRatio = 500 / 10000 = 0.05
            const result = evaluateLpCopyEligibility(mockSub, freshEvent);
            expect(result.eligible).toBe(true);
            expect(result.followerDepositUsd).toBe(500);
            expect(result.scaleRatio).toBe(0.05);
            expect(result.action).toBe('mint');
        });
        it('rejects micro-dust deposits below MIN_COPY_DEPOSIT_USD', () => {
            const tinySub = {
                ...mockSub,
                allocatedBudgetUsd: 0.5,
                maxCapitalPerPositionUsd: 0.5
            };
            const freshEvent = {
                masterWalletAddress: mockSub.masterWalletAddress,
                chain: 'solana',
                venue: 'meteora-dlmm',
                masterPositionId: 'solana:pos-new',
                poolAddress: 'solana:pool-1',
                action: 'mint',
                masterDepositUsd: 10_000,
                openedAt: new Date(baseSubDate.getTime() + 1000)
            };
            const result = evaluateLpCopyEligibility(tinySub, freshEvent);
            expect(result.eligible).toBe(false);
            expect(result.reason).toContain('deposit_below_minimum');
        });
        it('mirrors burns and collects unconditionally for forward positions', () => {
            const burnEvent = {
                masterWalletAddress: mockSub.masterWalletAddress,
                chain: 'solana',
                venue: 'meteora-dlmm',
                masterPositionId: 'solana:pos-new',
                poolAddress: 'solana:pool-1',
                action: 'burn',
                masterDepositUsd: 5000,
                openedAt: new Date(baseSubDate.getTime() + 1000)
            };
            const result = evaluateLpCopyEligibility(mockSub, burnEvent);
            expect(result.eligible).toBe(true);
            expect(result.action).toBe('burn');
            expect(result.scaleRatio).toBe(1.0);
        });
        it('rejects events when subscription is paused or venue differs', () => {
            const pausedSub = { ...mockSub, status: 'paused' };
            const event = {
                masterWalletAddress: mockSub.masterWalletAddress,
                chain: 'solana',
                venue: 'meteora-dlmm',
                masterPositionId: 'solana:pos-1',
                poolAddress: 'solana:pool-1',
                action: 'mint',
                masterDepositUsd: 500,
                openedAt: new Date(baseSubDate.getTime() + 1000)
            };
            expect(evaluateLpCopyEligibility(pausedSub, event).eligible).toBe(false);
            const evmSub = { ...mockSub, chain: 'base', venue: 'uniswap-v3' };
            expect(evaluateLpCopyEligibility(evmSub, event).eligible).toBe(false);
        });
    });
    describe('master-listener.ts — diffMasterPositions', () => {
        it('detects new mints, burns, increases, and collects across position snapshots', () => {
            const posA = {
                positionAddress: 'solana:posA',
                poolAddress: 'solana:poolA',
                positionValueUsd: 1000,
                uncollectedFeesUsd: 10,
                inRange: true
            };
            // 1. Initial snapshot: detects posA as 'mint'
            const { events: mintEvents, nextState } = diffMasterPositions(mockSub.masterWalletAddress, 'solana', 'meteora-dlmm', new Map(), [posA], baseSubDate);
            expect(mintEvents).toHaveLength(1);
            expect(mintEvents[0].action).toBe('mint');
            expect(mintEvents[0].masterPositionId).toBe('solana:posA');
            expect(mintEvents[0].masterDepositUsd).toBe(1000);
            // 2. Second snapshot: posA harvested fees ($10 -> $1), and new posB was minted
            const posAUpdated = {
                ...posA,
                uncollectedFeesUsd: 1
            };
            const posB = {
                positionAddress: 'solana:posB',
                poolAddress: 'solana:poolB',
                positionValueUsd: 2500,
                uncollectedFeesUsd: 0,
                inRange: true
            };
            const { events: secondEvents, nextState: secondState } = diffMasterPositions(mockSub.masterWalletAddress, 'solana', 'meteora-dlmm', nextState, [posAUpdated, posB], new Date(baseSubDate.getTime() + 300_000));
            // Should have collect event for posA and mint event for posB
            const collect = secondEvents.find((e) => e.action === 'collect');
            const mintB = secondEvents.find((e) => e.action === 'mint');
            expect(collect).toBeDefined();
            expect(collect?.masterPositionId).toBe('solana:posA');
            expect(mintB).toBeDefined();
            expect(mintB?.masterPositionId).toBe('solana:posB');
            // 3. Third snapshot: posA was closed/burned
            const { events: burnEvents } = diffMasterPositions(mockSub.masterWalletAddress, 'solana', 'meteora-dlmm', secondState, [posB], new Date(baseSubDate.getTime() + 600_000));
            const burnA = burnEvents.find((e) => e.action === 'burn');
            expect(burnA).toBeDefined();
            expect(burnA?.masterPositionId).toBe('solana:posA');
        });
    });
    describe('copy-worker.ts — processLpCopyJob', () => {
        it('executes copy job in paper mode and updates database status', async () => {
            const mockCreate = vi.fn().mockResolvedValue({ id: 'exec-1' });
            const mockUpdate = vi.fn().mockResolvedValue(true);
            const job = {
                data: {
                    subscriptionId: 'sub-1',
                    userId: 'user-42',
                    chain: 'solana',
                    venue: 'meteora-dlmm',
                    action: 'mint',
                    masterPositionId: 'solana:pos-whale-1',
                    poolAddress: 'solana:pool-1',
                    masterDepositUsd: 10_000,
                    followerDepositUsd: 500,
                    scaleRatio: 0.05
                }
            };
            const deps = {
                executionMode: { resolveMode: async () => 'paper' },
                dbStore: {
                    createExecution: mockCreate,
                    updateExecutionStatus: mockUpdate
                }
            };
            const result = await processLpCopyJob(job, deps);
            expect(result.status).toBe('executed');
            expect(result.mode).toBe('paper');
            expect(mockCreate).toHaveBeenCalled();
            expect(mockUpdate).toHaveBeenCalledWith('exec-1', 'executed', null);
        });
        it('rejects copy job when execution mode is off', async () => {
            const mockCreate = vi.fn().mockResolvedValue({ id: 'exec-2' });
            const mockUpdate = vi.fn().mockResolvedValue(true);
            const job = {
                data: {
                    subscriptionId: 'sub-1',
                    userId: 'user-42',
                    chain: 'solana',
                    venue: 'meteora-dlmm',
                    action: 'mint',
                    masterPositionId: 'solana:pos-whale-1',
                    poolAddress: 'solana:pool-1',
                    masterDepositUsd: 10_000,
                    followerDepositUsd: 500,
                    scaleRatio: 0.05
                }
            };
            const deps = {
                executionMode: { resolveMode: async () => 'off' },
                dbStore: {
                    createExecution: mockCreate,
                    updateExecutionStatus: mockUpdate
                }
            };
            const result = await processLpCopyJob(job, deps);
            expect(result.status).toBe('rejected');
            expect(mockUpdate).toHaveBeenCalledWith('exec-2', 'rejected', expect.stringContaining('Chain execution mode is off'));
        });
    });
});
//# sourceMappingURL=copy.test.js.map