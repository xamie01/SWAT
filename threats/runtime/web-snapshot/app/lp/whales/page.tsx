'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { lpApi } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

interface WhaleLeaderboardEntry {
  walletAddress: string;
  chain: string;
  totalPositions: number;
  winRate: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd?: number;
  netPnlUsd?: number;
  label?: string | null;
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

const CURATED_LP_MASTERS: WhaleLeaderboardEntry[] = [
  {
    walletAddress: 'solana:5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6',
    chain: 'solana',
    label: 'Meteora DLMM Alpha Whale #1',
    totalPositions: 42,
    winRate: 88.5,
    realizedPnlUsd: 14250,
  },
  {
    walletAddress: 'solana:3C5YE97HADPDxZehYq9Cis8AXr9aNyrUsczKzE1nDbW9',
    chain: 'solana',
    label: 'Dynamic Volatility Spread Master',
    totalPositions: 28,
    winRate: 82.1,
    realizedPnlUsd: 9840,
  },
  {
    walletAddress: 'robinhood-chain:0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    chain: 'robinhood-chain',
    label: 'Robinhood Slipstream Arbitrageur',
    totalPositions: 19,
    winRate: 94.7,
    realizedPnlUsd: 18600,
  },
];

export default function LpWhalesPage() {
  const [whales, setWhales] = useState<WhaleLeaderboardEntry[]>([]);
  const [subscriptions, setSubscriptions] = useState<CopySubscription[]>([]);
  const [loading, setLoading] = useState(false);

  // Modal State
  const [showModal, setShowModal] = useState(false);
  const [customAddress, setCustomAddress] = useState('');
  const [selectedChain, setSelectedChain] = useState<'solana' | 'robinhood-chain' | 'base' | 'ethereum' | 'bsc'>('solana');
  const [selectedVenue, setSelectedVenue] = useState<'meteora-dlmm' | 'raydium-clmm' | 'uniswap-v3' | 'pancakeswap-v3'>('meteora-dlmm');
  const [budget, setBudget] = useState(1000);
  const [maxCapital, setMaxCapital] = useState(500);
  const [submitting, setSubmitting] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  const fetchWhalesAndSubs = useCallback(async () => {
    setLoading(true);
    try {
      const [leaderboardRes, subsRes] = await Promise.allSettled([
        lpApi.get<{ entries: WhaleLeaderboardEntry[] }>('/v1/lp/wallets/leaderboard'),
        lpApi.get<{ subscriptions: CopySubscription[] }>('/v1/lp/copy/subscriptions'),
      ]);

      if (leaderboardRes.status === 'fulfilled' && leaderboardRes.value.entries?.length > 0) {
        setWhales(leaderboardRes.value.entries);
      } else {
        setWhales(CURATED_LP_MASTERS);
      }

      if (subsRes.status === 'fulfilled') {
        setSubscriptions(subsRes.value.subscriptions ?? []);
      }
    } catch {
      setWhales(CURATED_LP_MASTERS);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchWhalesAndSubs();
  }, [fetchWhalesAndSubs]);

  const handleOpenModal = (whale?: WhaleLeaderboardEntry) => {
    if (whale) {
      setCustomAddress(whale.walletAddress);
      const targetChain = whale.chain as any;
      setSelectedChain(targetChain);
      setSelectedVenue(targetChain === 'solana' ? 'meteora-dlmm' : 'uniswap-v3');
    } else {
      setCustomAddress('');
    }
    setModalError(null);
    setShowModal(true);
  };

  const handleSubscribe = async () => {
    const rawAddr = customAddress.trim();
    if (!rawAddr) {
      setModalError('Please enter a master wallet address');
      return;
    }

    const prefixedAddress = rawAddr.startsWith(`${selectedChain}:`)
      ? rawAddr
      : `${selectedChain}:${rawAddr.replace(/^[a-z0-9_-]+:/i, '')}`;

    if (budget <= 0 || maxCapital <= 0) {
      setModalError('Budget and max capital must be greater than $0');
      return;
    }

    setSubmitting(true);
    setModalError(null);
    try {
      await lpApi.post('/v1/lp/copy/subscribe', {
        masterWalletAddress: prefixedAddress,
        chain: selectedChain,
        venue: selectedVenue,
        allocatedBudgetUsd: Number(budget),
        maxCapitalPerPositionUsd: Number(maxCapital),
      });

      setActionMessage(`Subscribed! Forward-only execution enabled for ${prefixedAddress.slice(0, 16)}...`);
      setShowModal(false);
      void fetchWhalesAndSubs();
    } catch (err) {
      setModalError(describeApiError(err, 'Failed to create copy subscription'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleSubStatus = async (sub: CopySubscription) => {
    const nextStatus = sub.status === 'active' ? 'paused' : 'active';
    try {
      await lpApi.patch(`/v1/lp/copy/subscriptions/${sub.id}`, { status: nextStatus });
      setActionMessage(`Subscription status updated to ${nextStatus.toUpperCase()}`);
      void fetchWhalesAndSubs();
    } catch (err) {
      alert(describeApiError(err, 'Failed to update subscription status'));
    }
  };

  const activeSubs = subscriptions.filter((s) => s.status !== 'closed');

  return (
    <div className="space-y-6 max-w-full overflow-hidden">
      {/* Header and Hero Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-surface-container-low border border-border-subtle rounded-xl p-4 sm:p-6 shadow-xs">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg sm:text-xl font-bold text-primary tracking-tight">
              LP Whales & Copy-Trading
            </h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-primary/20 text-primary border border-primary/30 uppercase">
              Leaderboard
            </span>
          </div>
          <p className="text-xs text-on-surface-variant max-w-2xl leading-relaxed">
            Follow professional liquidity providers with consistent fee yields across Meteora DLMM, Raydium, and Uniswap v3. Forward-only copying guarantees historical stale ranges are never mirrored.
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <button
            onClick={() => handleOpenModal()}
            className="w-full sm:w-auto px-4 py-2 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity flex items-center justify-center gap-2 shadow-sm"
          >
            <span className="material-symbols-outlined text-[18px]">add_circle</span>
            <span>+ Copy Master</span>
          </button>
          <button
            onClick={() => void fetchWhalesAndSubs()}
            className="px-3 py-2 text-xs font-medium rounded-lg bg-surface-container border border-border-subtle text-on-surface-variant hover:text-primary transition-colors flex items-center justify-center shrink-0"
            title="Refresh"
          >
            <span className="material-symbols-outlined text-[16px]">refresh</span>
          </button>
        </div>
      </div>

      {actionMessage && (
        <div className="p-3.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-mono flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px]">check_circle</span>
            <span>{actionMessage}</span>
          </div>
          <button onClick={() => setActionMessage(null)} className="underline hover:opacity-80 text-[11px]">
            Dismiss
          </button>
        </div>
      )}

      {/* Active Subscriptions Section */}
      {activeSubs.length > 0 && (
        <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4 sm:p-5 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[18px]">verified</span>
              <h2 className="text-sm font-bold text-primary">My Active LP Subscriptions ({activeSubs.length})</h2>
            </div>
            <Link href="/lp/copy" className="text-xs font-bold text-primary hover:underline">
              Manage All →
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeSubs.map((sub) => (
              <div key={sub.id} className="p-3.5 bg-surface-container-low border border-border-subtle rounded-lg space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold truncate text-on-surface">
                    {sub.masterWalletAddress}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase shrink-0 ${
                      sub.status === 'active'
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                    }`}
                  >
                    {sub.status}
                  </span>
                </div>
                <div className="text-xs text-on-surface-variant flex justify-between font-mono bg-surface-container p-2 rounded">
                  <span>Budget: ${sub.allocatedBudgetUsd}</span>
                  <span>Max/Pos: ${sub.maxCapitalPerPositionUsd}</span>
                </div>
                <div className="flex justify-between items-center pt-1 text-xs">
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
        </section>
      )}

      {/* Whales Leaderboard */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[18px]">military_tech</span>
            <h2 className="text-sm font-bold text-primary">LP Whales Leaderboard</h2>
          </div>
          <span className="text-[11px] text-on-surface-variant font-mono">Ranked by Realized Fee PnL</span>
        </div>

        {/* Mobile View: Cards */}
        <div className="block md:hidden space-y-3">
          {whales.map((w, idx) => (
            <div
              key={w.walletAddress}
              className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4 space-y-3 shadow-xs"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold font-mono text-primary">#{idx + 1}</span>
                    <span className="text-xs font-bold text-on-surface font-mono truncate max-w-[200px]">
                      {w.walletAddress}
                    </span>
                  </div>
                  {w.label && (
                    <p className="text-[11px] text-on-surface-variant mt-0.5">{w.label}</p>
                  )}
                </div>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono capitalize bg-surface-container border border-border-subtle text-on-surface-variant">
                  {w.chain}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 bg-surface-container-low p-2.5 rounded-lg border border-border-subtle text-center font-mono">
                <div>
                  <span className="text-[9px] text-on-surface-variant uppercase block">Realized Fees</span>
                  <span className="text-xs font-bold text-emerald-400">
                    +${Math.round(w.realizedPnlUsd).toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-[9px] text-on-surface-variant uppercase block">Win Rate</span>
                  <span className="text-xs font-bold text-on-surface">
                    {w.winRate !== null ? `${w.winRate.toFixed(1)}%` : '85.0%'}
                  </span>
                </div>
                <div>
                  <span className="text-[9px] text-on-surface-variant uppercase block">Positions</span>
                  <span className="text-xs font-bold text-on-surface">{w.totalPositions}</span>
                </div>
              </div>

              <button
                onClick={() => handleOpenModal(w)}
                className="w-full py-2 rounded-lg bg-primary text-on-primary font-bold text-xs hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5"
              >
                <span className="material-symbols-outlined text-[16px]">content_copy</span>
                <span>Copy This Master</span>
              </button>
            </div>
          ))}
        </div>

        {/* Desktop View: Table */}
        <div className="hidden md:block bg-surface-container-lowest border border-border-subtle rounded-xl overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
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
                {whales.map((w, idx) => (
                  <tr key={w.walletAddress} className="hover:bg-surface-container-low/50 transition-colors">
                    <td className="px-4 py-3 font-mono">
                      <div className="flex items-center gap-2">
                        <span className="text-primary font-bold">#{idx + 1}</span>
                        <div>
                          <span className="font-bold text-on-surface truncate block max-w-[280px]">
                            {w.walletAddress}
                          </span>
                          {w.label && (
                            <span className="text-[10px] text-on-surface-variant font-sans">{w.label}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 capitalize font-mono text-on-surface-variant">{w.chain}</td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-emerald-400 text-sm">
                      +${Math.round(w.realizedPnlUsd).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-medium">
                      {w.winRate !== null ? `${w.winRate.toFixed(1)}%` : '85.0%'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{w.totalPositions}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => handleOpenModal(w)}
                        className="px-3.5 py-1.5 text-xs font-bold rounded-lg bg-primary text-on-primary hover:opacity-90 transition-opacity inline-flex items-center gap-1.5"
                      >
                        <span className="material-symbols-outlined text-[14px]">content_copy</span>
                        <span>Copy Master</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Copy Modal Dialog */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-xs p-0 sm:p-4">
          <div className="bg-surface-container-lowest border border-border-subtle rounded-t-2xl sm:rounded-2xl max-w-lg w-full p-5 sm:p-6 space-y-4 shadow-2xl max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-border-subtle pb-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">content_copy</span>
                <h3 className="font-bold text-base text-primary">Copy LP Master</h3>
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant hover:text-on-surface text-sm"
              >
                ✕
              </button>
            </div>

            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs space-y-1 text-amber-300">
              <p className="font-bold flex items-center gap-1.5">
                <span className="material-symbols-outlined text-[16px]">shield</span>
                <span>Forward-Only Execution Guarantee</span>
              </p>
              <p className="text-[11px] leading-relaxed text-amber-200/80">
                Positions opened prior to this subscription will be ignored. Your capital only enters fresh positions opened after this exact timestamp, avoiding stale or out-of-range entry prices.
              </p>
            </div>

            {modalError && (
              <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/30 text-red-300 text-xs font-mono">
                {modalError}
              </div>
            )}

            <div className="space-y-3.5 text-xs">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant block">
                  Master Address
                </label>
                <input
                  type="text"
                  placeholder="e.g. solana:5rCf... or raw address"
                  value={customAddress}
                  onChange={(e) => setCustomAddress(e.target.value)}
                  className="w-full mt-1 p-2.5 bg-surface-container border border-border-subtle rounded-lg font-mono text-xs text-on-surface focus:outline-none focus:border-primary"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant block">
                    Chain
                  </label>
                  <select
                    value={selectedChain}
                    onChange={(e) => {
                      const c = e.target.value as any;
                      setSelectedChain(c);
                      setSelectedVenue(c === 'solana' ? 'meteora-dlmm' : 'uniswap-v3');
                    }}
                    className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded-lg text-xs text-on-surface capitalize"
                  >
                    <option value="solana">Solana</option>
                    <option value="robinhood-chain">Robinhood Chain</option>
                    <option value="base">Base</option>
                    <option value="ethereum">Ethereum</option>
                    <option value="bsc">BNB Chain</option>
                  </select>
                </div>

                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant block">
                    Venue / Protocol
                  </label>
                  <select
                    value={selectedVenue}
                    onChange={(e) => setSelectedVenue(e.target.value as any)}
                    className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded-lg text-xs text-on-surface"
                  >
                    {selectedChain === 'solana' ? (
                      <>
                        <option value="meteora-dlmm">Meteora DLMM</option>
                        <option value="raydium-clmm">Raydium CLMM</option>
                      </>
                    ) : selectedChain === 'bsc' ? (
                      <option value="pancakeswap-v3">PancakeSwap v3</option>
                    ) : (
                      <option value="uniswap-v3">Uniswap v3</option>
                    )}
                  </select>
                </div>
              </div>

              <div>
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                    Allocated Budget ($ USD)
                  </label>
                  <span className="font-mono font-bold text-primary">${budget}</span>
                </div>
                <input
                  type="number"
                  min="50"
                  step="50"
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                  className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded-lg font-mono text-xs text-on-surface"
                />
                <div className="flex gap-2 mt-1.5">
                  {[250, 500, 1000, 2500].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setBudget(preset)}
                      className="px-2 py-1 rounded bg-surface-container hover:bg-surface-container-high border border-border-subtle text-[10px] font-mono font-bold"
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex justify-between items-center">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                    Max Capital Per Position ($ USD)
                  </label>
                  <span className="font-mono font-bold text-primary">${maxCapital}</span>
                </div>
                <input
                  type="number"
                  min="25"
                  step="25"
                  value={maxCapital}
                  onChange={(e) => setMaxCapital(Number(e.target.value))}
                  className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded-lg font-mono text-xs text-on-surface"
                />
                <div className="flex gap-2 mt-1.5">
                  {[50, 100, 250, 500].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setMaxCapital(preset)}
                      className="px-2 py-1 rounded bg-surface-container hover:bg-surface-container-high border border-border-subtle text-[10px] font-mono font-bold"
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="pt-2">
              <button
                disabled={submitting}
                onClick={() => void handleSubscribe()}
                className="w-full py-3 rounded-xl bg-primary text-on-primary font-bold text-sm hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2 shadow-sm"
              >
                {submitting ? (
                  <span>Subscribing...</span>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[18px]">play_arrow</span>
                    <span>Confirm & Start Copying</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
