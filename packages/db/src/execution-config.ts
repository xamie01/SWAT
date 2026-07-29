import type { Chain, ExecutionConfig, ExecutionMode } from '@swat/shared';
import { parseExecutionMode, parseLiveEnabledChains } from '@swat/shared';
import { query } from './client.js';
import { getActiveCertifiedChains } from './chain-certifications.js';

const EXECUTION_CONFIG_CACHE_TTL_MS = 30_000;
const executionChains = new Set<Chain>(['solana', 'polygon', 'robinhood-chain']);
const executionConfigKeys = new Set(['solana', 'polygon', 'robinhood-chain', '*']);
const executionModes = new Set<ExecutionMode>(['off', 'paper', 'live', 'live+shadow']);
const failClosedConfig: ExecutionConfig = Object.freeze({
  solana: 'paper',
  polygon: 'paper',
  'robinhood-chain': 'paper'
});

interface ExecutionConfigSnapshot {
  config: ExecutionConfig | null;
  reason?: string;
}

interface CachedExecutionConfig {
  snapshot: ExecutionConfigSnapshot;
  timestamp: number;
}

let cachedConfig: CachedExecutionConfig | null = null;
let configLoad: { generation: number; promise: Promise<ExecutionConfigSnapshot> } | null = null;
let cacheGeneration = 0;

function parseDatabaseConfig(value: unknown): ExecutionConfigSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      config: failClosedConfig,
      reason: 'Database execution configuration is invalid; fail-closed to paper'
    };
  }

  const entries = Object.entries(value);
  const isValid = entries.every(([key, mode]) => (
    executionConfigKeys.has(key)
      && typeof mode === 'string'
      && executionModes.has(mode as ExecutionMode)
      && (key !== '*' || mode === 'off')
  ));

  if (!isValid) {
    return {
      config: failClosedConfig,
      reason: 'Database execution configuration is invalid; fail-closed to paper'
    };
  }

  return { config: Object.freeze(Object.fromEntries(entries)) as ExecutionConfig };
}

async function loadExecutionConfig(): Promise<ExecutionConfigSnapshot> {
  const rows = await query<{ value: unknown }>(
    `SELECT value FROM config WHERE key = 'execution_config'`
  );

  if (rows.length === 0) return { config: null };
  return parseDatabaseConfig(rows[0]?.value);
}

async function getExecutionConfigSnapshot(): Promise<ExecutionConfigSnapshot> {
  const now = Date.now();
  if (cachedConfig && now - cachedConfig.timestamp < EXECUTION_CONFIG_CACHE_TTL_MS) {
    return cachedConfig.snapshot;
  }

  if (configLoad?.generation === cacheGeneration) return configLoad.promise;

  const generation = cacheGeneration;
  const promise = loadExecutionConfig().then((snapshot) => {
    if (generation === cacheGeneration) {
      cachedConfig = { snapshot, timestamp: Date.now() };
    }
    return snapshot;
  });
  configLoad = { generation, promise };

  try {
    return await promise;
  } finally {
    if (configLoad?.promise === promise) configLoad = null;
  }
}

/** Retrieves the validated execution configuration with a maximum 30-second TTL. */
export async function getExecutionConfig(): Promise<ExecutionConfig | null> {
  return (await getExecutionConfigSnapshot()).config;
}

export interface ChainModeResolution {
  requestedMode: ExecutionMode;
  effectiveMode: ExecutionMode;
  certified: boolean;
  reason?: string;
}

function requestedModeForChain(chain: Chain, dbConfig: ExecutionConfig | null): ExecutionMode {
  const dbMode = dbConfig?.[chain];
  if (dbMode !== undefined) return dbMode;

  const envKey = `TRADING_MODE_${chain.replace(/-/g, '_').toUpperCase()}`;
  const chainMode = process.env[envKey];
  if (chainMode !== undefined) return parseExecutionMode(chainMode);

  return parseExecutionMode(process.env.TRADING_MODE);
}

