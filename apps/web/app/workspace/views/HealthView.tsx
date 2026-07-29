'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Chain = 'solana' | 'polygon' | 'robinhood-chain';
type HealthStatus = 'healthy' | 'stale' | 'empty';

type IngestionItem = {
  chain: Chain;
  status: HealthStatus;
  lastEventAt: string | null;
  lastBatchAt: string | null;
  lastSuccessAt: string | null;
  lagSeconds: number | null;
  batchLagSeconds: number | null;
  staleAfterSeconds: number;
  targetLagSeconds: number;
  inserted24h: number;
  skipped24h: number;
  failed24h: number;
  insertRatio: number | null;
};

type IngestionResponse = {
  generatedAt: string;
  items: IngestionItem[];
};

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : 'http://localhost:3001');
const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? 'swat-dev-key';

const CHAIN_META: Record<Chain, {
  label: string;
  accent: string;
  dot: string;
}> = {
  solana: {
    label: 'Solana',
    accent: 'border-solana-teal',
    dot: 'bg-solana-teal'
  },
  polygon: {
    label: 'Polygon',
    accent: 'border-polymarket-violet',
    dot: 'bg-polymarket-violet'
  },
  'robinhood-chain': {
    label: 'Robinhood Chain',
    accent: 'border-robinhood-amber',
    dot: 'bg-robinhood-amber'
  }
};

const CHAINS: Chain[] = ['solana', 'polygon', 'robinhood-chain'];

const STATUS_META: Record<HealthStatus, {
  label: string;
  icon: string;
  text: string;
  background: string;
}> = {
  healthy: {
    label: 'Healthy',
    icon: 'check_circle',
    text: 'text-status-success',
    background: 'bg-status-success/10'
  },
  stale: {
    label: 'Stale',
    icon: 'warning',
    text: 'text-status-warning',
    background: 'bg-status-warning/10'
  },
  empty: {
    label: 'No data',
    icon: 'error_outline',
    text: 'text-status-error',
    background: 'bg-status-error/10'
  }
};

function emptyItem(chain: Chain): IngestionItem {
  return {
    chain,
    status: 'empty',
    lastEventAt: null,
    lastBatchAt: null,
    lastSuccessAt: null,
    lagSeconds: null,
    batchLagSeconds: null,
    staleAfterSeconds: 0,
    targetLagSeconds: 0,
    inserted24h: 0,
    skipped24h: 0,
    failed24h: 0,
    insertRatio: null
  };
}

function isChain(value: unknown): value is Chain {
  return typeof value === 'string' && CHAINS.includes(value as Chain);
}

