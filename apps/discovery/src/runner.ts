import type { Chain } from '@swat/shared';

type DiscoveryMethod = 'funding' | 'counterparty';

type DiscoveredWalletInput = {
  address: string;
  source: 'discovered';
  discoveryMethod: DiscoveryMethod;
};

type StoredBackfill = {
  address: string;
  chain: Chain;
  intentId: string;
};

type DiscoveryLogger = {
  info(message: string): void;
  error(message: string, error?: unknown): void;
};

export type DiscoveryRunnerDependencies = {
  findFundedUnknownWallets(): Promise<string[]>;
  findFrequentCounterparties(): Promise<string[]>;
  persistBackfill(wallet: DiscoveredWalletInput): Promise<StoredBackfill>;
  listPendingBackfills(): Promise<StoredBackfill[]>;
  acknowledgeBackfill(intentId: string): Promise<void>;
  enqueueBackfill(address: string, chain: Chain): Promise<void>;
  logDiscoveryRun(source: string, seedValue: string, walletsDiscovered: number): Promise<void>;
  logger?: DiscoveryLogger;
};

export function createDiscoveryRunner(dependencies: DiscoveryRunnerDependencies) {
  const logger = dependencies.logger ?? {
    info: (message: string) => console.log(message),
    error: (message: string, error?: unknown) => console.error(message, error)
  };
  let discoveryRunning = false;

  async function ingestDiscoveredWallets(
    addresses: string[],
    source: DiscoveryMethod,
    seedValue: string
  ) {
    let ingested = 0;

    for (const address of addresses) {
      try {
        const wallet = await dependencies.persistBackfill({
          address,
          source: 'discovered',
          discoveryMethod: source
        });
        await dependencies.enqueueBackfill(wallet.address, wallet.chain);
        await dependencies.acknowledgeBackfill(wallet.intentId);
        ingested++;
      } catch (error) {
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

    const ingested = await ingestDiscoveredWallets(
      addresses,
      'counterparty',
      'elite_wallets'
    );
    logger.info(`[discovery] Ingested ${ingested} wallets from counterparties.`);
    return ingested;
  }

  async function recoverPendingBackfills() {
    const intents = await dependencies.listPendingBackfills();
    let enqueued = 0;
    for (const intent of intents) {
      try {
        await dependencies.enqueueBackfill(intent.address, intent.chain);
        await dependencies.acknowledgeBackfill(intent.intentId);
        enqueued++;
      } catch (error) {
        logger.error(`[discovery] Backfill intent ${intent.intentId} remains pending:`, error);
      }
    }
    return enqueued;
  }

  async function runNightlyDiscovery() {
    logger.info('[discovery] Starting nightly discovery batch...');
    await recoverPendingBackfills();
    await runFundingGraphExpansion();
    await runCounterpartyDiscovery();
    logger.info('[discovery] Batch complete.');
  }

  async function runNightlyDiscoverySafe(): Promise<'completed' | 'skipped' | 'failed'> {
    if (discoveryRunning) {
      logger.info('[discovery] run already in progress, ignoring trigger.');
      return 'skipped';
    }

    discoveryRunning = true;
    try {
      await runNightlyDiscovery();
      return 'completed';
    } catch (error) {
      logger.error('[discovery] run failed', error);
      return 'failed';
    } finally {
      discoveryRunning = false;
    }
  }

  return {
    ingestDiscoveredWallets,
    recoverPendingBackfills,
    runFundingGraphExpansion,
    runCounterpartyDiscovery,
    runNightlyDiscoverySafe
  };
}
