import { parseExecutionMode, parseLiveEnabledChains } from '@swat/shared';
import { query } from './client.js';
import { getActiveCertifiedChains } from './chain-certifications.js';
const EXECUTION_CONFIG_CACHE_TTL_MS = 30_000;
const executionChains = new Set(['solana', 'polygon', 'robinhood-chain', 'base', 'ethereum', 'bsc']);
const executionConfigKeys = new Set(['solana', 'polygon', 'robinhood-chain', 'base', 'ethereum', 'bsc', '*']);
const executionModes = new Set(['off', 'paper', 'live', 'live+shadow']);
const failClosedConfig = Object.freeze({
    solana: 'paper',
    polygon: 'paper',
    'robinhood-chain': 'paper',
    base: 'paper',
    ethereum: 'paper',
    bsc: 'paper'
});
let cachedConfig = null;
let configLoad = null;
let cacheGeneration = 0;
function parseDatabaseConfig(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {
            config: failClosedConfig,
            reason: 'Database execution configuration is invalid; fail-closed to paper'
        };
    }
    const entries = Object.entries(value);
    const isValid = entries.every(([key, mode]) => (executionConfigKeys.has(key)
        && typeof mode === 'string'
        && executionModes.has(mode)
        && (key !== '*' || mode === 'off')));
    if (!isValid) {
        return {
            config: failClosedConfig,
            reason: 'Database execution configuration is invalid; fail-closed to paper'
        };
    }
    return { config: Object.freeze(Object.fromEntries(entries)) };
}
async function loadExecutionConfig() {
    const rows = await query(`SELECT value FROM config WHERE key = 'execution_config'`);
    if (rows.length === 0)
        return { config: null };
    return parseDatabaseConfig(rows[0]?.value);
}
async function getExecutionConfigSnapshot() {
    const now = Date.now();
    if (cachedConfig && now - cachedConfig.timestamp < EXECUTION_CONFIG_CACHE_TTL_MS) {
        return cachedConfig.snapshot;
    }
    if (configLoad?.generation === cacheGeneration)
        return configLoad.promise;
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
    }
    finally {
        if (configLoad?.promise === promise)
            configLoad = null;
    }
}
/** Retrieves the validated execution configuration with a maximum 30-second TTL. */
export async function getExecutionConfig() {
    return (await getExecutionConfigSnapshot()).config;
}
function requestedModeForChain(chain, dbConfig) {
    const dbMode = dbConfig?.[chain];
    if (dbMode !== undefined)
        return dbMode;
    const envKey = `TRADING_MODE_${chain.replace(/-/g, '_').toUpperCase()}`;
    const chainMode = process.env[envKey];
    if (chainMode !== undefined)
        return parseExecutionMode(chainMode);
    return parseExecutionMode(process.env.TRADING_MODE);
}
function resolveMode(chain, requestedMode, activeCertifications, globalOff, configReason) {
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
export async function resolveChainModes(chains) {
    const [snapshot, activeCertifications] = await Promise.all([
        getExecutionConfigSnapshot(),
        getActiveCertifiedChains()
    ]);
    const globalOff = snapshot.config?.['*'] === 'off';
    const resolutions = {};
    for (const chain of chains) {
        const requestedMode = requestedModeForChain(chain, snapshot.config);
        resolutions[chain] = resolveMode(chain, requestedMode, activeCertifications, globalOff, snapshot.reason);
    }
    return resolutions;
}
/** Resolves one chain using DB, chain env, legacy env, then paper precedence. */
export async function resolveChainMode(chain) {
    return (await resolveChainModes([chain]))[chain];
}
/** Atomically changes one requested chain mode and invalidates this process's cache. */
export async function setChainExecutionMode(chain, mode) {
    if (!executionChains.has(chain) || !executionModes.has(mode)) {
        throw new Error('Invalid execution mode update');
    }
    await query(`INSERT INTO config (key, value)
     VALUES ('execution_config', jsonb_build_object($1::text, $2::text))
     ON CONFLICT (key) DO UPDATE SET
       value = CASE
         WHEN jsonb_typeof(config.value) = 'object' THEN config.value
         ELSE '{}'::jsonb
       END || jsonb_build_object($1::text, $2::text),
       updated_at = NOW()`, [chain, mode]);
    clearExecutionConfigCache();
}
/** Replaces all requested modes with the atomic, fail-closed global switch. */
export async function activateAllChainEmergencyOff() {
    await query(`INSERT INTO config (key, value)
     VALUES ('execution_config', jsonb_build_object($1::text, $2::text))
     ON CONFLICT (key) DO UPDATE SET
       value = EXCLUDED.value,
       updated_at = NOW()`, ['*', 'off']);
    clearExecutionConfigCache();
}
/** Resets the in-memory cache for tests and successful hot mutations. */
export function clearExecutionConfigCache() {
    cacheGeneration += 1;
    cachedConfig = null;
    configLoad = null;
}
//# sourceMappingURL=execution-config.js.map