function isStatus(value: unknown): value is HealthStatus {
  return value === 'healthy' || value === 'stale' || value === 'empty';
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeItem(value: unknown, chain: Chain): IngestionItem {
  if (!value || typeof value !== 'object') return emptyItem(chain);
  const raw = value as Record<string, unknown>;
  if (raw.chain !== chain || !isStatus(raw.status)) return emptyItem(chain);

  const staleAfterSeconds = finiteNumber(raw.staleAfterSeconds);
  const targetLagSeconds = finiteNumber(raw.targetLagSeconds);
  const inserted24h = finiteNumber(raw.inserted24h);
  const skipped24h = finiteNumber(raw.skipped24h);
  const failed24h = finiteNumber(raw.failed24h);
  if (
    staleAfterSeconds === null
    || targetLagSeconds === null
    || inserted24h === null
    || skipped24h === null
    || failed24h === null
  ) {
    return emptyItem(chain);
  }

  return {
    chain,
    status: raw.status,
    lastEventAt: typeof raw.lastEventAt === 'string' ? raw.lastEventAt : null,
    lastBatchAt: typeof raw.lastBatchAt === 'string' ? raw.lastBatchAt : null,
    lastSuccessAt: typeof raw.lastSuccessAt === 'string' ? raw.lastSuccessAt : null,
    lagSeconds: finiteNumber(raw.lagSeconds),
    batchLagSeconds: finiteNumber(raw.batchLagSeconds),
    staleAfterSeconds,
    targetLagSeconds,
    inserted24h: Math.max(0, Math.trunc(inserted24h)),
    skipped24h: Math.max(0, Math.trunc(skipped24h)),
    failed24h: Math.max(0, Math.trunc(failed24h)),
    insertRatio: finiteNumber(raw.insertRatio)
  };
}

function normalizeResponse(value: unknown): IngestionResponse {
  if (!value || typeof value !== 'object') throw new Error('Invalid ingestion health response');
  const raw = value as Record<string, unknown>;
  if (typeof raw.generatedAt !== 'string' || !Array.isArray(raw.items)) {
    throw new Error('Incomplete ingestion health response');
  }
  const byChain = new Map(
    raw.items
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .filter((item) => isChain(item.chain))
      .map((item) => [item.chain as Chain, item])
  );
  return {
    generatedAt: raw.generatedAt,
    items: CHAINS.map((chain) => normalizeItem(byChain.get(chain), chain))
  };
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return 'No event recorded';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function formatTarget(seconds: number): string {
  if (seconds < 60) return `< ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `< ${minutes}m`;
  return `< ${Math.floor(minutes / 60)}h`;
}

function formatRatio(value: number | null): string {
  return value === null ? 'No data' : `${(value * 100).toFixed(2)}%`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'No event recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Invalid timestamp' : `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return 'Not refreshed';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Invalid refresh time' : `${date.toISOString().slice(11, 19)} UTC`;
}

function overallStatus(items: IngestionItem[], error: string | null): {
  label: string;
  text: string;
  background: string;
  icon: string;
} {
  if (error) {
    return {
      label: 'Telemetry unavailable',
      text: 'text-status-error',
      background: 'bg-status-error/10',
      icon: 'cloud_off'
    };
  }
  if (items.length !== CHAINS.length) {
    return {
      label: 'Awaiting telemetry',
      text: 'text-on-surface-variant',
      background: 'bg-surface-container-high',
      icon: 'hourglass_empty'
    };
  }
  if (items.some((item) => item.status === 'empty')) {
    return {
      label: 'No ingestion evidence',
      text: 'text-status-error',
      background: 'bg-status-error/10',
      icon: 'error_outline'
    };
  }
  if (items.some((item) => item.status === 'stale')) {
    return {
      label: 'Attention required',
      text: 'text-status-warning',
      background: 'bg-status-warning/10',
      icon: 'warning'
    };
  }
  return {
    label: 'All chains healthy',
    text: 'text-status-success',
    background: 'bg-status-success/10',
    icon: 'check_circle'
  };
}

export default function HealthView() {
  const [items, setItems] = useState<IngestionItem[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshHealth = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`${API_BASE}/v1/health/ingestion`, {
        cache: 'no-store',
        headers: { 'X-Api-Key': API_KEY }
      });
      if (!response.ok) throw new Error(`Health endpoint returned ${response.status}`);
      const data = normalizeResponse(await response.json());
      setItems(data.items);
      setGeneratedAt(data.generatedAt);
      setError(null);
    } catch (requestError) {
      console.error('[web] ingestion health request failed', requestError);
      setError('Unable to load current ingestion telemetry.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refreshHealth();
    const interval = window.setInterval(() => void refreshHealth(), 30_000);
    return () => window.clearInterval(interval);
  }, [refreshHealth]);

  const summary = useMemo(() => {
    const healthy = items.filter((item) => item.status === 'healthy').length;
    const attention = items.filter((item) => item.status !== 'healthy').length;
    const events = items.reduce((total, item) => total + item.inserted24h + item.skipped24h + item.failed24h, 0);
    const failures = items.reduce((total, item) => total + item.failed24h, 0);
    const maxLag = items.reduce<number | null>((max, item) => {
      if (item.lagSeconds === null) return max;
      return max === null ? item.lagSeconds : Math.max(max, item.lagSeconds);
    }, null);
    return { healthy, attention, events, failures, maxLag };
  }, [items]);

  const status = overallStatus(items, error);

  const exportLogs = () => {
    if (items.length === 0) return;
    const header = 'chain,status,last_event_at,last_batch_at,inserted_24h,skipped_24h,failed_24h,insert_ratio';
    const rows = items.map((item) => [
      item.chain,
      item.status,
      item.lastEventAt ?? '',
      item.lastBatchAt ?? '',
      item.inserted24h,
      item.skipped24h,
      item.failed24h,
      item.insertRatio ?? ''
    ].join(','));
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ingestion-health.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-[1440px] mx-auto p-6 space-y-6">
      <div className="flex flex-col gap-4 border-b border-border-subtle pb-6 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-2 text-on-surface-variant mb-1">
            <span className="material-symbols-outlined text-[16px]">monitor_heart</span>
            <span className="text-[10px] font-bold uppercase tracking-widest">Live API telemetry</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-bold text-primary">Health Dashboard</h2>
            <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ${status.background} ${status.text}`}>
              <span className="material-symbols-outlined text-[14px]">{status.icon}</span>
              {status.label}
            </span>
          </div>
          <p className="mt-1 text-xs text-on-surface-variant">
            Last response: <span className="font-mono">{formatUpdatedAt(generatedAt)}</span>
            {refreshing ? ' | Refreshing...' : ' | Refreshes every 30 seconds'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={exportLogs}
            disabled={items.length === 0}
            className="flex items-center gap-2 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-surface-container-low disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            Export CSV
          </button>
          <button
            onClick={() => void refreshHealth()}
            disabled={refreshing}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-[18px] ${refreshing ? 'animate-spin' : ''}`}>refresh</span>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-status-error/30 bg-status-error/5 px-4 py-3 text-sm text-status-error" role="alert">
          <span className="material-symbols-outlined text-[18px]">error</span>
          <span>{error} Existing rows, when present, remain visible and are not treated as current.</span>
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-border-subtle bg-surface-container-lowest shadow-sm">
        <div className="border-b border-border-subtle bg-surface-container-low/30 px-6 py-4">
          <h3 className="flex items-center gap-2 text-sm font-bold text-primary">
            <span className="material-symbols-outlined text-primary">lan</span>
            Operational Status
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead className="bg-surface-container-low/50">
              <tr className="border-b border-border-subtle text-[10px] font-bold tracking-wider text-on-surface-variant">
                <th className="px-6 py-3">CHAIN</th>
                <th className="px-6 py-3">STATUS</th>
                <th className="px-6 py-3">LAST EVENT</th>
                <th className="px-6 py-3">BATCH LAG</th>
                <th className="px-6 py-3 text-right">24H STATS (I/S/F)</th>
                <th className="px-6 py-3">RATIO</th>
                <th className="px-6 py-3">TARGET LAG</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {loading && items.length === 0 ? (
                <tr>
                  <td className="px-6 py-10 text-center text-sm text-on-surface-variant" colSpan={7}>Loading ingestion telemetry...</td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td className="px-6 py-10 text-center text-sm font-semibold text-status-error" colSpan={7}>No ingestion telemetry is available.</td>
                </tr>
              ) : (
                items.map((item) => {
                  const chain = CHAIN_META[item.chain];
                  const itemStatus = STATUS_META[item.status];
                  const ratioWidth = item.insertRatio === null ? 0 : Math.min(100, Math.max(0, item.insertRatio * 100));
                  return (
                    <tr key={item.chain} className="transition-colors hover:bg-surface-container-low/20">
                      <td className={`border-l-4 px-6 py-4 ${chain.accent}`}>
                        <div className="flex items-center gap-2">
                          <div className={`h-2 w-2 rounded-full ${chain.dot}`}></div>
                          <span className="font-bold text-primary">{chain.label}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold ${itemStatus.background} ${itemStatus.text}`}>
                          <span className="material-symbols-outlined text-[14px]">{itemStatus.icon}</span>
                          {itemStatus.label}
                        </span>
                      </td>
                      <td className="px-6 py-4 font-mono text-xs" title={formatTimestamp(item.lastEventAt)}>{formatDuration(item.lagSeconds)}</td>
                      <td className={`px-6 py-4 font-mono text-xs ${item.status === 'healthy' ? 'text-status-success' : item.status === 'stale' ? 'text-status-warning' : 'text-status-error'} font-semibold`}>
                        {formatDuration(item.batchLagSeconds)}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex flex-col items-end">
                          <span className="font-mono text-xs">{formatCount(item.inserted24h)} / {formatCount(item.skipped24h)} / {formatCount(item.failed24h)}</span>
                          <div className="mt-1 h-1 w-24 overflow-hidden rounded-full bg-surface-container-high">
                            <div className="h-full bg-status-success" style={{ width: `${ratioWidth}%` }}></div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 font-mono text-xs">{formatRatio(item.insertRatio)}</td>
                      <td className="px-6 py-4 font-medium text-on-surface-variant">{formatTarget(item.targetLagSeconds)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <div className="rounded-xl border border-border-subtle bg-surface-container-lowest p-4 shadow-sm">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">CHAINS MONITORED</p>
          <span className="font-mono text-lg font-bold text-primary">{CHAINS.length}</span>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface-container-lowest p-4 shadow-sm">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">HEALTHY CHAINS</p>
          <span className="font-mono text-lg font-bold text-status-success">{summary.healthy}</span>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface-container-lowest p-4 shadow-sm">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">NEEDS ATTENTION</p>
          <span className={`font-mono text-lg font-bold ${summary.attention > 0 ? 'text-status-error' : 'text-primary'}`}>{summary.attention}</span>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface-container-lowest p-4 shadow-sm">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">EVENTS (24H)</p>
          <span className="font-mono text-lg font-bold text-primary">{formatCount(summary.events)}</span>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface-container-lowest p-4 shadow-sm">
          <p className="mb-1 text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">MAX EVENT LAG</p>
          <span className="font-mono text-lg font-bold text-primary">{formatDuration(summary.maxLag)}</span>
        </div>
      </div>

      <section className="rounded-xl border border-border-subtle bg-surface-container-lowest shadow-sm">
        <div className="border-b border-border-subtle bg-surface-container-low/30 px-6 py-4">
          <h3 className="flex items-center gap-2 text-sm font-bold text-primary">
            <span className="material-symbols-outlined text-primary">fact_check</span>
            Current Ingestion Evidence
          </h3>
        </div>
        <div className="grid grid-cols-1 divide-y divide-border-subtle md:grid-cols-3 md:divide-x md:divide-y-0">
          {items.map((item) => {
            const chain = CHAIN_META[item.chain];
            const itemStatus = STATUS_META[item.status];
            return (
              <div key={item.chain} className="p-6">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <span className="font-bold text-primary">{chain.label}</span>
                  <span className={`text-xs font-semibold ${itemStatus.text}`}>{itemStatus.label}</span>
                </div>
                <dl className="space-y-2 text-xs">
                  <div className="flex justify-between gap-4"><dt className="text-on-surface-variant">Last success</dt><dd className="text-right font-mono">{formatTimestamp(item.lastSuccessAt)}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-on-surface-variant">Batch lag</dt><dd className="text-right font-mono">{formatDuration(item.batchLagSeconds)}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-on-surface-variant">Failures (24h)</dt><dd className="text-right font-mono">{formatCount(item.failed24h)}</dd></div>
                </dl>
              </div>
            );
          })}
          {items.length === 0 && <p className="p-6 text-sm text-status-error">No current chain evidence is available.</p>}
        </div>
      </section>

      <p className="text-right text-[11px] text-on-surface-variant">
        {summary.failures > 0 ? `${formatCount(summary.failures)} failed events in the last 24 hours.` : 'No failed events reported in the last 24 hours.'}
      </p>
    </div>
  );
}
