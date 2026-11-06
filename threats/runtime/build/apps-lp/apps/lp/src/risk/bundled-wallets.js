import { BUNDLED_WALLETS_FLAG } from './types.js';
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_MIN_BUNDLE_WALLETS = 3;
export function detectBundledWallets(edges, options = {}) {
    const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    const minBundleWallets = options.minBundleWallets ?? DEFAULT_MIN_BUNDLE_WALLETS;
    if (edges.length === 0)
        return null;
    const times = edges.map((edge) => edge.fundedAt.getTime());
    const earliest = Math.min(...times);
    const latest = Math.max(...times);
    // The window is about launch-time clustering: all funding edges must fall in
    // one window (not "each source within a window of itself") because the
    // accusation is "these wallets were minted together", which is a statement
    // about the whole allocation batch.
    if (latest - earliest > windowMs)
        return null;
    const bySource = new Map();
    for (const edge of edges) {
        bySource.set(edge.fundedFrom, (bySource.get(edge.fundedFrom) ?? 0) + 1);
    }
    const sources = [...bySource.entries()]
        .filter(([, count]) => count >= minBundleWallets)
        .map(([source]) => source);
    if (sources.length === 0)
        return null;
    const bundledWalletCount = edges
        .filter((edge) => sources.includes(edge.fundedFrom))
        .map((edge) => edge.wallet)
        .filter((wallet, index, all) => all.indexOf(wallet) === index).length;
    return {
        flag: BUNDLED_WALLETS_FLAG,
        detail: `${bundledWalletCount} wallets funded from ${sources.length} common source(s) within ${Math.round(windowMs / 60_000)}m window`,
        sources,
        walletCount: bundledWalletCount
    };
}
/** The Track C check: gathers edges through the port, applies the pure rule. */
export function bundledWalletsCheck(port) {
    return async (context) => {
        const edges = await port.fundingEdges(context.baseTokenMint);
        const finding = detectBundledWallets(edges);
        return finding ? [finding] : [];
    };
}
//# sourceMappingURL=bundled-wallets.js.map