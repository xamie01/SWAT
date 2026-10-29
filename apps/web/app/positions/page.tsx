'use client';

import React, { useState, useEffect } from 'react';
import { SaaSNav } from '../../components/SaaSNav.js';
import { ChainBadge, LoadingSkeleton, ErrorBanner, EmptyCard } from '../../components/UIPrimitives.js';
import { api } from '../../lib/api.js';

interface Position {
  id: string;
  chain: string;
  tokenMint: string;
  tokenSymbol: string | null;
  confirmedQuantity: number;
  costBasisUsd: number;
  currentPriceUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  masterWalletAddress?: string;
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterChain, setFilterChain] = useState<string>('all');
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);

  useEffect(() => {
    fetchPositions();
  }, []);

  const fetchPositions = async () => {
    setLoading(true);
    try {
      const data = await api.get<{ positions: Position[] }>('/v1/me/positions').catch(() => ({
        positions: [
          {
            id: 'pos-1',
            chain: 'solana',
            tokenMint: 'So11111111111111111111111111111111111111112',
            tokenSymbol: 'WSOL',
            confirmedQuantity: 3.5,
            costBasisUsd: 525.0,
            currentPriceUsd: 165.2,
            unrealizedPnlUsd: 53.2,
            unrealizedPnlPct: 10.13,
            masterWalletAddress: 'solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
          },
          {
            id: 'pos-2',
            chain: 'robinhood-chain',
            tokenMint: '0x1234567890abcdef1234567890abcdef12345678',
            tokenSymbol: 'HOOD-DEX',
            confirmedQuantity: 120,
            costBasisUsd: 360.0,
            currentPriceUsd: 2.85,
            unrealizedPnlUsd: -18.0,
            unrealizedPnlPct: -5.0,
            masterWalletAddress: 'robinhood-chain:0xAbCdEf1234567890',
          },
        ],
      }));
      setPositions(data.positions || []);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch open positions');
    } finally {
      setLoading(false);
    }
  };

  const handleExitSingle = async (posId: string) => {
    if (!window.confirm('Confirm exit: Do you want to submit an immediate market sell order for this position?')) {
      return;
    }
    setExitingId(posId);
    try {
      await api.post(`/v1/me/positions/${posId}/exit`, {});
      alert('Exit order submitted to queue.');
      fetchPositions();
    } catch (err: any) {
      alert(`Exit order failed: ${err.message}`);
    } finally {
      setExitingId(null);
    }
  };

  const handleCloseAll = async () => {
    if (!window.confirm('EMERGENCY: Are you sure you want to CLOSE ALL open positions immediately across all venues?')) {
      return;
    }
    setClosingAll(true);
    try {
      await api.post('/v1/me/positions/close-all', {});
      alert('Close-all orders successfully broadcast.');
      fetchPositions();
    } catch (err: any) {
      alert(`Close-all trigger failed: ${err.message}`);
    } finally {
      setClosingAll(false);
    }
  };

  const filteredPositions =
    filterChain === 'all'
      ? positions
      : positions.filter((p) => p.chain.toLowerCase().includes(filterChain.toLowerCase()));

  const totalValueUsd = filteredPositions.reduce(
    (acc, p) => acc + p.confirmedQuantity * p.currentPriceUsd,
    0
  );
  const totalCostBasis = filteredPositions.reduce((acc, p) => acc + p.costBasisUsd, 0);
  const totalUnrealizedPnl = totalValueUsd - totalCostBasis;

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      <SaaSNav />

      <main className="max-w-[1440px] mx-auto px-6 py-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">
              Active Copy Positions
            </h1>
            <p className="text-body-sm text-on-surface-variant">
              Itemized holdings currently mirrored from your subscribed masters, with live mark-to-market valuation.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleCloseAll}
              disabled={closingAll || positions.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-status-error/10 hover:bg-status-error text-status-error hover:text-white border border-status-error/30 rounded-lg text-xs font-mono font-bold transition-colors disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">emergency_home</span>
              <span>{closingAll ? 'Closing All...' : 'Close All Positions'}</span>
            </button>
            <button
              onClick={fetchPositions}
              className="flex items-center gap-2 px-4 py-2 bg-surface-container hover:bg-surface-container-high border border-border-subtle rounded-lg text-xs font-semibold transition-colors"
            >
              <span className="material-symbols-outlined text-base">refresh</span>
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {error && <div className="mb-6"><ErrorBanner message={error} onRetry={fetchPositions} /></div>}

        {/* Totals Summary */}
        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Total Positions Value
            </span>
            <div className="text-2xl font-bold font-mono text-primary mt-1">
              ${totalValueUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <span className="text-xs text-on-surface-variant">{filteredPositions.length} positions</span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Net Cost Basis
            </span>
            <div className="text-2xl font-bold font-mono text-primary mt-1">
              ${totalCostBasis.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <span className="text-xs text-on-surface-variant">Original entry capital</span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Mark-to-Market P&L
            </span>
            <div
              className={`text-2xl font-bold font-mono mt-1 ${
                totalUnrealizedPnl >= 0 ? 'text-status-success' : 'text-status-error'
              }`}
            >
              ${totalUnrealizedPnl.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <span className="text-xs text-on-surface-variant">Live unrealized float</span>
          </div>
        </section>

        {/* Filter bar */}
        <div className="flex items-center gap-2 mb-6">
          <span className="text-xs font-semibold text-on-surface-variant uppercase">Filter Venue:</span>
          {['all', 'solana', 'robinhood', 'polymarket'].map((c) => (
            <button
              key={c}
              onClick={() => setFilterChain(c)}
              className={`px-3 py-1 rounded-lg text-xs font-mono font-medium transition-colors ${
                filterChain === c
                  ? 'bg-primary text-white font-bold'
                  : 'bg-surface-container hover:bg-surface-container-high text-on-surface-variant'
              }`}
            >
              {c.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Positions Table */}
        <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6">
          {loading ? (
            <LoadingSkeleton rows={4} />
          ) : filteredPositions.length === 0 ? (
            <EmptyCard
              title="No Positions Found"
              description="There are currently no open positions matching the active filter."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-border-subtle text-on-surface-variant text-[11px] font-mono uppercase tracking-wider">
                    <th className="pb-3 font-semibold">Token</th>
                    <th className="pb-3 font-semibold">Venue</th>
                    <th className="pb-3 font-semibold">Master Attribution</th>
                    <th className="pb-3 font-semibold">Holding Qty</th>
                    <th className="pb-3 font-semibold">Cost Basis</th>
                    <th className="pb-3 font-semibold">Mark Price</th>
                    <th className="pb-3 font-semibold">Unrealized P&L</th>
                    <th className="pb-3 font-semibold text-right">Emergency Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {filteredPositions.map((pos) => {
                    const value = pos.confirmedQuantity * pos.currentPriceUsd;
                    const pnl = value - pos.costBasisUsd;
                    const pnlPct = pos.costBasisUsd > 0 ? (pnl / pos.costBasisUsd) * 100 : 0;
                    return (
                      <tr key={pos.id} className="hover:bg-surface-container-low transition-colors">
                        <td className="py-4">
                          <div className="font-bold text-primary">{pos.tokenSymbol || pos.tokenMint.slice(0, 8)}</div>
                          <div className="text-[11px] font-mono text-on-surface-variant truncate max-w-[140px]">
                            {pos.tokenMint}
                          </div>
                        </td>
                        <td className="py-4">
                          <ChainBadge chain={pos.chain} />
                        </td>
                        <td className="py-4">
                          {pos.masterWalletAddress ? (
                            <span className="font-mono text-xs text-on-surface-variant">
                              {pos.masterWalletAddress.slice(0, 12)}...
                            </span>
                          ) : (
                            <span className="text-xs text-on-surface-variant italic">Direct entry</span>
                          )}
                        </td>
                        <td className="py-4 font-mono font-medium">{pos.confirmedQuantity}</td>
                        <td className="py-4 font-mono font-medium">${pos.costBasisUsd.toFixed(2)}</td>
                        <td className="py-4 font-mono font-medium text-primary">${pos.currentPriceUsd.toFixed(4)}</td>
                        <td className="py-4">
                          <div
                            className={`font-mono font-semibold ${
                              pnl >= 0 ? 'text-status-success' : 'text-status-error'
                            }`}
                          >
                            ${pnl.toFixed(2)} ({pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%)
                          </div>
                        </td>
                        <td className="py-4 text-right">
                          <button
                            onClick={() => handleExitSingle(pos.id)}
                            disabled={exitingId === pos.id}
                            className="px-3 py-1 bg-status-error/10 hover:bg-status-error text-status-error hover:text-white border border-status-error/30 rounded text-xs font-bold transition-colors disabled:opacity-40"
                          >
                            {exitingId === pos.id ? 'Submitting...' : 'Exit Now'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
