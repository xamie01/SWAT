import { describe, expect, it, vi } from 'vitest';
/**
 * `@swat/db` re-exports its own barrel, whose `client.ts` throws
 * `DATABASE_URL is required` while being evaluated. Hoisted so it runs before
 * the imports below — the same guard `fanout-eligibility.test.ts` and
 * `apps/scorer/src/stop-loss.test.ts` use. Nothing here opens a connection; the
 * pure decision layer is the only thing imported from it.
 */
vi.hoisted(() => {
    process.env.DATABASE_URL ??= 'postgres://swat:swat@127.0.0.1:5432/swat_unit_tests';
});
import { planFanout } from '@swat/db';
import { TRADE_QUEUES_BY_CHAIN } from '@swat/shared';
import { FANOUT_JOB_ID_SEPARATOR, TRADE_JOB_NAME, enqueueFanoutTradeJobs, operatorTradeJobId, planFanoutTradeJobs, summariseFanout, userTradeJobId } from './fanout-enqueue.js';
/**
 * One job per `(signal, user)` — `S4-14`.
 *
 * **What these tests can and cannot prove.** There is no Redis here, so nothing
 * is enqueued for real. The queue is a spy, which pins the descriptors, the ids
 * and the order — the whole of what the pure planner decides. It does **not**
 * prove BullMQ actually dedupes on these ids, that the executor can read the
 * payload, or that two concurrent producers race safely. Those need Redis and a
 * running executor.
 *
 * The load-bearing assertions are about the `jobId`, in both directions: it must
 * differ per user, and it must **not** differ for one user retried.
 */
