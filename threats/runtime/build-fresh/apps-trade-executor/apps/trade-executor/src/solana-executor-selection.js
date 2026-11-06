/**
 * Reads the configured Solana executor.
 *
 * Defaults to `trojan`: an unset or malformed value must never silently promote
 * the uncertified path. An explicitly wrong value throws rather than falling
 * back, because a typo in an execution-routing variable should fail loudly at
 * startup, not route trades somewhere the operator did not intend.
 */
export function resolveSolanaExecutor(environment = process.env) {
    const raw = environment.SOLANA_EXECUTOR?.trim();
    if (!raw)
        return 'trojan';
    if (raw !== 'trojan' && raw !== 'jupiter-jito') {
        throw new Error(`SOLANA_EXECUTOR must be 'trojan' or 'jupiter-jito', got '${raw}'`);
    }
    return raw;
}
/**
 * Whether the Jupiter+Jito path may carry a live trade.
 *
 * Both conditions are required, and neither implies the other: the flag is
 * operator intent, the readiness check is whether a signer and block engine are
 * actually configured. This mirrors the `LIVE_ENABLED_CHAINS` +
 * `chain_certifications` pairing that gates live mode generally — one control
 * cannot stand in for the other.
 */
export function shouldUseJupiterJito(input) {
    if (input.chain !== 'solana')
        return false;
    return input.configured === 'jupiter-jito' && input.jitoReady;
}
/** The value written to `trades.executor` for a Solana trade. */
export function solanaExecutorName(kind) {
    return kind === 'jupiter-jito' ? 'jupiter-jito' : 'trojan';
}
//# sourceMappingURL=solana-executor-selection.js.map