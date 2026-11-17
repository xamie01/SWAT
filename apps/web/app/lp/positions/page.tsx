'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { lpApi } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';
import { lpActionAllowed, lpMode, usd, type LpPositionView } from '../../../lib/portfolio-model.js';
import { FinancialRequestPanel } from '../../../components/FinancialRequestPanel.js';

type PositionItem = LpPositionView;

export default function LpPositionsPage() {
  const [positions, setPositions] = useState<PositionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pendingId: string | null = null;

  const fetchPositions = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPositions([]);
    try {
      const res = await lpApi.get<{ positions: PositionItem[] }>('/v1/lp/positions?includeClosed=true');
      if (!Array.isArray(res.positions)) throw new Error('Malformed position observation');
      setPositions(res.positions);
    } catch (err) {
      setError(describeApiError(err, 'Failed to fetch LP positions'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPositions();
  }, [fetchPositions]);

  const runAction = async (_pos: PositionItem, _kind: 'close' | 'rebalance' | 'auto-rebalance') => {
    setNotice('Legacy numeric LP read is observation-only. Use the separate current exact position control; no request was submitted.');
  };
  const handleToggleAutoRebalance = (pos: PositionItem) => runAction(pos, 'auto-rebalance');
  const handleTriggerRebalance = (pos: PositionItem) => runAction(pos, 'rebalance');
  const handleClosePosition = (pos: PositionItem) => runAction(pos, 'close');

  const stateBadge = (state: PositionItem['state']) => {
    switch (state) {
      case 'active':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
            Active
          </span>
        );
      case 'near_edge':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/20 text-amber-300 border border-amber-500/30 animate-pulse">
            Near Edge
          </span>
        );
      case 'out_of_range':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-red-500/20 text-red-300 border border-red-500/30">
            Out of Range
          </span>
        );
      case 'rebalancing':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
            Rebalancing
          </span>
        );
      case 'closed':
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-surface-container border border-border-subtle text-on-surface-variant">
            Closed
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-surface-container text-on-surface-variant">
            {state}
          </span>
        );
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6 max-w-full overflow-hidden">
      {/* Header and Hero Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 bg-surface-container-low border border-border-subtle rounded-xl p-4 sm:p-5 shadow-xs">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h1 className="text-lg sm:text-xl font-bold text-primary tracking-tight">
              Active LP Positions & Rebalancing
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-primary/20 text-primary border border-primary/30 uppercase">
              Monitor
            </span>
          </div>
          <p className="text-xs text-on-surface-variant max-w-2xl leading-relaxed">
            Legacy numeric LP read is explicitly observation-only; fractional exact quantity is unavailable in this list. No exact quantities are synthesized. Use the separate current exact read for paper operations.
          </p>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <Link
            href="/lp/builder"
            className="px-3.5 py-1.5 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity flex items-center gap-1.5 shadow-sm"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            <span>New Ladder</span>
          </Link>
          <button
            onClick={() => void fetchPositions()}
            className="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-surface-container border border-border-subtle text-on-surface-variant hover:text-primary flex items-center gap-1.5 transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            <span>Refresh</span>
          </button>
        </div>
      </div>

      <FinancialRequestPanel kind="lp-operation" />
      {error && (
        <div className="p-3 bg-red-950/40 border border-red-500/30 text-red-300 rounded-lg text-xs font-mono">
          {error}
        </div>
      )}

      {notice && <div role="status" className="p-3 border border-border-subtle rounded-lg text-xs font-mono">{notice}</div>}
      {loading ? (
        <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-10 text-center text-xs text-on-surface-variant font-mono">
          Loading active concentrated LP positions...
        </div>
      ) : error ? (
        <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-10 text-center text-xs">LP holdings unavailable. A failed observation is not an empty portfolio.</div>
      ) : positions.length === 0 ? (
        <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-10 text-center space-y-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto text-primary">
            <span className="material-symbols-outlined text-[20px]">water_drop</span>
          </div>
          <div>
            <p className="text-xs font-bold text-on-surface">No recorded LP positions</p>
            <p className="text-[11px] text-on-surface-variant mt-0.5">
              The successful API observation returned no LP positions. Paper planning does not deploy live liquidity or earn live fees.
            </p>
          </div>
          <div className="flex items-center justify-center gap-2.5 pt-1">
            <Link
              href="/lp/builder"
              className="px-3.5 py-1.5 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity"
            >
              Plan Paper Ladder
            </Link>
            <Link
              href="/lp/copy"
              className="px-3.5 py-1.5 text-xs font-bold rounded-lg bg-surface-container hover:bg-surface-container-high border border-border-subtle text-on-surface transition-colors"
            >
              Copy a Master
            </Link>
          </div>
        </div>
      ) : (
        <>
          {/* Mobile View: Cards */}
          <div className="block md:hidden space-y-3">
            {positions.map((pos) => {
              const isClosed = pos.state === 'closed';
              return (
                <div
                  key={pos.id}
                  className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4 space-y-3 shadow-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <span className="font-mono text-xs font-bold text-on-surface truncate block">
                        {pos.poolAddress}
                      </span>
                      <div className="flex items-center gap-1.5 text-[10px] text-on-surface-variant font-mono">
                        <span className="capitalize">{pos.chain}</span>
                        <span>•</span>
                        <span>{pos.protocol}</span>
                        <span>•</span>
                        <span className="uppercase">{pos.strategyType}</span>
                      </div>
                    </div>
                    {stateBadge(pos.state)}
                  </div>

                  <div className="grid grid-cols-2 gap-2 bg-surface-container-low p-2.5 rounded-lg border border-border-subtle font-mono text-xs">
                    <div>
                      <span className="text-[9px] text-on-surface-variant uppercase block">Range Bounds</span>
                      <span className="text-on-surface font-bold">
                        {pos.rangeLower} → {pos.rangeUpper}
                      </span>
                    </div>
                    <div>
                      <span className="text-[9px] text-on-surface-variant uppercase block">Quantity / Acquisition USD</span>
                      <span className="text-emerald-400 font-bold">{pos.depositAmount} {pos.depositAsset ?? 'asset unknown'} · {usd(pos.depositValueUsd)}</span>
                    </div>
                  </div>

                  <p className="text-[10px] text-on-surface-variant">{lpMode(pos)}</p>
                  {!isClosed && (
                    <div className="flex items-center justify-between p-2.5 bg-surface-container rounded-lg text-xs">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-[16px] text-primary">auto_mode</span>
                        <div>
                          <span className="font-bold text-on-surface block text-[11px]">Auto Rebalance</span>
                          <span className="text-[9px] text-on-surface-variant">Local paper preference; economics unassessed</span>
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        disabled={!!pendingId || !lpActionAllowed(pos, 'auto-rebalance')}
                        checked={pos.autoRebalance}
                        onChange={() => void handleToggleAutoRebalance(pos)}
                        className="h-4 w-4 accent-primary"
                      />
                    </div>
                  )}

                  {!isClosed && (
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        disabled={!!pendingId || !lpActionAllowed(pos, 'rebalance')}
                        onClick={() => void handleTriggerRebalance(pos)}
                        className="flex-1 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high border border-border-subtle text-xs font-bold text-on-surface transition-colors"
                      >
                        Paper Rebalance
                      </button>
                      <button
                        disabled={!!pendingId || !lpActionAllowed(pos, 'close')}
                        onClick={() => void handleClosePosition(pos)}
                        className="py-1.5 px-3 rounded-lg text-xs font-bold text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        Close Paper Record
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Desktop View: Table */}
          <div className="hidden md:block bg-surface-container-lowest border border-border-subtle rounded-xl overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-border-subtle bg-surface-container-low text-on-surface-variant font-mono text-[11px] uppercase tracking-wider">
                    <th className="px-4 py-3">Position & Pool</th>
                    <th className="px-4 py-3">Venue</th>
                    <th className="px-4 py-3 text-right">Range Bounds</th>
                    <th className="px-4 py-3 text-right">Quantity / Acquisition USD</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    <th className="px-4 py-3 text-center">Auto-Rebalance</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {positions.map((pos) => {
                    const isClosed = pos.state === 'closed';
                    return (
                      <tr key={pos.id} className="hover:bg-surface-container-low/50 transition-colors">
                        <td className="px-4 py-3 font-mono">
                          <span className="font-bold text-on-surface block truncate max-w-[240px] text-sm">
                            {pos.poolAddress}
                          </span>
                          <span className="text-[10px] text-on-surface-variant capitalize">
                            Strategy: {pos.strategyType} · {lpMode(pos)}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono">
                          <div className="capitalize text-on-surface font-medium">{pos.chain}</div>
                          <div className="text-[10px] text-on-surface-variant">{pos.protocol}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-medium">
                          {pos.rangeLower} → {pos.rangeUpper}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-emerald-400">
                          {pos.depositAmount} {pos.depositAsset ?? 'asset unknown'} · {usd(pos.depositValueUsd)}
                        </td>
                        <td className="px-4 py-3 text-center">{stateBadge(pos.state)}</td>
                        <td className="px-4 py-3 text-center">
                          {!isClosed ? (
                            <input
                              type="checkbox"
                              disabled={!!pendingId || !lpActionAllowed(pos, 'auto-rebalance')}
                              checked={pos.autoRebalance}
                              onChange={() => void handleToggleAutoRebalance(pos)}
                              className="h-4 w-4 accent-primary"
                            />
                          ) : (
                            <span className="text-on-surface-variant text-[11px] font-mono">N/A</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!isClosed ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                disabled={!!pendingId || !lpActionAllowed(pos, 'rebalance')}
                                onClick={() => void handleTriggerRebalance(pos)}
                                className="px-2.5 py-1 text-xs font-bold rounded bg-surface-container hover:bg-surface-container-high border border-border-subtle text-on-surface transition-colors"
                              >
                                Paper Rebalance
                              </button>
                              <button
                                disabled={!!pendingId || !lpActionAllowed(pos, 'close')}
                                onClick={() => void handleClosePosition(pos)}
                                className="px-2.5 py-1 text-xs font-bold rounded text-red-400 hover:bg-red-500/10 transition-colors"
                              >
                                Close Paper Record
                              </button>
                            </div>
                          ) : (
                            <span className="text-on-surface-variant text-[11px] font-mono">Archived</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
