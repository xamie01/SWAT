'use client';

import { useCallback, useEffect, useState } from 'react';
import { lpApi } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

interface WhaleLeaderboardEntry {
  walletAddress: string;
  chain: string;
  totalPositions: number;
  winRate: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  netPnlUsd: number;
}

interface CopySubscription {
  id: string;
  userId: string;
  masterWalletAddress: string;
  chain: string;
  venue: string;
  allocatedBudgetUsd: number;
  maxCapitalPerPositionUsd: number;
  status: 'active' | 'paused' | 'closed';
  createdAt: string;
}

export default function LpWhalesPage() {
  const [whales, setWhales] = useState<WhaleLeaderboardEntry[]>([]);
  const [subscriptions, setSubscriptions] = useState<CopySubscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [copyModalWhale, setCopyModalWhale] = useState<WhaleLeaderboardEntry | null>(null);
  const [copyBudget, setCopyBudget] = useState(1000);
  const [copyMaxCapital, setCopyMaxCapital] = useState(500);
  const [copySubmitting, setCopySubmitting] = useState(false);
  const [copySuccessMsg, setCopySuccessMsg] = useState<string | null>(null);

  const fetchWhalesAndSubs = useCallback(async () => {
    setLoading(true);
    try {
      const [leaderboardRes, subsRes] = await Promise.allSettled([
        lpApi.get<{ entries: WhaleLeaderboardEntry[] }>('/v1/lp/wallets/leaderboard'),
        lpApi.get<{ subscriptions: CopySubscription[] }>('/v1/lp/copy/subscriptions')
      ]);

      if (leaderboardRes.status === 'fulfilled') {
        setWhales(leaderboardRes.value.entries ?? []);
      }
      if (subsRes.status === 'fulfilled') {
        setSubscriptions(subsRes.value.subscriptions ?? []);
      }
    } catch {
      // Best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchWhalesAndSubs();
  }, [fetchWhalesAndSubs]);

  const handleCreateCopySubscription = async () => {
    if (!copyModalWhale) return;
    setCopySubmitting(true);
    setCopySuccessMsg(null);
    try {
      const venue = copyModalWhale.chain === 'solana' ? 'meteora-dlmm' : 'uniswap-v3';
      await lpApi.post('/v1/lp/copy/subscribe', {
        masterWalletAddress: copyModalWhale.walletAddress,
        chain: copyModalWhale.chain,
        venue,
        allocatedBudgetUsd: copyBudget,
        maxCapitalPerPositionUsd: copyMaxCapital
      });
      setCopySuccessMsg('Subscription active! Forward-only execution enabled.');
      setTimeout(() => {
        setCopyModalWhale(null);
        setCopySuccessMsg(null);
        void fetchWhalesAndSubs();
      }, 1500);
    } catch (err) {
      alert(describeApiError(err, 'Failed to activate copy subscription'));
    } finally {
      setCopySubmitting(false);
    }
  };

  const handleToggleSubStatus = async (sub: CopySubscription) => {
    const nextStatus = sub.status === 'active' ? 'paused' : 'active';
    try {
      await lpApi.patch(`/v1/lp/copy/subscriptions/${sub.id}`, { status: nextStatus });
      void fetchWhalesAndSubs();
    } catch (err) {
      alert(describeApiError(err, 'Failed to update subscription status'));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-primary tracking-tight">LP Whales Leaderboard & Copy-Trading</h1>
          <p className="text-xs text-on-surface-variant mt-1">
            Follow professional liquidity providers with consistent fee yields. Enforces forward-only copying so historical stale ranges are never mirrored.
          </p>
        </div>

        <button
          onClick={() => void fetchWhalesAndSubs()}
          className="px-3.5 py-1.5 text-xs font-medium rounded-lg bg-surface-container border border-border-subtle text-on-surface-variant hover:text-primary flex items-center gap-1.5 transition-colors self-start md:self-auto"
        >
          <span className="material-symbols-outlined text-[16px]">refresh</span>
          <span>Refresh</span>
        </button>
      </div>

      {/* Active Subscriptions Section */}
      {subscriptions.length > 0 && (
        <div className="bg-surface-container-lowest border border-border-subtle rounded-lg p-5 space-y-4 shadow-sm">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[18px]">verified</span>
            <h3 className="text-sm font-bold text-primary">My Active LP Copy Subscriptions</h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {subscriptions.map((sub) => (
              <div key={sub.id} className="p-4 bg-surface-container-low border border-border-subtle rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-bold truncate max-w-[200px] text-on-surface">
                    {sub.masterWalletAddress}
                  </span>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    sub.status === 'active'
                      ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                      : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                  }`}>
                    {sub.status.toUpperCase()}
                  </span>
                </div>
                <div className="text-xs text-on-surface-variant flex justify-between font-mono">
                  <span>Budget: ${sub.allocatedBudgetUsd}</span>
                  <span>Max/Pos: ${sub.maxCapitalPerPositionUsd}</span>
                </div>
                <div className="flex justify-between items-center pt-2 border-t border-border-subtle text-xs">
                  <span className="text-[10px] text-emerald-400 font-mono font-medium">Forward-Only Mirroring</span>
                  <button
                    onClick={() => void handleToggleSubStatus(sub)}
                    className="text-xs text-primary font-bold hover:underline"
                  >
                    {sub.status === 'active' ? 'Pause' : 'Resume'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Whales Leaderboard Table */}
      <div className="bg-surface-container-lowest border border-border-subtle rounded-lg overflow-hidden shadow-sm">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-container-low text-on-surface-variant font-mono text-[11px] uppercase tracking-wider">
              <th className="px-4 py-3">Rank & Master Whale</th>
              <th className="px-4 py-3">Chain</th>
              <th className="px-4 py-3 text-right">Realized Fees PnL</th>
              <th className="px-4 py-3 text-right">Win Rate</th>
              <th className="px-4 py-3 text-right">Open Positions</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-on-surface-variant font-mono">
                  Querying master wallet indexer and ranking realized PnL...
                </td>
              </tr>
            ) : whales.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-on-surface-variant font-mono">
                  No tracked LP master wallets found. Register master addresses via operator console.
                </td>
              </tr>
            ) : (
              whales.map((w, idx) => (
                <tr key={w.walletAddress} className="hover:bg-surface-container-low/50 transition-colors">
                  <td className="px-4 py-3 font-mono">
                    <div className="flex items-center gap-2">
                      <span className="text-on-surface-variant font-bold">#{idx + 1}</span>
                      <span className="font-bold text-on-surface truncate max-w-[260px]">{w.walletAddress}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 capitalize font-mono text-on-surface-variant">{w.chain}</td>
                  <td className="px-4 py-3 text-right font-mono font-bold text-emerald-400 text-sm">
                    +${Math.round(w.realizedPnlUsd).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-medium">{w.winRate.toFixed(1)}%</td>
                  <td className="px-4 py-3 text-right font-mono">{w.totalPositions}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setCopyModalWhale(w)}
                      className="px-3.5 py-1.5 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity"
                    >
                      Copy Master
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Copy Modal */}
      {copyModalWhale && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl max-w-md w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border-subtle pb-3">
              <h3 className="font-bold text-base text-primary">Copy LP Master</h3>
              <button onClick={() => setCopyModalWhale(null)} className="text-on-surface-variant hover:text-on-surface">
                ✕
              </button>
            </div>

            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs space-y-1 text-amber-300">
              <p className="font-bold flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">shield</span>
                Forward-Only Execution Guarantee
              </p>
              <p className="text-[11px] leading-relaxed text-amber-200/80">
                Positions opened prior to this subscription will be ignored. Your capital only enters fresh positions opened after this exact timestamp, avoiding stale or out-of-range entry prices.
              </p>
            </div>

            <div className="space-y-4 text-xs">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Master Address</label>
                <div className="mt-1 font-mono p-2 bg-surface-container rounded border border-border-subtle truncate text-on-surface">
                  {copyModalWhale.walletAddress}
                </div>
              </div>

              <div>
                <div className="flex justify-between">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Allocated Budget ($ USD)</label>
                  <span className="font-mono font-bold text-primary">${copyBudget}</span>
                </div>
                <input
                  type="range"
                  min="50"
                  max="10000"
                  step="50"
                  value={copyBudget}
                  onChange={(e) => setCopyBudget(Number(e.target.value))}
                  className="w-full h-1.5 mt-2 bg-surface-container rounded appearance-none cursor-pointer accent-primary"
                />
              </div>

              <div>
                <div className="flex justify-between">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Max Capital Per Position ($ USD)</label>
                  <span className="font-mono font-bold text-primary">${copyMaxCapital}</span>
                </div>
                <input
                  type="range"
                  min="25"
                  max={copyBudget}
                  step="25"
                  value={copyMaxCapital}
                  onChange={(e) => setCopyMaxCapital(Number(e.target.value))}
                  className="w-full h-1.5 mt-2 bg-surface-container rounded appearance-none cursor-pointer accent-primary"
                />
              </div>
            </div>

            {copySuccessMsg && (
              <div className="p-3 bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 rounded-lg text-xs text-center font-bold font-mono">
                {copySuccessMsg}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-3 border-t border-border-subtle">
              <button
                onClick={() => setCopyModalWhale(null)}
                className="px-4 py-2 text-xs font-bold rounded-lg bg-surface-container text-on-surface-variant hover:text-on-surface"
              >
                Cancel
              </button>
              <button
                disabled={copySubmitting}
                onClick={() => void handleCreateCopySubscription()}
                className="px-5 py-2 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 disabled:opacity-50"
              >
                {copySubmitting ? 'Activating...' : 'Activate Copy'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
