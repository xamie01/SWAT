'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { lpApi } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

type Chain = 'All' | 'solana' | 'robinhood-chain' | 'base' | 'ethereum' | 'bsc';

interface PoolItem {
  id: string;
  chain: string;
  protocol: string;
  poolAddress: string;
  pairLabel: string;
  currentPrice: number | null;
  tvl: number | null;
  activeTvl: number | null;
  volume24h: number | null;
  feeApr24h: number | null;
  riskScore: number | null;
  riskFlags: string[];
  isNewLaunch?: boolean;
  ageHours?: number;
  volumeToActiveLiquidity?: number;
  volatilitySurgeIndex?: number;
  dailyFeeYieldPct?: number;
  rugShieldPassed?: boolean;
}

export default function LpDiscoverPage() {
  const [selectedChain, setSelectedChain] = useState<Chain>('All');
  const [showHotOnly, setShowHotOnly] = useState(false);
  const [pools, setPools] = useState<PoolItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPools = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (showHotOnly) {
        const queryChain = selectedChain === 'All' ? '' : `?chain=${selectedChain}`;
        const res = await lpApi.get<{ newLaunches: PoolItem[] }>(`/v1/lp/new-launches${queryChain}`);
        setPools(res.newLaunches ?? []);
      } else {
        const queryChain = selectedChain === 'All' ? '' : `?chain=${selectedChain}`;
        const res = await lpApi.get<{ pools: PoolItem[] }>(`/v1/lp/discover${queryChain}`);
        setPools(res.pools ?? []);
      }
    } catch (err) {
      setError(describeApiError(err, 'Failed to fetch LP pools'));
    } finally {
      setLoading(false);
    }
  }, [selectedChain, showHotOnly]);

  useEffect(() => {
    void fetchPools();
  }, [fetchPools]);

  return (
    <div className="space-y-4 sm:space-y-6 max-w-full overflow-hidden">
      {/* Header and Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 bg-surface-container-low border border-border-subtle rounded-xl p-4 sm:p-5 shadow-xs">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <h1 className="text-lg sm:text-xl font-bold text-primary tracking-tight">
              Concentrated Pool Scanner
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-primary/20 text-primary border border-primary/30 uppercase">
              Live Feed
            </span>
          </div>
          <p className="text-xs text-on-surface-variant max-w-2xl leading-relaxed">
            Real-time scanner across Meteora DLMM, Raydium, Uniswap v3 & PancakeSwap v3 with volume-to-liquidity velocity and Rug Shield protection.
          </p>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <button
            onClick={() => setShowHotOnly(!showHotOnly)}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg flex items-center gap-1.5 sm:gap-2 border transition-all ${
              showHotOnly
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 shadow-sm'
                : 'bg-surface-container border-border-subtle text-on-surface-variant hover:text-on-surface'
            }`}
          >
            <span>🔥 Hot (&lt;48h)</span>
            {showHotOnly && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>}
          </button>
          <button
            onClick={() => void fetchPools()}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-container border border-border-subtle text-on-surface-variant hover:text-primary flex items-center gap-1.5 transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">refresh</span>
            <span>Scan</span>
          </button>
        </div>
      </div>

      {/* Chain Selector (Scrollable) */}
      <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-2.5 sm:p-3 flex items-center gap-1.5 sm:gap-2 overflow-x-auto no-scrollbar scroll-smooth">
        <span className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant mr-1 sm:mr-2 shrink-0">
          Chain:
        </span>
        {(['All', 'solana', 'robinhood-chain', 'base', 'ethereum', 'bsc'] as Chain[]).map((c) => (
          <button
            key={c}
            onClick={() => setSelectedChain(c)}
            className={`px-3 py-1 text-xs font-bold rounded-lg capitalize transition-all shrink-0 whitespace-nowrap active:scale-95 ${
              selectedChain === c
                ? 'bg-primary text-on-primary shadow-sm'
                : 'bg-surface-container border border-border-subtle text-on-surface-variant hover:text-primary'
            }`}
          >
            {c === 'robinhood-chain' ? 'Robinhood' : c}
          </button>
        ))}
      </div>

      {error && (
        <div className="p-3 bg-red-950/40 border border-red-500/30 text-red-300 rounded-lg text-xs font-mono">
          {error}
        </div>
      )}

      {/* Pools Container */}
      {loading ? (
        <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-10 text-center text-xs text-on-surface-variant font-mono">
          Scanning on-chain liquidity pools and computing active TVL...
        </div>
      ) : pools.length === 0 ? (
        <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-10 text-center space-y-2">
          <p className="text-xs font-bold text-on-surface">No Pools Found</p>
          <p className="text-[11px] text-on-surface-variant">
            Try switching chains or toggling Hot Launches off to see all available liquidity pools.
          </p>
        </div>
      ) : (
        <>
          {/* Mobile View: Cards */}
          <div className="block md:hidden space-y-3">
            {pools.map((p) => {
              const isMeteora = p.protocol === 'meteora-dlmm';
              return (
                <div
                  key={p.id}
                  className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4 space-y-3 shadow-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold font-mono text-on-surface text-base">{p.pairLabel}</span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-surface-container border border-border-subtle text-on-surface-variant uppercase">
                          {p.protocol}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-on-surface-variant font-mono">
                        <span className="capitalize">{p.chain}</span>
                        <span>•</span>
                        <span>{p.currentPrice !== null ? `$${p.currentPrice.toFixed(4)}` : 'N/A'}</span>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      {p.riskScore !== null && p.riskScore <= 30 ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                          PASSED ({p.riskScore})
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                          AUDIT {p.riskScore ?? 'N/A'}
                        </span>
                      )}
                      {p.isNewLaunch && (
                        <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          {p.ageHours}h new
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Metrics Grid */}
                  <div className="grid grid-cols-3 gap-2 bg-surface-container-low p-2.5 rounded-lg border border-border-subtle text-center font-mono">
                    <div>
                      <span className="text-[9px] text-on-surface-variant uppercase block">Fee APR</span>
                      <span className="text-xs font-bold text-emerald-400">
                        {p.feeApr24h !== null ? `${p.feeApr24h.toFixed(1)}%` : '0.0%'}
                      </span>
                    </div>
                    <div>
                      <span className="text-[9px] text-on-surface-variant uppercase block">Active TVL</span>
                      <span className="text-xs font-bold text-on-surface">
                        {p.activeTvl !== null ? `$${Math.round(p.activeTvl).toLocaleString()}` : '$0'}
                      </span>
                    </div>
                    <div>
                      <span className="text-[9px] text-on-surface-variant uppercase block">24h Vol</span>
                      <span className="text-xs font-bold text-on-surface">
                        {p.volume24h !== null ? `$${Math.round(p.volume24h).toLocaleString()}` : '$0'}
                      </span>
                    </div>
                  </div>

                  {isMeteora && p.volatilitySurgeIndex && p.volatilitySurgeIndex > 1 && (
                    <div className="text-[10px] text-amber-400 font-mono flex items-center gap-1">
                      <span className="material-symbols-outlined text-[13px]">bolt</span>
                      <span>+{p.volatilitySurgeIndex}x dynamic fee surge active</span>
                    </div>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <Link
                      href={`/lp/builder?pool=${encodeURIComponent(p.poolAddress)}&chain=${p.chain}&price=${p.currentPrice ?? 1}`}
                      className="flex-1 py-2 rounded-lg bg-primary text-on-primary font-bold text-xs hover:opacity-90 transition-opacity text-center"
                    >
                      Deploy Ladder
                    </Link>
                    <Link
                      href="/lp/copy"
                      className="py-2 px-3 rounded-lg bg-surface-container hover:bg-surface-container-high border border-border-subtle text-xs font-bold text-on-surface transition-colors"
                      title="Copy Top Whales"
                    >
                      Copy
                    </Link>
                  </div>
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
                    <th className="px-4 py-3">Pair & Protocol</th>
                    <th className="px-4 py-3">Chain</th>
                    <th className="px-4 py-3 text-right">Current Price</th>
                    <th className="px-4 py-3 text-right">Active TVL</th>
                    <th className="px-4 py-3 text-right">24h Volume</th>
                    <th className="px-4 py-3 text-right">Dynamic Fee APR</th>
                    <th className="px-4 py-3 text-center">Rug Shield</th>
                    <th className="px-4 py-3 text-right">Deploy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {pools.map((p) => {
                    const isMeteora = p.protocol === 'meteora-dlmm';
                    return (
                      <tr key={p.id} className="hover:bg-surface-container-low/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold font-mono text-on-surface text-sm">{p.pairLabel}</span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-surface-container border border-border-subtle text-on-surface-variant uppercase">
                              {p.protocol}
                            </span>
                            {p.isNewLaunch && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                                {p.ageHours}h new
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 capitalize font-mono text-on-surface-variant">{p.chain}</td>
                        <td className="px-4 py-3 text-right font-mono font-medium">
                          {p.currentPrice !== null ? `$${p.currentPrice.toFixed(4)}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          {p.activeTvl !== null ? `$${Math.round(p.activeTvl).toLocaleString()}` : '$0'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          {p.volume24h !== null ? `$${Math.round(p.volume24h).toLocaleString()}` : '$0'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold text-emerald-400">
                          {p.feeApr24h !== null ? `${p.feeApr24h.toFixed(1)}%` : '0.0%'}
                          {isMeteora && p.volatilitySurgeIndex && p.volatilitySurgeIndex > 1 && (
                            <span className="text-[10px] text-amber-400 block font-normal">
                              +{p.volatilitySurgeIndex}x dynamic surge
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {p.riskScore !== null && p.riskScore <= 30 ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                              PASSED ({p.riskScore})
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                              AUDIT {p.riskScore ?? 'N/A'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Link
                            href={`/lp/builder?pool=${encodeURIComponent(p.poolAddress)}&chain=${p.chain}&price=${p.currentPrice ?? 1}`}
                            className="px-3.5 py-1.5 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity inline-block"
                          >
                            Deploy
                          </Link>
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
