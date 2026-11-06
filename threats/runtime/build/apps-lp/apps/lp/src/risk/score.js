import { BLACKLIST_CAPABLE_FLAG, BUNDLED_WALLETS_FLAG, EXCESSIVE_TAX_FLAG, FREEZE_AUTHORITY_FLAG, HOLDER_CONCENTRATION_FLAG, HONEYPOT_DETECTED_FLAG, LIQUIDITY_UNLOCKED_FLAG, MINT_AUTHORITY_FLAG, PAUSE_CAPABLE_FLAG, UNVERIFIED_SOURCE_FLAG } from './types.js';
/**
 * Risk score combiner (Track C5) — folds the checks' findings into one
 * 0..100 score (higher = riskier) plus a pass/fail gate.
 *
 * Weights live here and nowhere else: a check reports *facts* (flags), this
 * function decides how bad each fact is. The gate is deliberately separate
 * from the score so a caller can show a scored-but-blocked pool in a review
 * surface while the feed hard-excludes it.
 */
const RISK_FLAG_WEIGHTS = {
    [HONEYPOT_DETECTED_FLAG]: 100, // Instant kill
    [EXCESSIVE_TAX_FLAG]: 50,
    [UNVERIFIED_SOURCE_FLAG]: 30,
    [HOLDER_CONCENTRATION_FLAG]: 35,
    [BUNDLED_WALLETS_FLAG]: 25,
    [LIQUIDITY_UNLOCKED_FLAG]: 40,
    [MINT_AUTHORITY_FLAG]: 50,
    [FREEZE_AUTHORITY_FLAG]: 25,
    [PAUSE_CAPABLE_FLAG]: 10,
    [BLACKLIST_CAPABLE_FLAG]: 20
};
/** Pools scoring above the gate never reach the Discover feed. */
export const DEFAULT_RISK_GATE_MAX_SCORE = 40;
export function combineTokenRisk(findings, options = {}) {
    const maxScore = options.maxScore ?? DEFAULT_RISK_GATE_MAX_SCORE;
    // Deduplicate by flag — two checkers reporting the same fact must not
    // double-count it. The first detail wins; findings are ordered deterministic
    // by the caller.
    const flags = [];
    let score = 0;
    for (const finding of findings) {
        if (flags.includes(finding.flag))
            continue;
        flags.push(finding.flag);
        score += RISK_FLAG_WEIGHTS[finding.flag] ?? 0;
    }
    score = Math.min(100, score);
    const allowed = score <= maxScore;
    return {
        score,
        flags,
        allowed,
        rejectionReasons: allowed ? [] : [`risk_score_${score}_exceeds_gate_${maxScore}`]
    };
}
//# sourceMappingURL=score.js.map