const SIGNAL_ID = '5f1f0d3c-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_SIGNAL_ID = '5f1f0d3c-2222-4222-8222-bbbbbbbbbbbb';
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SOLANA_MINT = 'solana:MintAddress11111111111111111111111111';
const POLYGON_MINT = 'polygon:0xabcdef0123456789';
function eligible(userId, overrides = {}) {
    return {
        kind: 'eligible',
        userId,
        mirrors: overrides.mirrors ?? 'buys-and-sells',
        executionMode: overrides.executionMode ?? 'paper',
        downgraded: overrides.downgraded ?? false
    };
}
function plan(eligibleVerdicts, exclusionCounts = {}) {
    return { eligible: eligibleVerdicts, excluded: [], exclusionCounts };
}
function jobInput(overrides = {}) {
    return {
        signalId: SIGNAL_ID,
        tokenMint: SOLANA_MINT,
        score: 91,
        clusterTier: 'elite',
        sourceTrade: { sourceTradeId: 'src-1', direction: 'buy' },
        plan: plan([]),
        ...overrides
    };
}
function spyQueue() {
    const add = vi.fn().mockResolvedValue({ id: 'job' });
    const queue = { add };
    return { add, queueFor: () => queue };
}
describe('jobId — cannot collide across users', () => {
    it('gives two users on one signal two different ids', () => {
        expect(userTradeJobId(SIGNAL_ID, USER_A)).not.toBe(userTradeJobId(SIGNAL_ID, USER_B));
    });
    it('gives one user on two signals two different ids', () => {
        expect(userTradeJobId(SIGNAL_ID, USER_A)).not.toBe(userTradeJobId(OTHER_SIGNAL_ID, USER_A));
    });
    it('never produces the operator id from a user id', () => {
        expect(userTradeJobId(SIGNAL_ID, USER_A)).not.toBe(operatorTradeJobId(SIGNAL_ID));
        expect(userTradeJobId(SIGNAL_ID, USER_A).startsWith(operatorTradeJobId(SIGNAL_ID))).toBe(true);
    });
    it('emits one distinct id per eligible user in a fan-out', () => {
        const jobPlan = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A), eligible(USER_B)])
        }));
        const ids = jobPlan.users.map((job) => job.options.jobId);
        expect(new Set(ids).size).toBe(2);
        expect(ids).toEqual([
            userTradeJobId(SIGNAL_ID, USER_A),
            userTradeJobId(SIGNAL_ID, USER_B)
        ]);
    });
    it('refuses a user id containing the separator rather than producing an ambiguous key', () => {
        expect(() => userTradeJobId(SIGNAL_ID, `x${FANOUT_JOB_ID_SEPARATOR}y`)).toThrow(/may not contain/);
    });
    it('refuses an empty user id, which would collapse onto the operator key', () => {
        expect(() => userTradeJobId(SIGNAL_ID, '')).toThrow(/non-empty userId/);
    });
    it('refuses an empty signal id', () => {
        expect(() => operatorTradeJobId('')).toThrow(/non-empty signalId/);
    });
});
describe('jobId — cannot fail to collide for a retry', () => {
    it('is identical for the same (signal, user) called twice', () => {
        expect(userTradeJobId(SIGNAL_ID, USER_A)).toBe(userTradeJobId(SIGNAL_ID, USER_A));
    });
    it('does not change when the execution mode is downgraded between attempts', () => {
        // The retry case that matters: a certification lapses, `planFanout` clamps
        // live to paper, and a mode-bearing key would mint a second job for a user
        // who already has one.
        const live = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A, { executionMode: 'live' })])
        }));
        const downgraded = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A, { executionMode: 'paper', downgraded: true })])
        }));
        expect(downgraded.users[0].options.jobId).toBe(live.users[0].options.jobId);
    });
    it('does not change when the subscription winds down between attempts', () => {
        const active = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A, { mirrors: 'buys-and-sells' })])
        }));
        const windingDown = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A, { mirrors: 'sells-only' })])
        }));
        expect(windingDown.users[0].options.jobId).toBe(active.users[0].options.jobId);
    });
    it('does not change when the eligible list is reordered or shortened', () => {
        // Nothing positional may enter the key: a user dropping out of the middle of
        // the list would otherwise re-key everyone after them.
        const both = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A), eligible(USER_B)])
        }));
        const reordered = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_B), eligible(USER_A)])
        }));
        expect(reordered.users.find((job) => job.data.userId === USER_A).options.jobId)
            .toBe(both.users.find((job) => job.data.userId === USER_A).options.jobId);
    });
    it('does not change when the score or cluster tier changes', () => {
        const first = planFanoutTradeJobs(jobInput({ plan: plan([eligible(USER_A)]) }));
        const second = planFanoutTradeJobs(jobInput({
            score: 99,
            clusterTier: 'speculative',
            plan: plan([eligible(USER_A)])
        }));
        expect(second.users[0].options.jobId).toBe(first.users[0].options.jobId);
    });
});
describe('the legacy operator path', () => {
    it('keeps the pre-fan-out job id byte for byte', () => {
        expect(operatorTradeJobId(SIGNAL_ID)).toBe(`source-trade-${SIGNAL_ID}`);
    });
    it('is enqueued when there are no subscribers at all', async () => {
        const { add, queueFor } = spyQueue();
        const jobPlan = planFanoutTradeJobs(jobInput({ plan: plan([]) }));
        expect(jobPlan.users).toHaveLength(0);
        await enqueueFanoutTradeJobs(queueFor, jobPlan);
        expect(add).toHaveBeenCalledTimes(1);
        expect(add.mock.calls[0][2]).toMatchObject({ jobId: `source-trade-${SIGNAL_ID}` });
    });
    it('is enqueued when the fan-out could not run at all', async () => {
        const { add, queueFor } = spyQueue();
        await enqueueFanoutTradeJobs(queueFor, planFanoutTradeJobs(jobInput({ plan: null })));
        expect(add).toHaveBeenCalledTimes(1);
        expect(add.mock.calls[0][1]).not.toHaveProperty('userId');
    });
    it('is still enqueued alongside the user jobs when subscribers exist', async () => {
        // The operator is the pre-multi-tenant account; its trading has never
        // depended on whether anyone subscribed.
        const { add, queueFor } = spyQueue();
        await enqueueFanoutTradeJobs(queueFor, planFanoutTradeJobs(jobInput({ plan: plan([eligible(USER_A), eligible(USER_B)]) })));
        expect(add).toHaveBeenCalledTimes(3);
        expect(add.mock.calls[0][1]).not.toHaveProperty('userId');
        expect(add.mock.calls[1][1]).toMatchObject({ userId: USER_A });
        expect(add.mock.calls[2][1]).toMatchObject({ userId: USER_B });
    });
    it('carries no userId, executionMode or mirrors on the operator payload', () => {
        const jobPlan = planFanoutTradeJobs(jobInput({ plan: plan([eligible(USER_A)]) }));
        expect(jobPlan.operator.data).toEqual({
            signalId: SIGNAL_ID,
            score: 91,
            tokenMint: SOLANA_MINT,
            clusterTier: 'elite',
            sourceTradeId: 'src-1',
            direction: 'buy'
        });
    });
    it('keeps the pattern-signal path without a jobId, as before', () => {
        const jobPlan = planFanoutTradeJobs(jobInput({ sourceTrade: null, plan: null }));
        expect(jobPlan.operator.options.jobId).toBeUndefined();
        expect(jobPlan.operator.data).not.toHaveProperty('sourceTradeId');
        expect(jobPlan.operator.data).not.toHaveProperty('direction');
    });
    it('keeps the retry policy unchanged on every job', () => {
        const jobPlan = planFanoutTradeJobs(jobInput({ plan: plan([eligible(USER_A)]) }));
        for (const job of [jobPlan.operator, ...jobPlan.users]) {
            expect(job.options).toMatchObject({
                removeOnComplete: true,
                attempts: 4,
                backoff: { type: 'exponential', delay: 5000 }
            });
            expect(job.name).toBe(TRADE_JOB_NAME);
        }
    });
});
describe('queue resolution', () => {
    it('resolves the solana queue from the token mint', () => {
        const jobPlan = planFanoutTradeJobs(jobInput({ tokenMint: SOLANA_MINT }));
        expect(jobPlan.chain).toBe('solana');
        expect(jobPlan.queue).toBe(TRADE_QUEUES_BY_CHAIN.solana);
    });
    it('resolves the polygon queue from the token mint', () => {
        const jobPlan = planFanoutTradeJobs(jobInput({ tokenMint: POLYGON_MINT }));
        expect(jobPlan.chain).toBe('polygon');
        expect(jobPlan.queue).toBe(TRADE_QUEUES_BY_CHAIN.polygon);
    });
    it('puts every user job on the same queue as the operator job', () => {
        // A producer and the executor disagreeing on the chain puts a job on a queue
        // whose worker serves another venue, so there is exactly one derivation.
        const jobPlan = planFanoutTradeJobs(jobInput({
            tokenMint: POLYGON_MINT,
            plan: plan([eligible(USER_A), eligible(USER_B)])
        }));
        for (const job of [jobPlan.operator, ...jobPlan.users]) {
            expect(job.queue).toBe(TRADE_QUEUES_BY_CHAIN.polygon);
            expect(job.chain).toBe('polygon');
        }
    });
    it('refuses an unsupported chain prefix rather than defaulting', () => {
        expect(() => planFanoutTradeJobs(jobInput({ tokenMint: 'avalanche:0xdead' })))
            .toThrow(/Unsupported trade chain/);
    });
    it('asks the queue lookup for the plan chain exactly once', async () => {
        const { queueFor } = spyQueue();
        const lookup = vi.fn(queueFor);
        await enqueueFanoutTradeJobs(lookup, planFanoutTradeJobs(jobInput({ tokenMint: POLYGON_MINT, plan: plan([eligible(USER_A)]) })));
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(lookup).toHaveBeenCalledWith('polygon');
    });
});
describe('the verdict is carried, never recomputed', () => {
    it('puts the verdict execution mode on the job unchanged', () => {
        // `downgraded: false` on purpose: a user whose chain is simply configured for
        // paper is not a downgraded user, so nothing in the verdict except
        // `executionMode` itself can reproduce this value. A re-derivation from any
        // other field gets it wrong.
        const jobPlan = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A, { executionMode: 'paper', downgraded: false })])
        }));
        expect(jobPlan.users[0].data.executionMode).toBe('paper');
    });
    it('keeps paper for a non-downgraded paper user and live for a live user', () => {
        // Pins the pair that no single re-derivation can produce: same `downgraded`
        // value, different modes.
        const jobPlan = planFanoutTradeJobs(jobInput({
            plan: plan([
                eligible(USER_A, { executionMode: 'paper', downgraded: false }),
                eligible(USER_B, { executionMode: 'live', downgraded: false })
            ])
        }));
        expect(jobPlan.users.map((job) => job.data.executionMode)).toEqual(['paper', 'live']);
    });
    it('does not widen a downgraded paper verdict back to live', () => {
        // `planFanout` clamped this by the platform gates (`S4-17`). Re-deriving the
        // mode from the chain config here is exactly the re-widening that costs a
        // user a live trade they were not entitled to.
        const jobPlan = planFanoutTradeJobs(jobInput({
            plan: plan([
                eligible(USER_A, { executionMode: 'paper', downgraded: true }),
                eligible(USER_B, { executionMode: 'live' })
            ])
        }));
        expect(jobPlan.users.map((job) => job.data.executionMode)).toEqual(['paper', 'live']);
    });
    it('carries a sells-only verdict as sells-only', () => {
        const jobPlan = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A, { mirrors: 'sells-only' })])
        }));
        expect(jobPlan.users[0].data.mirrors).toBe('sells-only');
    });
    it('carries mixed mirror eligibilities independently', () => {
        const jobPlan = planFanoutTradeJobs(jobInput({
            plan: plan([
                eligible(USER_A, { mirrors: 'buys-and-sells' }),
                eligible(USER_B, { mirrors: 'sells-only' })
            ])
        }));
        expect(jobPlan.users.map((job) => job.data.mirrors)).toEqual([
            'buys-and-sells',
            'sells-only'
        ]);
    });
    it('never emits a job for an excluded user', () => {
        const excludedOnly = {
            eligible: [],
            excluded: [{ kind: 'excluded', userId: USER_A, code: 'auto-execute-off' }],
            exclusionCounts: { 'auto-execute-off': 1 }
        };
        expect(planFanoutTradeJobs(jobInput({ plan: excludedOnly })).users).toHaveLength(0);
    });
});
describe('the contract with planFanout', () => {
    it('consumes a real planFanout result end to end', () => {
        // Guards against this module drifting from `fanout-eligibility.ts`: the plan
        // here is produced by the real decision layer, not hand-built.
        const candidate = (userId, overrides = {}) => ({
            userId,
            activeSince: new Date('2026-09-01T00:00:00.000Z'),
            subscriptionState: 'active',
            tier: 'ultra',
            tierExpiresAt: null,
            autoExecute: true,
            killed: false,
            minSignalScore: 80,
            maxConcurrentPositions: 5,
            openPositionCount: 0,
            knownBalanceUsd: 5000,
            ...overrides
        });
        const signal = {
            chain: 'solana',
            masterWalletAddress: 'solana:Master1111',
            tokenMint: SOLANA_MINT,
            direction: 'buy',
            score: 91,
            eventAt: new Date('2026-09-02T00:00:00.000Z')
        };
        const platform = {
            chainMode: { effectiveMode: 'paper' },
            minimumBalanceUsd: 100,
            capacity: { outcome: 'admit' }
        };
        const realPlan = planFanout([candidate(USER_A), candidate(USER_B, { autoExecute: false })], signal, platform);
        const jobPlan = planFanoutTradeJobs(jobInput({ plan: realPlan }));
        expect(jobPlan.users).toHaveLength(1);
        expect(jobPlan.users[0].data).toMatchObject({
            userId: USER_A,
            executionMode: 'paper',
            mirrors: 'buys-and-sells'
        });
        expect(summariseFanout(realPlan).line).toBe('1 eligible, 1 excluded (auto-execute-off=1)');
    });
});
describe('summariseFanout', () => {
    it('distinguishes nobody subscribed from everybody excluded', () => {
        expect(summariseFanout(plan([])).line).toBe('0 eligible, 0 excluded (none)');
        expect(summariseFanout(plan([], { 'position-cap-reached': 4 })).line)
            .toBe('0 eligible, 4 excluded (position-cap-reached=4)');
    });
    it('orders codes by count so the dominant cause reads first', () => {
        const summary = summariseFanout(plan([eligible(USER_A)], {
            'auto-execute-off': 2,
            'tier-excludes-chain': 5,
            'below-user-min-score': 1
        }));
        expect(summary.line).toBe('1 eligible, 8 excluded (tier-excludes-chain=5, auto-execute-off=2, below-user-min-score=1)');
        expect(summary.eligibleCount).toBe(1);
        expect(summary.excludedCount).toBe(8);
    });
    it('warns about a feed outage when balance-unknown dominates', () => {
        const summary = summariseFanout(plan([], { 'balance-unknown': 12, 'auto-execute-off': 1 }));
        expect(summary.warning).toMatch(/balance feed outage suspected/);
        expect(summary.warning).toMatch(/balance poller/);
    });
    it('does not blame the feed when the balance is genuinely below the minimum', () => {
        // `balance-below-minimum` is a real user state; only the unknown code
        // indicates a broken feed. Conflating them sends an operator to the poller
        // when the answer is that the users are not funded.
        const summary = summariseFanout(plan([], { 'balance-below-minimum': 12 }));
        expect(summary.warning).toBeNull();
    });
    it('warns without the feed wording when capacity-unknown dominates', () => {
        const summary = summariseFanout(plan([], { 'capacity-unknown': 5 }));
        expect(summary.warning).toMatch(/capacity-unknown/);
        expect(summary.warning).toMatch(/platform fault/);
        expect(summary.warning).not.toMatch(/balance feed/);
    });
    it('stays quiet when a user setting is the dominant cause', () => {
        expect(summariseFanout(plan([], { 'auto-execute-off': 9 })).warning).toBeNull();
    });
    it('stays quiet when an unknown is present but is a minority', () => {
        const summary = summariseFanout(plan([], {
            'auto-execute-off': 8,
            'balance-unknown': 1
        }));
        expect(summary.warning).toBeNull();
    });
    it('stays quiet when nobody was excluded', () => {
        expect(summariseFanout(plan([eligible(USER_A)])).warning).toBeNull();
    });
    it('drops zero counts from the breakdown', () => {
        const summary = summariseFanout(plan([], { 'auto-execute-off': 0, 'user-killed': 2 }));
        expect(summary.line).toBe('0 eligible, 2 excluded (user-killed=2)');
    });
});
describe('enqueueFanoutTradeJobs', () => {
    it('returns how many jobs it added', async () => {
        const { queueFor } = spyQueue();
        const jobPlan = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A), eligible(USER_B)])
        }));
        await expect(enqueueFanoutTradeJobs(queueFor, jobPlan)).resolves.toBe(3);
    });
    it('propagates a queue failure instead of reporting a partial success', async () => {
        // The signal is only marked dispatched after this returns, so a throw is what
        // makes the fan-out re-run on the next tick — which is safe precisely because
        // the ids are stable.
        const add = vi.fn()
            .mockResolvedValueOnce({ id: 'operator' })
            .mockRejectedValueOnce(new Error('redis down'));
        const queue = { add };
        const jobPlan = planFanoutTradeJobs(jobInput({
            plan: plan([eligible(USER_A), eligible(USER_B)])
        }));
        await expect(enqueueFanoutTradeJobs(() => queue, jobPlan)).rejects.toThrow('redis down');
        expect(add).toHaveBeenCalledTimes(2);
    });
    it('passes the descriptor name, data and options through unchanged', async () => {
        const { add, queueFor } = spyQueue();
        const jobPlan = planFanoutTradeJobs(jobInput({ plan: plan([eligible(USER_A)]) }));
        await enqueueFanoutTradeJobs(queueFor, jobPlan);
        expect(add).toHaveBeenLastCalledWith(jobPlan.users[0].name, jobPlan.users[0].data, jobPlan.users[0].options);
    });
});
//# sourceMappingURL=fanout-enqueue.test.js.map