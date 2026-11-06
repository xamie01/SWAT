import { describe, expect, it, vi } from 'vitest';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createConnectionSimulator, createSolanaSimulationGate, createSolanaSimulationGateFromEnvironment, resolveSolanaSimulationEnvironment, resolveSolanaSimulationGate, simulateSolanaSwapTransaction } from './solana-simulation.js';
/**
 * Builds a real, decodable base64 versioned transaction with no network access.
 *
 * A hand-written base64 blob would exercise the undecodable branch by accident on
 * every test, so the happy paths need genuine transaction bytes. The "blockhash"
 * is any base58 32-byte value — the simulator is faked, so it is never resolved.
 */
function buildDecodableTransactionBase64() {
    const payer = Keypair.generate();
    const destination = Keypair.generate();
    const message = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [
            SystemProgram.transfer({
                fromPubkey: payer.publicKey,
                toPubkey: destination.publicKey,
                lamports: 1_000
            })
        ]
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([payer]);
    return Buffer.from(transaction.serialize()).toString('base64');
}
function simulatorReturning(value, slot = 300_000_001) {
    return vi.fn(async (_transaction, _config) => ({
        context: { slot },
        value: { err: null, logs: null, ...value }
    }));
}
describe('simulateSolanaSwapTransaction', () => {
    it('proceeds on a clean simulation and reports units and slot', async () => {
        const simulate = simulatorReturning({ err: null, logs: ['Program log: ok'], unitsConsumed: 142_311 });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64(), clientOrderId: 'sig-1:wallet-a' }, { simulate });
        expect(outcome).toEqual({ kind: 'proceed', unitsConsumed: 142_311, slot: 300_000_001 });
    });
    it('simulates with the blockhash replaced and signature verification off', async () => {
        const simulate = simulatorReturning({ err: null });
        await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate });
        expect(simulate).toHaveBeenCalledTimes(1);
        const [transaction, config] = simulate.mock.calls[0];
        expect(transaction).toBeInstanceOf(VersionedTransaction);
        // Both true is contradictory: replacing the blockhash invalidates the
        // signature over the original message.
        expect(config.replaceRecentBlockhash).toBe(true);
        expect(config.sigVerify).toBe(false);
        expect(config.commitment).toBe('processed');
    });
    it('refuses a reverted simulation and carries the tail of the program log', async () => {
        const simulate = simulatorReturning({
            err: { InstructionError: [3, { Custom: 6001 }] },
            logs: [
                'Program JUP6Lk... invoke [1]',
                'Program log: Instruction: Route',
                'Program log: AnchorError: SlippageToleranceExceeded',
                'Program JUP6Lk... failed: custom program error: 0x1771'
            ],
            unitsConsumed: 88_402
        });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64(), clientOrderId: 'sig-9:wallet-b' }, { simulate });
        expect(outcome.kind).toBe('refuse');
        if (outcome.kind !== 'refuse')
            throw new Error('expected a refusal');
        expect(outcome.code).toBe('solana-simulation-reverted');
        expect(outcome.reason).toContain('InstructionError');
        expect(outcome.reason).toContain('sig-9:wallet-b');
        expect(outcome.unitsConsumed).toBe(88_402);
        expect(outcome.slot).toBe(300_000_001);
        expect(outcome.logs).toEqual([
            'Program JUP6Lk... invoke [1]',
            'Program log: Instruction: Route',
            'Program log: AnchorError: SlippageToleranceExceeded',
            'Program JUP6Lk... failed: custom program error: 0x1771'
        ]);
    });
    it('refuses an err reported as a bare string', async () => {
        const simulate = simulatorReturning({ err: 'AccountNotFound' });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate });
        expect(outcome.kind).toBe('refuse');
        if (outcome.kind !== 'refuse')
            throw new Error('expected a refusal');
        expect(outcome.code).toBe('solana-simulation-reverted');
        expect(outcome.reason).toContain('AccountNotFound');
    });
    it('reports an unreachable simulator as unavailable, never as a revert', async () => {
        const simulate = vi.fn(async () => {
            throw new Error('fetch failed: ECONNREFUSED 127.0.0.1:8899');
        });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate: simulate });
        expect(outcome.kind).toBe('unavailable');
        if (outcome.kind !== 'unavailable')
            throw new Error('expected unavailable');
        expect(outcome.code).toBe('solana-simulator-unreachable');
        expect(outcome.reason).toContain('ECONNREFUSED');
    });
    it('reports a simulator deadline as unavailable', async () => {
        const simulate = vi.fn(async () => {
            throw new Error('simulateTransaction timed out after 5000ms');
        });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate: simulate });
        expect(outcome.kind).toBe('unavailable');
        if (outcome.kind !== 'unavailable')
            throw new Error('expected unavailable');
        expect(outcome.code).toBe('solana-simulator-unreachable');
        expect(outcome.reason).toContain('timed out');
    });
    it('does not read a response with no value as a clean simulation', async () => {
        // The dangerous shape: `value` absent makes `value.err` undefined, which is
        // falsy, so a naive check would proceed on a malformed response.
        const simulate = vi.fn(async () => ({ context: { slot: 1 } }));
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate: simulate });
        expect(outcome.kind).toBe('unavailable');
        if (outcome.kind !== 'unavailable')
            throw new Error('expected unavailable');
        expect(outcome.code).toBe('solana-simulator-response-invalid');
    });
    it('refuses bytes that are not a decodable versioned transaction', async () => {
        const simulate = simulatorReturning({ err: null });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: Buffer.from('not a transaction').toString('base64') }, { simulate });
        expect(outcome.kind).toBe('refuse');
        if (outcome.kind !== 'refuse')
            throw new Error('expected a refusal');
        expect(outcome.code).toBe('solana-simulation-transaction-undecodable');
        // The simulator is never even reached: nothing to ask it about.
        expect(simulate).not.toHaveBeenCalled();
    });
    it('refuses a compute-budget overrun when a cap is configured', async () => {
        const simulate = simulatorReturning({ err: null, unitsConsumed: 1_212_000 });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate, maxComputeUnits: 900_000 });
        expect(outcome.kind).toBe('refuse');
        if (outcome.kind !== 'refuse')
            throw new Error('expected a refusal');
        expect(outcome.code).toBe('solana-simulation-compute-units-exceeded');
        expect(outcome.reason).toContain('1212000');
        expect(outcome.reason).toContain('900000');
    });
    it('proceeds at exactly the cap', async () => {
        const simulate = simulatorReturning({ err: null, unitsConsumed: 900_000 });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate, maxComputeUnits: 900_000 });
        expect(outcome.kind).toBe('proceed');
    });
    it('does not apply a compute cap when none is configured', async () => {
        // No compute limit exists anywhere in this repo, so the unconfigured default
        // must be "observe, do not refuse" rather than an invented ceiling.
        const simulate = simulatorReturning({ err: null, unitsConsumed: 9_999_999 });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate });
        expect(outcome).toMatchObject({ kind: 'proceed', unitsConsumed: 9_999_999 });
    });
    it('treats a missing unitsConsumed as unknown, not as zero or a refusal', async () => {
        const simulate = simulatorReturning({ err: null });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate, maxComputeUnits: 1 });
        expect(outcome).toMatchObject({ kind: 'proceed', unitsConsumed: null });
    });
    it('never throws when the reverted err cannot be serialised', async () => {
        const circular = {};
        circular.self = circular;
        const simulate = simulatorReturning({ err: circular });
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate });
        expect(outcome.kind).toBe('refuse');
    });
});
describe('resolveSolanaSimulationGate', () => {
    const reverted = {
        kind: 'refuse',
        code: 'solana-simulation-reverted',
        reason: 'simulation reverted: AccountNotFound',
        unitsConsumed: null,
        slot: null,
        logs: []
    };
    const unavailable = {
        kind: 'unavailable',
        code: 'solana-simulator-unreachable',
        reason: 'simulateTransaction failed: fetch failed'
    };
    it('skips a revert under both policies', () => {
        expect(resolveSolanaSimulationGate(reverted, 'skip')).toEqual({
            kind: 'skip',
            code: 'solana-simulation-reverted',
            reason: reverted.reason
        });
        expect(resolveSolanaSimulationGate(reverted, 'submit')).toMatchObject({ kind: 'skip' });
    });
    it('fails closed on an unavailable simulator by default, with a distinct code', () => {
        const decision = resolveSolanaSimulationGate(unavailable);
        expect(decision.kind).toBe('skip');
        if (decision.kind !== 'skip')
            throw new Error('expected a skip');
        // The distinction is the whole point: an operator must not go debugging a
        // route when the real fault is the RPC endpoint.
        expect(decision.code).toBe('solana-simulator-unreachable');
        expect(decision.code).not.toBe('solana-simulation-reverted');
    });
    it('submits on an unavailable simulator only when that is chosen explicitly', () => {
        expect(resolveSolanaSimulationGate(unavailable, 'submit')).toEqual({
            kind: 'submit',
            outcome: unavailable
        });
    });
    it('submits a clean simulation', () => {
        const outcome = { kind: 'proceed', unitsConsumed: 10, slot: 5 };
        expect(resolveSolanaSimulationGate(outcome, 'skip')).toEqual({ kind: 'submit', outcome });
    });
});
describe('createSolanaSimulationGate', () => {
    it('classifies and applies policy in one call', async () => {
        const gate = createSolanaSimulationGate({
            simulate: simulatorReturning({ err: 'BlockhashNotFound' })
        });
        const decision = await gate.evaluate({
            transactionBase64: buildDecodableTransactionBase64()
        });
        expect(decision).toEqual({
            kind: 'skip',
            code: 'solana-simulation-reverted',
            reason: 'simulation reverted: BlockhashNotFound'
        });
    });
    it('honours an explicit submit-on-unavailable policy', async () => {
        const gate = createSolanaSimulationGate({
            simulate: vi.fn(async () => {
                throw new Error('gateway timeout');
            }),
            onUnavailable: 'submit'
        });
        const decision = await gate.evaluate({
            transactionBase64: buildDecodableTransactionBase64()
        });
        expect(decision.kind).toBe('submit');
    });
});
describe('createConnectionSimulator', () => {
    it('passes the config through to the connection', async () => {
        const simulateTransaction = vi.fn(async () => ({
            context: { slot: 7 },
            value: { err: null, logs: null }
        }));
        const simulate = createConnectionSimulator({ simulateTransaction }, 1_000);
        const outcome = await simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate });
        expect(outcome.kind).toBe('proceed');
        expect(simulateTransaction).toHaveBeenCalledTimes(1);
    });
    it('rejects past the deadline so a hung RPC reads as unavailable', async () => {
        vi.useFakeTimers();
        try {
            const simulate = createConnectionSimulator(
            // Never settles: a hung RPC, not a slow one.
            { simulateTransaction: () => new Promise(() => { }) }, 5_000);
            const pending = simulateSolanaSwapTransaction({ transactionBase64: buildDecodableTransactionBase64() }, { simulate });
            await vi.advanceTimersByTimeAsync(5_001);
            const outcome = await pending;
            expect(outcome.kind).toBe('unavailable');
            if (outcome.kind !== 'unavailable')
                throw new Error('expected unavailable');
            expect(outcome.code).toBe('solana-simulator-unreachable');
            expect(outcome.reason).toContain('timed out after 5000ms');
        }
        finally {
            vi.useRealTimers();
        }
    });
});
describe('resolveSolanaSimulationEnvironment', () => {
    const keys = [
        'SOLANA_SIMULATION_ENABLED',
        'SOLANA_SIMULATION_ON_UNAVAILABLE',
        'SOLANA_SIMULATION_MAX_COMPUTE_UNITS',
        'SOLANA_SIMULATION_TIMEOUT_MS',
        'SOLANA_RPC_URL',
        'HELIUS_API_KEY'
    ];
    function withEnvironment(values, run) {
        const saved = new Map();
        for (const key of keys)
            saved.set(key, process.env[key]);
        try {
            for (const key of keys)
                delete process.env[key];
            for (const [key, value] of Object.entries(values)) {
                if (value !== undefined)
                    process.env[key] = value;
            }
            run();
        }
        finally {
            for (const key of keys) {
                const value = saved.get(key);
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        }
    }
    it('enables simulation by default and fails closed on unavailability', () => {
        withEnvironment({ SOLANA_RPC_URL: 'https://rpc.example/v1' }, () => {
            expect(resolveSolanaSimulationEnvironment()).toEqual({
                enabled: true,
                rpcUrl: 'https://rpc.example/v1',
                timeoutMs: 5_000,
                maxComputeUnits: undefined,
                onUnavailable: 'skip'
            });
        });
    });
    it('applies no compute cap unless one is configured', () => {
        withEnvironment({ SOLANA_RPC_URL: 'https://rpc.example/v1' }, () => {
            expect(resolveSolanaSimulationEnvironment().maxComputeUnits).toBeUndefined();
        });
        withEnvironment({ SOLANA_RPC_URL: 'https://rpc.example/v1', SOLANA_SIMULATION_MAX_COMPUTE_UNITS: '1200000' }, () => {
            expect(resolveSolanaSimulationEnvironment().maxComputeUnits).toBe(1_200_000);
        });
    });
    it('throws rather than silently defaulting on a misspelled policy', () => {
        withEnvironment({ SOLANA_RPC_URL: 'https://rpc.example/v1', SOLANA_SIMULATION_ON_UNAVAILABLE: 'sumbit' }, () => {
            expect(() => resolveSolanaSimulationEnvironment()).toThrow(/SOLANA_SIMULATION_ON_UNAVAILABLE/);
        });
    });
    it('rejects a non-integer compute cap and timeout', () => {
        withEnvironment({ SOLANA_SIMULATION_MAX_COMPUTE_UNITS: '1.5' }, () => {
            expect(() => resolveSolanaSimulationEnvironment()).toThrow(/SOLANA_SIMULATION_MAX_COMPUTE_UNITS/);
        });
        withEnvironment({ SOLANA_SIMULATION_TIMEOUT_MS: '0' }, () => {
            expect(() => resolveSolanaSimulationEnvironment()).toThrow(/SOLANA_SIMULATION_TIMEOUT_MS/);
        });
    });
    it('derives the RPC URL from HELIUS_API_KEY when no explicit URL is set', () => {
        withEnvironment({ HELIUS_API_KEY: 'abc123' }, () => {
            expect(resolveSolanaSimulationEnvironment().rpcUrl).toBe('https://mainnet.helius-rpc.com/?api-key=abc123');
        });
    });
    it('builds no gate when disabled or when no RPC endpoint is configured', () => {
        withEnvironment({ SOLANA_RPC_URL: 'https://rpc.example/v1', SOLANA_SIMULATION_ENABLED: 'false' }, () => {
            expect(createSolanaSimulationGateFromEnvironment(() => notCalledConnection())).toBeNull();
        });
        withEnvironment({}, () => {
            expect(createSolanaSimulationGateFromEnvironment(() => notCalledConnection())).toBeNull();
        });
    });
    it('builds a working gate from the environment with no network', async () => {
        await withEnvironmentAsync({ SOLANA_RPC_URL: 'https://rpc.example/v1', SOLANA_SIMULATION_MAX_COMPUTE_UNITS: '500000' }, async () => {
            const gate = createSolanaSimulationGateFromEnvironment(() => ({
                simulateTransaction: async () => ({
                    context: { slot: 11 },
                    value: { err: null, logs: null, unitsConsumed: 600_000 }
                })
            }));
            expect(gate).not.toBeNull();
            const decision = await gate.evaluate({
                transactionBase64: buildDecodableTransactionBase64()
            });
            expect(decision).toMatchObject({
                kind: 'skip',
                code: 'solana-simulation-compute-units-exceeded'
            });
        });
    });
    function notCalledConnection() {
        throw new Error('connection factory must not be called when the gate is not built');
    }
    async function withEnvironmentAsync(values, run) {
        const saved = new Map();
        for (const key of keys)
            saved.set(key, process.env[key]);
        try {
            for (const key of keys)
                delete process.env[key];
            for (const [key, value] of Object.entries(values)) {
                if (value !== undefined)
                    process.env[key] = value;
            }
            await run();
        }
        finally {
            for (const key of keys) {
                const value = saved.get(key);
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        }
    }
});
//# sourceMappingURL=solana-simulation.test.js.map