import cron from 'node-cron';
import { findFundedUnknownWallets, findFrequentCounterparties, logDiscoveryRun, upsertWallet } from '@swat/db';
async function ingestDiscoveredWallets(addresses, source, seedValue) {
    let ingested = 0;
    for (const address of addresses) {
        try {
            await upsertWallet({ address, source: 'discovered' });
            ingested++;
        }
        catch (e) {
            console.error(`[discovery] Failed to ingest ${address}:`, e);
        }
    }
    await logDiscoveryRun(source, seedValue, ingested);
    return ingested;
}
export async function runFundingGraphExpansion() {
    console.log('[discovery] Running funding graph expansion...');
    const addresses = await findFundedUnknownWallets();
    if (addresses.length > 0) {
        const ingested = await ingestDiscoveredWallets(addresses, 'funding', 'elite_wallets');
        console.log(`[discovery] Ingested ${ingested} wallets from funding graph.`);
    }
    else {
        console.log('[discovery] No new wallets found from funding graph.');
    }
}
export async function runCounterpartyDiscovery() {
    console.log('[discovery] Running counterparty discovery...');
    const addresses = await findFrequentCounterparties();
    if (addresses.length > 0) {
        const ingested = await ingestDiscoveredWallets(addresses, 'counterparty', 'elite_wallets');
        console.log(`[discovery] Ingested ${ingested} wallets from counterparties.`);
    }
    else {
        console.log('[discovery] No new counterparties found.');
    }
}
async function runNightlyDiscovery() {
    console.log('[discovery] Starting nightly discovery batch...');
    await runFundingGraphExpansion();
    await runCounterpartyDiscovery();
    console.log('[discovery] Batch complete.');
}
cron.schedule('30 2 * * *', () => {
    runNightlyDiscovery().catch(console.error);
}, {
    timezone: "UTC"
});
console.log('[discovery] Service running. Scheduled at 02:30 UTC daily.');
if (process.env.RUN_ON_STARTUP === 'true') {
    runNightlyDiscovery();
}
//# sourceMappingURL=index.js.map