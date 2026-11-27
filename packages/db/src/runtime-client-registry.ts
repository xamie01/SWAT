import type { PoolClient } from 'pg';

export interface ConnectablePool {
  connect(): Promise<PoolClient>;
}

const runtimePoolClients = new WeakSet<PoolClient>();
const readPools = new WeakMap<ConnectablePool, ConnectablePool>();

export function markRuntimePoolClient(client: PoolClient): void {
  runtimePoolClients.add(client);
}

export function isRuntimePoolClient(client: PoolClient): boolean {
  return runtimePoolClients.has(client);
}

export function registerReadPool(writePool: ConnectablePool, readPool: ConnectablePool): void {
  readPools.set(writePool, readPool);
}

export function resolveReadPool(writePool: ConnectablePool): {
  pool: ConnectablePool;
  isDistinctReplica: boolean;
} {
  const registered = readPools.get(writePool);
  if (registered && registered !== writePool) {
    return { pool: registered, isDistinctReplica: true };
  }
  return { pool: writePool, isDistinctReplica: false };
}
