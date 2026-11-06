export function createDiscoveryRunner(dependencies) {
    const logger = dependencies.logger ?? {
        info: (message) => console.log(message),
        error: (message, error) => console.error(message, error)
    };
    let discoveryRunning = false;
    async function ingestDiscoveredWallets(addresses, source, seedValue) {
        let ingested = 0;
        for (const address of addresses) {
            try {
                const wallet = await dependencies.upsertWallet({
                    address,
                    source: 'discovered',
                    discoveryMethod: source
                });
                await dependencies.enqueueBackfill(wallet.address, wallet.chain);
                ingested++;
            }
            catch (error) {
                logger.error(`[discovery] Failed to ingest and enqueue ${address}:`, error);
            }
        }
        await dependencies.logDiscoveryRun(source, seedValue, ingested);
        return ingested;
    }
    async function runFundingGraphExpansion() {
        logger.info('[discovery] Running funding graph expansion...');
        const addresses = await dependencies.findFundedUnknownWallets();
        if (addresses.length === 0) {
            logger.info('[discovery] No new wallets found from funding graph.');
            return 0;
        }
        const ingested = await ingestDiscoveredWallets(addresses, 'funding', 'elite_wallets');
        logger.info(`[discovery] Ingested ${ingested} wallets from funding graph.`);
        return ingested;
    }
    async function runCounterpartyDiscovery() {
        logger.info('[discovery] Running counterparty discovery...');
        const addresses = await dependencies.findFrequentCounterparties();
        if (addresses.length === 0) {
            logger.info('[discovery] No new counterparties found.');
            return 0;
        }
        const ingested = await ingestDiscoveredWallets(addresses, 'counterparty', 'elite_wallets');
        logger.info(`[discovery] Ingested ${ingested} wallets from counterparties.`);
        return ingested;
    }
    async function runNightlyDiscovery() {
        logger.info('[discovery] Starting nightly discovery batch...');
        await runFundingGraphExpansion();
        await runCounterpartyDiscovery();
        logger.info('[discovery] Batch complete.');
    }
    async function runNightlyDiscoverySafe() {
        if (discoveryRunning) {
            logger.info('[discovery] run already in progress, ignoring trigger.');
            return 'skipped';
        }
        discoveryRunning = true;
        try {
            await runNightlyDiscovery();
            return 'completed';
        }
        catch (error) {
            logger.error('[discovery] run failed', error);
            return 'failed';
        }
        finally {
            discoveryRunning = false;
        }
    }
    return {
        ingestDiscoveredWallets,
        runFundingGraphExpansion,
        runCounterpartyDiscovery,
        runNightlyDiscoverySafe
    };
}
//# sourceMappingURL=runner.js.map