import type { Chain } from '@swat/shared';

export interface SharedCacheRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  mget(...keys: string[]): Promise<Array<string | null>>;
}

export interface GlobalMasterRow {
  address: string;
  chain: string;
  nickname: string | null;
  composite_score: number | null;
  tier: string | null;
  win_rate: number | null;
  realized_roi: number | null;
}

export interface GlobalWalletStatRow {
  address: string;
  chain: Chain;
  status: string;
  composite_score: number | null;
  tier: string | null;
  win_rate: number | null;
  realized_roi: number | null;
  total_trades: number | null;
  last_active: string | Date | null;
}

export interface SharedReadCache {
  getMastersTop20(loader: () => Promise<GlobalMasterRow[]>): Promise<GlobalMasterRow[]>;
  getWalletStats(
    addresses: readonly string[],
    loader: (missingAddresses: string[]) => Promise<GlobalWalletStatRow[]>
  ): Promise<GlobalWalletStatRow[]>;
}

const MASTERS_KEY = 'swat:cache:masters:top20:v1';
const WALLET_KEY_PREFIX = 'swat:cache:wallet:v1:';

export function createSharedReadCache(
  redis: Partial<SharedCacheRedis> | null | undefined,
  options: { ttlSeconds?: number } = {}
): SharedReadCache {
  const configured = options.ttlSeconds ?? Number(process.env.SHARED_READ_CACHE_TTL_SECONDS ?? 12);
  const ttlSeconds = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 0;
  const canGet = Boolean(ttlSeconds > 0 && redis && typeof redis.get === 'function' && typeof redis.set === 'function');
  const canMget = Boolean(ttlSeconds > 0 && redis && typeof redis.mget === 'function' && typeof redis.set === 'function');

  let mastersInFlight: Promise<GlobalMasterRow[]> | null = null;
  const walletBatchInFlight = new Map<string, Promise<GlobalWalletStatRow[]>>();

  return {
    async getMastersTop20(loader) {
      if (canGet && redis?.get) {
        try {
          const cached = await redis.get(MASTERS_KEY);
          if (cached) {
            const parsed = JSON.parse(cached) as GlobalMasterRow[];
            if (Array.isArray(parsed)) return parsed;
          }
        } catch {
          // Fall open to Postgres loader on Redis errors.
        }
      }

      if (mastersInFlight) return mastersInFlight;

      mastersInFlight = (async () => {
        const rows = await loader();
        if (canGet && redis?.set) {
          try {
            await redis.set(MASTERS_KEY, JSON.stringify(rows), 'EX', ttlSeconds);
          } catch {
            // Non-fatal.
          }
        }
        return rows;
      })();

      try {
        return await mastersInFlight;
      } finally {
        mastersInFlight = null;
      }
    },

    async getWalletStats(addresses, loader) {
      const unique = [...new Set(addresses)];
      if (unique.length === 0) return [];

      const hitMap = new Map<string, GlobalWalletStatRow>();
      const missing: string[] = [];

      if (canMget && redis?.mget) {
        try {
          const rawValues = await redis.mget(...unique.map((addr) => `${WALLET_KEY_PREFIX}${addr}`));
          unique.forEach((addr, idx) => {
            const raw = rawValues[idx];
            if (!raw) {
              missing.push(addr);
              return;
            }
            try {
              const parsed = JSON.parse(raw) as GlobalWalletStatRow;
              if (parsed && typeof parsed.address === 'string') {
                hitMap.set(addr, parsed);
              } else {
                missing.push(addr);
              }
            } catch {
              missing.push(addr);
            }
          });
        } catch {
          missing.splice(0, missing.length, ...unique);
        }
      } else {
        missing.push(...unique);
      }

      if (missing.length > 0) {
        const missingKey = [...missing].sort().join(',');
        let pending = walletBatchInFlight.get(missingKey);
        if (!pending) {
          pending = (async () => {
            const fetched = await loader(missing);
            if (canGet && redis?.set && fetched.length > 0) {
              await Promise.allSettled(
                fetched.map((row) => redis.set!(`${WALLET_KEY_PREFIX}${row.address}`, JSON.stringify(row), 'EX', ttlSeconds))
              );
            }
            return fetched;
          })();
          walletBatchInFlight.set(missingKey, pending);
        }
        try {
          const fetchedRows = await pending;
          for (const row of fetchedRows) {
            hitMap.set(row.address, row);
          }
        } finally {
          if (walletBatchInFlight.get(missingKey) === pending) {
            walletBatchInFlight.delete(missingKey);
          }
        }
      }

      return unique.map((addr) => hitMap.get(addr)).filter((row): row is GlobalWalletStatRow => Boolean(row));
    }
  };
}
