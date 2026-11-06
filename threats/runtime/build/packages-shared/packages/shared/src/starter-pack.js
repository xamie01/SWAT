export function clampInteger(value, fallback, minimum, maximum) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}
export async function collectSignaturesToOldest(fetchPage, options) {
    const maxTotal = clampInteger(options.maxTotal, 1000, 1, 100_000);
    const pageSize = clampInteger(options.pageSize, 1000, 1, 1000);
    const signatures = [];
    const seen = new Set();
    let before;
    let reachedOldest = false;
    while (signatures.length < maxTotal) {
        const limit = Math.min(pageSize, maxTotal - signatures.length);
        const page = await fetchPage({ before, limit });
        if (page.length === 0) {
            reachedOldest = true;
            break;
        }
        for (const record of page) {
            if (!seen.has(record.signature)) {
                seen.add(record.signature);
                signatures.push(record);
            }
        }
        if (page.length < limit) {
            reachedOldest = true;
            break;
        }
        const nextBefore = page[page.length - 1]?.signature;
        if (!nextBefore || nextBefore === before) {
            break;
        }
        before = nextBefore;
    }
    // A full final page does not prove that the final record is the account
    // origin. Probe once beyond the cap without retaining more history.
    if (!reachedOldest && signatures.length >= maxTotal && before) {
        const probe = await fetchPage({ before, limit: 1 });
        reachedOldest = probe.length === 0;
    }
    return {
        signatures,
        reachedOldest,
        capped: !reachedOldest && signatures.length >= maxTotal
    };
}
export function createStarterPackScoreTracker() {
    const wallets = new Map();
    function getWallet(address) {
        const existing = wallets.get(address);
        if (existing)
            return existing;
        const created = {
            address,
            patterns: new Set(),
            patternMatches: new Set(),
            tradeOutcomes: new Map()
        };
        wallets.set(address, created);
        return created;
    }
    function recordPattern(address, pattern, context) {
        const wallet = getWallet(address);
        wallet.patterns.add(pattern);
        wallet.patternMatches.add(`${pattern}:${context}`);
    }
    function recordTradeOutcome(address, tradeKey, isWin) {
        const wallet = getWallet(address);
        if (!wallet.tradeOutcomes.has(tradeKey)) {
            wallet.tradeOutcomes.set(tradeKey, isWin);
        }
    }
    function results() {
        return [...wallets.values()]
            .filter((wallet) => wallet.patternMatches.size > 0)
            .map((wallet) => {
            const outcomes = [...wallet.tradeOutcomes.values()];
            const successfulTrades = outcomes.filter(Boolean).length;
            const totalTrades = outcomes.length;
            return {
                address: wallet.address,
                patterns: [...wallet.patterns],
                successfulTrades,
                totalTrades,
                winRate: totalTrades > 0
                    ? Math.round((successfulTrades / totalTrades) * 100)
                    : null,
                score: wallet.patternMatches.size
            };
        });
    }
    return {
        recordPattern,
        recordTradeOutcome,
        results
    };
}
//# sourceMappingURL=starter-pack.js.map