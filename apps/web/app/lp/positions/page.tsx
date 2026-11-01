'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { lpApi } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

interface PositionItem {
  id: string;
  chain: string;
  protocol: string;
  poolAddress: string;
  strategyType: string;
  rangeLower: number;
  rangeUpper: number;
  depositAmount: number;
  state: 'building' | 'active' | 'near_edge' | 'out_of_range' | 'rebalancing' | 'closed';
  autoRebalance: boolean;
  rebalanceRecommended?: boolean;
}

export default function LpPositionsPage() {
  const [positions, setPositions] = useState<PositionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPositions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await lpApi.get<{ positions: PositionItem[] }>('/v1/lp/positions?includeClosed=true');
      setPositions(res.positions ?? []);
    } catch (err) {
      setError(describeApiError(err, 'Failed to fetch LP positions'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPositions();
  }, [fetchPositions]);

  const handleToggleAutoRebalance = async (pos: PositionItem) => {
    try {
      await lpApi.patch(`/v1/lp/positions/${pos.id}/auto-rebalance`, { enabled: !pos.autoRebalance });
      void fetchPositions();
    } catch (err) {
      alert(describeApiError(err, 'Failed to toggle auto-rebalance'));
    }
  };

  const handleTriggerRebalance = async (posId: string) => {
    try {
      await lpApi.post(`/v1/lp/positions/${posId}/rebalance`);
      alert('Rebalance job queued on execution queue.');
      void fetchPositions();
    } catch (err) {
      alert(describeApiError(err, 'Failed to trigger rebalance'));
    }
  };

  const handleClosePosition = async (posId: string) => {
    if (!confirm('Are you sure you want to close this LP position? Liquidity will be removed.')) return;
    try {
      await lpApi.post(`/v1/lp/positions/${posId}/close`);
      void fetchPositions();
    } catch (err) {
      alert(describeApiError(err, 'Failed to close position'));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-primary tracking-tight">Active LP Positions & Rebalancing</h1>
          <p className="text-xs text-on-surface-variant mt-1">
            Real-time concentrated liquidity position monitor with automated boundary alerts, economic rebalancing, and one-click exits.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/lp/builder"
            className="px-3.5 py-1.5 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity flex items-center gap-1.5"
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

      {error && (
        <div className="p-3 bg-red-950/40 border border-red-500/30 text-red-300 rounded-lg text-xs font-mono">
          {error}
        </div>
      )}

      {/* Positions Table */}
      <div className="bg-surface-container-lowest border border-border-subtle rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-container-low text-on-surface-variant font-mono text-[11px] uppercase tracking-wider">
              <th className="px-4 py-3">Position & Pool</th>
              <th className="px-4 py-3">Venue</th>
              <th className="px-4 py-3 text-right">Range Bounds</th>
              <th className="px-4 py-3 text-right">Capital Deposited</th>
              <th className="px-4 py-3 text-center">Status</th>
              <th className="px-4 py-3 text-center">Auto-Rebalance</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-on-surface-variant font-mono">
                  Loading active concentrated LP positions...
                </td>
              </tr>
            ) : positions.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-on-surface-variant font-mono">
                  No positions deployed yet.{' '}
                  <Link href="/lp/builder" className="text-primary font-bold hover:underline">
                    Deploy your first custom LP ladder
                  </Link>
                  .
                </td>
              </tr>
            ) : (
              positions.map((pos) => {
                const isClosed = pos.state === 'closed';
                const isNearEdge = pos.state === 'near_edge';
                const isOutOfRange = pos.state === 'out_of_range';

                return (
                  <tr key={pos.id} className="hover:bg-surface-container-low/50 transition-colors">
                    <td className="px-4 py-3 font-mono">
                      <span className="font-bold text-on-surface block truncate max-w-[240px] text-sm">
                        {pos.poolAddress}
                      </span>
                      <span className="text-[10px] text-on-surface-variant capitalize">
                        {pos.strategyType} ladder
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-on-surface-variant capitalize">
                      {pos.protocol} ({pos.chain})
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium">
                      ${pos.rangeLower.toFixed(2)} — ${pos.rangeUpper.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-sm">
                      ${pos.depositAmount.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`px-2.5 py-0.5 rounded text-[10px] font-bold ${
                        pos.state === 'active'
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : isNearEdge
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                          : isOutOfRange
                          ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                          : 'bg-surface-container text-on-surface-variant'
                      }`}>
                        {pos.state.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => void handleToggleAutoRebalance(pos)}
                        className={`px-2 py-1 rounded text-[11px] font-mono font-bold border transition-colors ${
                          pos.autoRebalance
                            ? 'bg-primary/20 text-primary border-primary/40'
                            : 'bg-surface-container text-on-surface-variant border-border-subtle hover:text-on-surface'
                        }`}
                      >
                        {pos.autoRebalance ? 'AUTO ON' : 'MANUAL'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right space-x-2">
                      {!isClosed && (isNearEdge || isOutOfRange) && (
                        <button
                          onClick={() => void handleTriggerRebalance(pos.id)}
                          className="px-2.5 py-1 text-xs font-bold rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30 transition-colors"
                        >
                          Rebalance
                        </button>
                      )}
                      {!isClosed && (
                        <button
                          onClick={() => void handleClosePosition(pos.id)}
                          className="px-2.5 py-1 text-xs font-bold rounded-lg bg-surface-container border border-border-subtle text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          Close
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
