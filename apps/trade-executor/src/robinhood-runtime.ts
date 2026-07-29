import { fetchDexScreenerLiquidity } from '@swat/shared';
import type { Hex } from 'viem';
import {
  type RobinhoodPendingStore,
  type PendingRobinhoodSubmission,
  type RobinhoodFilledResult,
  type RobinhoodQuoteAdapter,
  type RobinhoodReconciliationResult,
  type RobinhoodSafetyAssessment,
  type RobinhoodOrder,
  type RobinhoodRouteResult
} from './robinhood.js';
import {
  decodeRuntimeValue,
  encodeRuntimeValue,
  type RedisHashClient
} from './runtime-codec.js';

const DEFAULT_STORE_KEY = 'swat:trade-executor:pending:robinhood:v1';

type StoredRobinhoodState =
  | { state: 'pending'; pending: PendingRobinhoodSubmission }
  | { state: 'resolved'; resolution: RobinhoodReconciliationResult };

type LegacyPendingRobinhoodSubmission = Omit<PendingRobinhoodSubmission, 'feeTier'> & {
  feeTier?: number | null;
};

type LegacyRobinhoodFilledResult = Omit<RobinhoodFilledResult, 'feeTier'> & {
  feeTier?: number | null;
};

type StoredRobinhoodWireState =
  | { state: 'pending'; pending: LegacyPendingRobinhoodSubmission }
  | {
      state: 'resolved';
      resolution:
        | LegacyRobinhoodFilledResult
        | Exclude<RobinhoodReconciliationResult, RobinhoodFilledResult>;
    };

function decodeStoredRobinhoodState(encoded: string): StoredRobinhoodState {
  const stored = decodeRuntimeValue<StoredRobinhoodWireState>(encoded);
  if (stored.state === 'pending') {
    return {
      state: 'pending',
      pending: {
        ...stored.pending,
        feeTier: stored.pending.feeTier ?? null
      }
    };
  }
  if (stored.resolution.status === 'filled') {
    return {
      state: 'resolved',
      resolution: {
        ...stored.resolution,
        feeTier: stored.resolution.feeTier ?? null
      }
    };
  }
  return { state: 'resolved', resolution: stored.resolution };
}

export function createRedisRobinhoodPendingStore(
  redis: RedisHashClient,
  key = DEFAULT_STORE_KEY
): RobinhoodPendingStore {
  async function read(clientOrderId: string): Promise<StoredRobinhoodState | null> {
    const encoded = await redis.hget(key, clientOrderId);
    return encoded ? decodeStoredRobinhoodState(encoded) : null;
  }

  return {
    async findUnresolved(clientOrderId) {
      const stored = await read(clientOrderId);
      return stored?.state === 'pending' ? stored.pending : null;
    },
    async findResolution(clientOrderId) {
      const stored = await read(clientOrderId);
      return stored?.state === 'resolved' ? stored.resolution : null;
    },
    async listUnresolved() {
      const values = await redis.hgetall(key);
      return Object.values(values).flatMap((encoded) => {
        const stored = decodeStoredRobinhoodState(encoded);
        return stored.state === 'pending' ? [stored.pending] : [];
      });
    },
    async save(record) {
      await redis.hset(key, record.clientOrderId, encodeRuntimeValue({
        state: 'pending',
        pending: record
      } satisfies StoredRobinhoodState));
    },
    async resolve(clientOrderId, resolution) {
      await redis.hset(key, clientOrderId, encodeRuntimeValue({
        state: 'resolved',
        resolution
      } satisfies StoredRobinhoodState));
    }
  };
}

type SafetyContext = {
  order: RobinhoodOrder;
  route: Extract<RobinhoodRouteResult, { status: 'route' }>;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
};

export function createRobinhoodSafetyAssessment(options: {
  quote: RobinhoodQuoteAdapter;
  minimumLiquidityUsd: number;
  liquidityLookup?: (token: string) => Promise<number | null>;
  readOwner?: (token: `0x${string}`) => Promise<`0x${string}` | null>;
}): (context: SafetyContext) => Promise<RobinhoodSafetyAssessment> {
  if (!Number.isFinite(options.minimumLiquidityUsd) || options.minimumLiquidityUsd <= 0) {
    throw new Error('Robinhood minimum liquidity must be positive');
  }
  const liquidityLookup = options.liquidityLookup
    ?? ((token: string) => fetchDexScreenerLiquidity(token, 'robinhood-chain'));

  return async (context) => {
    let sellSimulation: RobinhoodSafetyAssessment['checks'][number];
    try {
      const reverseAmount = context.order.direction === 'sell'
        ? context.route.amountOut
        : await options.quote(
            context.tokenOut,
            context.tokenIn,
            context.route.amountOut,
            context.route.fee
          );
      sellSimulation = reverseAmount > 0n
        ? {
            name: 'sell_simulation',
            status: 'pass',
            reliable: true,
            evidence: context.order.direction === 'sell'
              ? `sell route returned ${reverseAmount.toString()} base units`
              : `reverse route returned ${reverseAmount.toString()} base units`
          }
        : {
            name: 'sell_simulation',
            status: 'fail',
            reliable: true,
            evidence: 'reverse route returned zero output'
          };
    } catch (error) {
      sellSimulation = {
        name: 'sell_simulation',
        status: 'unknown',
        reliable: false,
        evidence: error instanceof Error ? error.message : 'reverse route lookup failed'
      };
    }

    const liquidityUsd = await liquidityLookup(context.order.token).catch(() => null);
    const liquidity = liquidityUsd === null
      ? {
          name: 'liquidity' as const,
          status: 'unknown' as const,
          reliable: false,
          evidence: 'liquidity provider returned no chain-matched evidence'
        }
      : liquidityUsd >= options.minimumLiquidityUsd
        ? {
            name: 'liquidity' as const,
            status: 'pass' as const,
            reliable: true,
            evidence: `$${liquidityUsd.toFixed(2)} >= $${options.minimumLiquidityUsd.toFixed(2)}`
          }
        : {
            name: 'liquidity' as const,
            status: 'fail' as const,
            reliable: true,
            evidence: `$${liquidityUsd.toFixed(2)} < $${options.minimumLiquidityUsd.toFixed(2)}`
          };

    let ownership: RobinhoodSafetyAssessment['checks'][number] = {
      name: 'ownership_admin',
      status: 'unknown',
      reliable: false,
      evidence: 'owner() evidence is unavailable for this contract'
    };
    if (options.readOwner) {
      try {
        const owner = await options.readOwner(context.order.token);
        if (owner) {
          const renounced = /^0x0{40}$/i.test(owner);
          ownership = {
            name: 'ownership_admin',
            status: renounced ? 'pass' : 'fail',
            reliable: true,
            evidence: renounced ? 'owner() is the zero address' : `owner() is ${owner}`
          };
        }
      } catch (error) {
        ownership = {
          name: 'ownership_admin',
          status: 'unknown',
          reliable: false,
          evidence: error instanceof Error ? error.message : 'owner() lookup failed'
        };
      }
    }

    return {
      checks: [
        sellSimulation,
        liquidity,
        ownership,
        {
          name: 'source_verification',
          status: 'unknown',
          reliable: false,
          evidence: 'no reviewed Robinhood explorer source-verification provider is configured'
        },
        {
          name: 'holder_concentration',
          status: 'unknown',
          reliable: false,
          evidence: 'no reviewed Robinhood holder-distribution provider is configured'
        }
      ]
    };
  };
}

export type RobinhoodTerminalPersistence = {
  clientOrderId: string;
  transactionHash?: Hex;
  status: 'filled' | 'failed';
  reason?: string;
};
