import { recordLpWalletIndexPass, trackLpWallet, untrackLpWallet, upsertLpWalletPositionResult } from '@swat/db';
import { computeWalletPositionPnl } from './pnl.js';
export async function runWalletIndexPass(deps) {
    const listWallets = deps.listWallets ?? defaultListWallets;
    const recordPass = deps.recordPass ?? recordLpWalletIndexPass;
    const upsertResult = deps.upsertResult ?? upsertLpWalletPositionResult;
    const snapshotSeries = deps.snapshotSeries ?? (async () => []);
    const wallets = await listWallets();
    const summary = {
        walletsIndexed: 0,
        positionsObserved: 0,
        resultsClosed: 0,
        failedWallets: []
    };
    for (const wallet of wallets) {
        const reader = deps.readers.find((candidate) => candidate.chain === wallet.chain);
        if (!reader) {
            summary.failedWallets.push(wallet.walletAddress);
            continue;
        }
        try {
            const observed = await reader.readPositions(wallet.walletAddress);
            await recordPass(wallet.id, observed.map((position) => ({
                positionAddress: position.positionAddress,
                poolAddress: position.poolAddress,
                capturedAt: new Date(),
                positionValueUsd: position.positionValueUsd,
                uncollectedFeesUsd: position.uncollectedFeesUsd,
                inRange: position.inRange
            })));
            summary.walletsIndexed += 1;
            summary.positionsObserved += observed.length;
            for (const position of observed) {
                const series = await snapshotSeries(wallet.id, position.positionAddress);
                const pnl = computeWalletPositionPnl(series);
                if (!pnl)
                    continue;
                await upsertResult(wallet.id, {
                    positionAddress: position.positionAddress,
                    poolAddress: position.poolAddress,
                    chain: reader.chain,
                    strategyType: 'spot', // strategy attribution arrives with position metadata; spot is the ladder default
                    netResultUsd: pnl.netResultUsd,
                    firstObservedAt: pnl.firstObservedAt,
                    lastObservedAt: pnl.lastObservedAt,
                    closed: pnl.closed
                });
                summary.resultsClosed += 1;
            }
        }
        catch (error) {
            summary.failedWallets.push(wallet.walletAddress);
            console.error('[lp] wallet index pass failed for', wallet.walletAddress, error instanceof Error ? error.message : error);
        }
    }
    return summary;
}
async function defaultListWallets() {
    const { listTrackedLpWallets } = await import('@swat/db');
    const wallets = await listTrackedLpWallets({ limit: 500 });
    return wallets.map((wallet) => ({
        id: wallet.id,
        chain: wallet.chain,
        walletAddress: wallet.walletAddress
    }));
}
export { trackLpWallet, untrackLpWallet };
//# sourceMappingURL=wallet-indexer.js.map