function resolveMode(
  chain: Chain,
  requestedMode: ExecutionMode,
  activeCertifications: readonly Chain[],
  globalOff: boolean,
  configReason?: string
): ChainModeResolution {
  const liveEnabledChains = parseLiveEnabledChains(process.env.LIVE_ENABLED_CHAINS);
  const operatorEnabled = liveEnabledChains.includes(chain);
  const evidenceCertified = activeCertifications.includes(chain);
  const certified = operatorEnabled && evidenceCertified;

  if (globalOff) {
    return {
      requestedMode,
      effectiveMode: 'off',
      certified,
      reason: 'Global kill switch active (*)'
    };
  }

  if (configReason) {
    return {
      requestedMode: 'paper',
      effectiveMode: 'paper',
      certified,
      reason: configReason
    };
  }

  if (requestedMode === 'live' || requestedMode === 'live+shadow') {
    if (!operatorEnabled) {
      return {
        requestedMode,
        effectiveMode: 'paper',
        certified,
        reason: `Chain ${chain} is not enabled in LIVE_ENABLED_CHAINS`
      };
    }
    if (!evidenceCertified) {
      return {
        requestedMode,
        effectiveMode: 'paper',
        certified,
        reason: `Chain ${chain} has no active reviewed certification record`
      };
    }
  }

  return { requestedMode, effectiveMode: requestedMode, certified };
}

/**
 * Resolves a consistent mode snapshot for multiple chains. One call shares the
 * same DB configuration and certification snapshot without storing a
 * process-global "current chain".
 */
export async function resolveChainModes<const Chains extends readonly Chain[]>(
  chains: Chains
): Promise<Record<Chains[number], ChainModeResolution>> {
  const [snapshot, activeCertifications] = await Promise.all([
    getExecutionConfigSnapshot(),
    getActiveCertifiedChains()
  ]);
  const globalOff = snapshot.config?.['*'] === 'off';
  const resolutions: Partial<Record<Chain, ChainModeResolution>> = {};

  for (const chain of chains) {
    const requestedMode = requestedModeForChain(chain, snapshot.config);
    resolutions[chain] = resolveMode(
      chain,
      requestedMode,
      activeCertifications,
      globalOff,
      snapshot.reason
    );
  }

  return resolutions as Record<Chains[number], ChainModeResolution>;
}

/** Resolves one chain using DB, chain env, legacy env, then paper precedence. */
export async function resolveChainMode(chain: Chain): Promise<ChainModeResolution> {
  return (await resolveChainModes([chain]))[chain];
}

/** Atomically changes one requested chain mode and invalidates this process's cache. */
export async function setChainExecutionMode(chain: Chain, mode: ExecutionMode): Promise<void> {
  if (!executionChains.has(chain) || !executionModes.has(mode)) {
    throw new Error('Invalid execution mode update');
  }

  await query(
    `INSERT INTO config (key, value)
     VALUES ('execution_config', jsonb_build_object($1::text, $2::text))
     ON CONFLICT (key) DO UPDATE SET
       value = CASE
         WHEN jsonb_typeof(config.value) = 'object' THEN config.value
         ELSE '{}'::jsonb
       END || jsonb_build_object($1::text, $2::text),
       updated_at = NOW()`,
    [chain, mode]
  );
  clearExecutionConfigCache();
}

/** Replaces all requested modes with the atomic, fail-closed global switch. */
export async function activateAllChainEmergencyOff(): Promise<void> {
  await query(
    `INSERT INTO config (key, value)
     VALUES ('execution_config', jsonb_build_object($1::text, $2::text))
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = NOW()`,
    ['*', 'off']
  );
  clearExecutionConfigCache();
}

/** Resets the in-memory cache for tests and successful hot mutations. */
export function clearExecutionConfigCache(): void {
  cacheGeneration += 1;
  cachedConfig = null;
  configLoad = null;
}
