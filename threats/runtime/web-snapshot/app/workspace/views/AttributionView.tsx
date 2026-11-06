'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  calculateAttributionSummary,
  formatDate,
  formatMs,
  formatUsd,
  parseAttributionData,
  toFiniteNumber,
  type AttributionData
} from './attribution-model';
import { api } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

const CHAIN_LABELS: Record<string, string> = {
  solana: 'Solana',
  polygon: 'Polymarket',
  'robinhood-chain': 'Robinhood Chain'
};

function ThresholdValue({ value }: { value: unknown }) {
  return (
    <span className="font-mono font-bold text-primary">
      {typeof value === 'number' || typeof value === 'string' ? String(value) : 'Unavailable'}
    </span>
  );
}

export default function AttributionView() {
  const [data, setData] = useState<AttributionData | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAttribution = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = parseAttributionData(await api.get('/v1/trading/attribution', { signal }));
      setData(next);
      setSelectedTradeId((current) =>
        current && next.ledger.some((row) => row.trade_id === current)
          ? current
          : next.ledger[0]?.trade_id ?? null
      );
      setError(null);
    } catch (requestError: unknown) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setError(describeApiError(requestError, 'Attribution data is unavailable'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadAttribution(controller.signal);
    const interval = window.setInterval(() => {
      void loadAttribution(controller.signal);
    }, 30_000);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [loadAttribution]);

  const reportRows = data?.report?.rows ?? [];
  const summary = useMemo(() => calculateAttributionSummary(reportRows), [reportRows]);

  const selectedTrade = data?.ledger.find((row) => row.trade_id === selectedTradeId) ?? null;

  if (loading && !data) {
    return <div className="p-6 text-sm text-on-surface-variant">Loading attribution data...</div>;
  }

  return (
    <div className="max-w-[1440px] mx-auto p-6 space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-primary">Performance &amp; Attribution</h2>
          <p className="text-xs text-on-surface-variant mt-1">
            {data?.report
              ? `Report generated ${formatDate(data.report.generated_at)}`
              : 'No persisted expectancy report is available'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadAttribution()}
          className="w-9 h-9 border border-border-subtle bg-white hover:bg-surface-container flex items-center justify-center"
          title="Refresh attribution data"
          aria-label="Refresh attribution data"
        >
          <span className="material-symbols-outlined text-[18px]">refresh</span>
        </button>
      </header>

      {error && (
        <div className="border border-status-error bg-status-error/5 px-4 py-3 text-sm text-status-error" role="alert">
          {error}.{data ? ' Previously loaded values are retained.' : ''}
        </div>
      )}

      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-border-subtle p-5 shadow-sm">
          <p className="text-[10px] font-bold text-on-surface-variant uppercase">Eligible outcomes</p>
          <p className="text-2xl font-mono font-bold mt-2">{data?.report ? summary.eligible : 'Unavailable'}</p>
        </div>
        <div className="bg-white border border-border-subtle p-5 shadow-sm">
          <p className="text-[10px] font-bold text-on-surface-variant uppercase">Weighted hit rate</p>
          <p className="text-2xl font-mono font-bold mt-2">
            {summary.hitRate === null ? 'Unavailable' : `${summary.hitRate.toFixed(1)}%`}
          </p>
        </div>
        <div className="bg-white border border-border-subtle p-5 shadow-sm">
          <p className="text-[10px] font-bold text-on-surface-variant uppercase">Weighted expectancy</p>
          <p className={`text-2xl font-mono font-bold mt-2 ${
            summary.expectancy !== null && summary.expectancy < 0 ? 'text-status-error' : 'text-status-success'
          }`}>
            {formatUsd(summary.expectancy)}
          </p>
        </div>
        <div className="bg-white border border-border-subtle p-5 shadow-sm">
          <p className="text-[10px] font-bold text-on-surface-variant uppercase">Latency samples (24h)</p>
          <p className="text-2xl font-mono font-bold mt-2">
            {data?.latency.length
              ? data.latency.reduce((total, row) => total + (toFiniteNumber(row.sample_count) ?? 0), 0)
              : 'Unavailable'}
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 bg-white border border-border-subtle shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-border-subtle">
            <h3 className="text-sm font-bold text-primary">Persisted Expectancy</h3>
          </div>
          {reportRows.length === 0 ? (
            <p className="p-6 text-sm text-on-surface-variant">No eligible realized outcomes were present when the latest report ran.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-container-low text-[10px] uppercase text-on-surface-variant">
                  <tr>
                    <th className="px-4 py-3">Pattern</th>
                    <th className="px-4 py-3">Tier</th>
                    <th className="px-4 py-3">Chain</th>
                    <th className="px-4 py-3">Mode</th>
                    <th className="px-4 py-3 text-right">N</th>
                    <th className="px-4 py-3 text-right">Hit rate</th>
                    <th className="px-4 py-3 text-right">Avg win</th>
                    <th className="px-4 py-3 text-right">Avg loss</th>
                    <th className="px-4 py-3 text-right">Expectancy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle font-mono">
                  {reportRows.map((row) => (
                    <tr key={`${row.pattern_type}:${row.tier ?? 'none'}:${row.chain}:${row.execution_mode}`}>
                      <td className="px-4 py-3 font-sans font-semibold">{row.pattern_type}</td>
                      <td className="px-4 py-3 font-sans">{row.tier ?? 'Unassigned'}</td>
                      <td className="px-4 py-3 font-sans">{CHAIN_LABELS[row.chain] ?? row.chain}</td>
                      <td className="px-4 py-3 uppercase">{row.execution_mode}</td>
                      <td className="px-4 py-3 text-right">{row.eligible_outcomes}</td>
                      <td className="px-4 py-3 text-right">{toFiniteNumber(row.hit_rate_pct)?.toFixed(1) ?? 'Unavailable'}{toFiniteNumber(row.hit_rate_pct) === null ? '' : '%'}</td>
                      <td className="px-4 py-3 text-right">{formatUsd(row.avg_win_usd)}</td>
                      <td className="px-4 py-3 text-right">{formatUsd(row.avg_loss_usd)}</td>
                      <td className="px-4 py-3 text-right font-bold">{formatUsd(row.expectancy_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white border border-border-subtle p-5 shadow-sm">
          <h3 className="text-sm font-bold text-primary">Manual Thresholds</h3>
          <p className="text-xs text-on-surface-variant mt-1 mb-5">
            Snapshot captured with this report; changes remain operator-controlled.
          </p>
          <dl className="space-y-4 text-xs">
            <div className="flex justify-between gap-4 border-b border-border-subtle pb-3">
              <dt>Minimum signal score</dt>
              <dd><ThresholdValue value={data?.manual_thresholds.min_signal_score} /></dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-border-subtle pb-3">
              <dt>Auto-execute score</dt>
              <dd><ThresholdValue value={data?.manual_thresholds.auto_execute_min_score} /></dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-border-subtle pb-3">
              <dt>Maximum position</dt>
              <dd><ThresholdValue value={data?.manual_thresholds.max_position_pct} /></dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-border-subtle pb-3">
              <dt>Daily exposure</dt>
              <dd><ThresholdValue value={data?.manual_thresholds.max_daily_exposure_pct} /></dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-border-subtle pb-3">
              <dt>Stop loss</dt>
              <dd><ThresholdValue value={data?.manual_thresholds.stop_loss_pct} /></dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Config captured</dt>
              <dd className="text-right font-mono">
                {formatDate(data?.manual_thresholds.captured_at ?? null)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="bg-white border border-border-subtle shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-border-subtle">
            <h3 className="text-sm font-bold text-primary">Detection-to-Confirmation Latency (24h)</h3>
          </div>
          {!data?.latency.length ? (
            <p className="p-6 text-sm text-on-surface-variant">No complete detected, submitted, and confirmed timestamp samples are available.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-container-low text-[10px] uppercase text-on-surface-variant">
                  <tr>
                    <th className="px-4 py-3">Chain / Pattern</th>
                    <th className="px-4 py-3">Mode</th>
                    <th className="px-4 py-3 text-right">N</th>
                    <th className="px-4 py-3 text-right">p50</th>
                    <th className="px-4 py-3 text-right">p95</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {data.latency.map((row) => (
                    <tr key={`${row.chain}:${row.pattern_type}:${row.tier ?? 'none'}:${row.execution_mode}`}>
                      <td className="px-4 py-3">
                        <p className="font-semibold">{CHAIN_LABELS[row.chain] ?? row.chain}</p>
                        <p className="text-[10px] text-on-surface-variant">{row.pattern_type} / {row.tier ?? 'unassigned'}</p>
                      </td>
                      <td className="px-4 py-3 font-mono uppercase">{row.execution_mode}</td>
                      <td className="px-4 py-3 text-right font-mono">{row.sample_count}</td>
                      <td className="px-4 py-3 text-right font-mono">{formatMs(row.p50_detection_to_confirmation_ms)}</td>
                      <td className="px-4 py-3 text-right font-mono">{formatMs(row.p95_detection_to_confirmation_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white border border-border-subtle p-5 shadow-sm">
          <h3 className="text-sm font-bold text-primary">Live vs Shadow Execution Cost</h3>
          <p className="text-xs text-on-surface-variant mt-1 mb-5">Direction-adjusted difference from matched actual fill prices.</p>
          {!data?.live_vs_shadow.length ? (
            <p className="text-sm text-on-surface-variant">No matched filled live/shadow pairs are available.</p>
          ) : (
            <div className="space-y-3">
              {data.live_vs_shadow.map((row) => {
                const cost = toFiniteNumber(row.avg_execution_cost_bps);
                return (
                  <div key={row.chain} className="border border-border-subtle p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="text-xs font-bold">{CHAIN_LABELS[row.chain] ?? row.chain}</p>
                      <p className="text-[10px] text-on-surface-variant mt-1">{row.matched_trades} matched fills</p>
                    </div>
                    <div className="text-right">
                      <p className={`font-mono font-bold ${cost !== null && cost > 0 ? 'text-status-error' : 'text-status-success'}`}>
                        {cost === null ? 'Unavailable' : `${cost > 0 ? '+' : ''}${cost.toFixed(2)} bps`}
                      </p>
                      <p className="text-[10px] text-on-surface-variant">
                        {cost === null ? 'comparison unavailable' : cost > 0 ? 'live costlier' : 'live better'}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section className="bg-white border border-border-subtle shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-border-subtle flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-primary">Attribution Ledger</h3>
          <span className="text-xs text-on-surface-variant">
            {selectedTrade ? `Selected ${selectedTrade.trade_id.slice(0, 8)}` : 'No filled trading outcomes'}
          </span>
        </div>
        {!data?.ledger.length ? (
          <p className="p-6 text-sm text-on-surface-variant">No filled non-shadow trades are available.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-surface-container-low text-[10px] uppercase text-on-surface-variant">
                <tr>
                  <th className="px-4 py-3">Executed</th>
                  <th className="px-4 py-3">Signal</th>
                  <th className="px-4 py-3">Chain</th>
                  <th className="px-4 py-3">Pattern / Mode</th>
                  <th className="px-4 py-3 text-right">Fill latency</th>
                  <th className="px-4 py-3 text-right">Slippage bound</th>
                  <th className="px-4 py-3 text-right">Realized P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {data.ledger.map((row) => {
                  const fillLatency = row.submitted_at && row.confirmed_at
                    ? new Date(row.confirmed_at).getTime() - new Date(row.submitted_at).getTime()
                    : null;
                  return (
                    <tr
                      key={row.trade_id}
                      onClick={() => setSelectedTradeId(row.trade_id)}
                      className={`cursor-pointer hover:bg-surface-container ${selectedTradeId === row.trade_id ? 'bg-surface-container-low' : ''}`}
                    >
                      <td className="px-4 py-3 font-mono">{formatDate(row.executed_at)}</td>
                      <td className="px-4 py-3 font-mono font-bold">{row.signal_id.slice(0, 8)}</td>
                      <td className="px-4 py-3">{CHAIN_LABELS[row.chain] ?? row.chain}</td>
                      <td className="px-4 py-3">{row.pattern_type} / <span className="font-mono uppercase">{row.execution_mode}</span></td>
                      <td className="px-4 py-3 text-right font-mono">{formatMs(fillLatency)}</td>
                      <td className="px-4 py-3 text-right font-mono">{row.slippage_bps === null ? 'Unavailable' : `${row.slippage_bps} bps`}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold">
                        {row.realized_pnl_usd === null ? 'Unrealized' : formatUsd(row.realized_pnl_usd)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
