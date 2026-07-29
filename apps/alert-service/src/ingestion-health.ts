import {
  buildIngestionHealthSnapshots,
  type Chain,
  type IngestionHealthSnapshot,
  type RawIngestionHealth
} from '@swat/shared';

export type IngestionAlertTarget = 'healthy' | 'stale';

type MonitorDependencies = {
  loadHealth: () => Promise<RawIngestionHealth[]>;
  reserve: (chain: Chain, target: IngestionAlertTarget) => Promise<string | null>;
  complete: (
    chain: Chain,
    reservation: string,
    target: IngestionAlertTarget
  ) => Promise<boolean>;
  release: (chain: Chain, reservation: string) => Promise<void>;
  send: (message: string) => Promise<void>;
  now?: () => Date;
  logError?: (message: string, error: unknown) => void;
};

export type IngestionMonitorResult = {
  chain: Chain;
  target: IngestionAlertTarget;
  action: 'none' | 'sent' | 'failed';
};

function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'no tracked event';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining === 0 ? `${minutes}m` : `${minutes}m ${remaining}s`;
}

function formatRatio(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

export function formatIngestionOpsMessage(
  health: IngestionHealthSnapshot,
  target: IngestionAlertTarget
): string {
  const recovery = target === 'healthy';
  const heading = recovery
    ? 'SWAT INGESTION RECOVERY'
    : 'SWAT INGESTION OPS ALERT';
  const state = recovery
    ? 'HEALTHY'
    : health.status === 'empty'
      ? 'NO DATA'
      : 'STALE';

  return [
    `<b>${heading}</b>`,
    '',
    `<b>Chain:</b> ${health.chain}`,
    `<b>State:</b> ${state}`,
    `<b>Event lag:</b> ${formatDuration(health.lagSeconds)}`,
    `<b>Alert threshold:</b> ${formatDuration(health.staleAfterSeconds)}`,
    `<b>Last event:</b> ${health.lastEventAt ?? 'never'}`,
    `<b>Last batch:</b> ${health.lastBatchAt ?? 'never'}`,
    '',
    `<b>24h inserted:</b> ${health.inserted24h}`,
    `<b>24h skipped:</b> ${health.skipped24h}`,
    `<b>24h failed:</b> ${health.failed24h}`,
    `<b>Insert ratio:</b> ${formatRatio(health.insertRatio)}`
  ].join('\n');
}

export async function checkIngestionHealth(
  dependencies: MonitorDependencies
): Promise<IngestionMonitorResult[]> {
  const now = dependencies.now?.() ?? new Date();
  const snapshots = buildIngestionHealthSnapshots(
    await dependencies.loadHealth(),
    now
  );
  const results: IngestionMonitorResult[] = [];

  for (const health of snapshots) {
    const target: IngestionAlertTarget =
      health.status === 'healthy' ? 'healthy' : 'stale';
    let reservation: string | null = null;
    let sent = false;

    try {
      reservation = await dependencies.reserve(health.chain, target);
      if (!reservation) {
        results.push({ chain: health.chain, target, action: 'none' });
        continue;
      }

      await dependencies.send(formatIngestionOpsMessage(health, target));
      sent = true;
      const completed = await dependencies.complete(
        health.chain,
        reservation,
        target
      );
      if (!completed) {
        throw new Error(`Lost ingestion alert reservation for ${health.chain}`);
      }
      results.push({ chain: health.chain, target, action: 'sent' });
    } catch (error) {
      if (reservation && !sent) {
        await dependencies.release(health.chain, reservation).catch(() => {});
      }
      dependencies.logError?.(
        `[alert-service] ingestion ${target} notification failed for ${health.chain}`,
        error
      );
      results.push({ chain: health.chain, target, action: 'failed' });
    }
  }

  return results;
}
