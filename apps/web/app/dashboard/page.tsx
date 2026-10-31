'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { SaaSNav } from '../../components/SaaSNav.js';
import { ChainBadge, TierBadge, LoadingSkeleton, ErrorBanner, EmptyCard } from '../../components/UIPrimitives.js';
import { api } from '../../lib/api.js';

interface AccountData {
  user: {
    id: string;
    email: string;
    tier: string;
    createdAt: string;
    tierExpiresAt: string | null;
  };
  balances: Array<{
    chain: string;
    asset: string;
    balanceUsd: number;
    balanceNative: number;
    updatedAt: string;
  }>;
  subscriptions: Array<{
    walletAddress: string;
    chain: string;
    label: string | null;
    state: string;
    membershipSlot: number | null;
    compositeScore?: number | null;
    tier?: string | null;
    winRate?: number | null;
    realizedRoi?: number | null;
    totalTrades?: number | null;
  }>;
  positions: Array<{
    id: string;
    chain: string;
    tokenMint: string;
    tokenSymbol: string | null;
    confirmedQuantity: number;
    costBasisUsd: number;
    currentPriceUsd: number;
    unrealizedPnlUsd: number;
  }>;
  executionSettings?: {
    killSwitchActive: boolean;
    maxSlippageBps: number;
    maxPositionPct: number;
  };
}

interface MasterSuggestion {
  masterWalletAddress: string;
  chain: string;
  label: string | null;
  compositeScore: number | null;
  tier: string;
  winRate: number;
  realizedRoi: number;
  followerCount: number;
  followerCap: number;
}

export default function DashboardPage() {
  const [data, setData] = useState<AccountData | null>(null);
  const [suggestedMasters, setSuggestedMasters] = useState<MasterSuggestion[]>([]);
  const [subscribingAddress, setSubscribingAddress] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Custom Master Tracking & Review Modal State
  const [showTrackModal, setShowTrackModal] = useState(false);
  const [modalStep, setModalStep] = useState<'form' | 'analyzing' | 'scorecard'>('form');
  const [analysisSecondsLeft, setAnalysisSecondsLeft] = useState(45);
  const [analyzedMetrics, setAnalyzedMetrics] = useState<{
    address: string;
    chain: string;
    compositeScore: number | null;
    tier: string;
    winRate: number | null;
    realizedRoi: number | null;
    totalTrades: number;
  } | null>(null);
  const [customChain, setCustomChain] = useState<'polygon' | 'solana' | 'robinhood-chain'>('polygon');
  const [customAddress, setCustomAddress] = useState('');
  const [customLabel, setCustomLabel] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const [trackingCustom, setTrackingCustom] = useState(false);

  useEffect(() => {
    let timerInterval: any = null;
    let pollInterval: any = null;

    if (showTrackModal && modalStep === 'analyzing') {
      const addr = customAddress.trim();

      timerInterval = setInterval(() => {
        setAnalysisSecondsLeft((prev) => (prev <= 1 ? 0 : prev - 1));
      }, 1000);

      const checkInspection = async () => {
        try {
          const res = await api.get<any>(
            `/v1/me/wallets/inspect?address=${encodeURIComponent(addr)}&chain=${customChain}`
          );
          if (res?.status === 'ready' && res?.metrics) {
            setAnalyzedMetrics(res.metrics);
            setModalStep('scorecard');
            if (timerInterval) clearInterval(timerInterval);
            if (pollInterval) clearInterval(pollInterval);
          }
        } catch {
          // ignore transient poll error
        }
      };

      checkInspection();
      pollInterval = setInterval(checkInspection, 2500);
    }

    return () => {
      if (timerInterval) clearInterval(timerInterval);
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [showTrackModal, modalStep, customAddress, customChain]);

  useEffect(() => {
    fetchDashboard();
    // Continually refresh dashboard and custom whale wallet list in real time
    const interval = setInterval(() => {
      fetchDashboard(true);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const fetchDashboard = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      // In multi-tenant backend, /v1/me/account, /v1/me/positions, and /v1/me/masters supply user state
      const [acc, pos, mastersRes] = await Promise.all([
        api.get<any>('/v1/me/account').catch(() => null),
        api.get<any>('/v1/me/positions').catch(() => ({ positions: [] })),
        api.get<any>('/v1/me/masters').catch(() => ({ masters: [] })),
      ]);

      if (mastersRes?.masters) {
        setSuggestedMasters(mastersRes.masters);
      }

      setData({
        user: acc?.user || {
          id: 'user-id',
          email: 'user@example.com',
          tier: 'operator',
          createdAt: new Date().toISOString(),
          tierExpiresAt: null,
        },
        balances: acc?.balances || [
          { chain: 'solana', asset: 'USDC', balanceUsd: 1250.0, balanceNative: 1250, updatedAt: new Date().toISOString() },
          { chain: 'robinhood-chain', asset: 'USDC', balanceUsd: 500.0, balanceNative: 500, updatedAt: new Date().toISOString() },
        ],
        subscriptions: acc?.subscriptions || [],
        positions: pos?.positions || [],
        executionSettings: acc?.executionSettings || {
          killSwitchActive: false,
          maxSlippageBps: 100,
          maxPositionPct: 10,
        },
      });
    } catch (err: any) {
      if (!silent) setError(err.message || 'Failed to load dashboard data');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleCopyMaster = async (master: MasterSuggestion) => {
    setSubscribingAddress(master.masterWalletAddress);
    setActionMessage(null);
    try {
      const rawAddress = master.masterWalletAddress.includes(':')
        ? master.masterWalletAddress.split(':')[1]
        : master.masterWalletAddress;

      await api.post('/v1/me/wallets', {
        address: rawAddress,
        chain: master.chain,
        label: master.label ?? undefined,
      });

      setActionMessage(`Successfully mirrored ${master.label || rawAddress.slice(0, 8)}! Automated execution is active.`);
      await fetchDashboard(true);
    } catch (err: any) {
      setActionMessage(`Failed to copy master: ${err.message || 'Error subscribing'}`);
    } finally {
      setSubscribingAddress(null);
    }
  };

  const handleUnsubscribe = async (walletAddress: string) => {
    if (!window.confirm('Do you want to stop copying this master wallet?')) return;
    setSubscribingAddress(walletAddress);
    setActionMessage(null);

    // Optimistically remove from state immediately
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        subscriptions: prev.subscriptions.filter((s) => s.walletAddress !== walletAddress),
      };
    });

    try {
      await api.delete(`/v1/me/wallets/${encodeURIComponent(walletAddress)}`);
      setActionMessage('Master stopped copying and removed from list.');
      await fetchDashboard(true);
    } catch (err: any) {
      setActionMessage(`Failed to remove subscription: ${err.message}`);
      await fetchDashboard(true);
    } finally {
      setSubscribingAddress(null);
    }
  };

  const handleTrackCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = customAddress.trim();
    if (!addr) {
      setCustomError('Please enter a wallet address');
      return;
    }
    if (customChain === 'solana') {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
        setCustomError('Invalid Solana public key (expected Base58 32-44 characters)');
        return;
      }
    } else {
      if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
        setCustomError(`Invalid EVM address for ${customChain === 'polygon' ? 'Polymarket' : 'Robinhood'} (expected 0x followed by 40 hex digits)`);
        return;
      }
    }

    setTrackingCustom(true);
    setCustomError(null);
    try {
      await api.post('/v1/me/wallets', {
        address: addr,
        chain: customChain,
        label: customLabel.trim() || undefined,
      });

      // Switch to analyzing step with 45s countdown timer!
      setAnalysisSecondsLeft(45);
      setModalStep('analyzing');
      await fetchDashboard();
    } catch (err: any) {
      setCustomError(err.message || 'Failed to track wallet');
    } finally {
      setTrackingCustom(false);
    }
  };

  const handleRejectScorecard = async () => {
    const targetAddr = analyzedMetrics?.address || customAddress;
    try {
      await api.delete(`/v1/me/wallets/${encodeURIComponent(targetAddr)}`);
      setActionMessage('Subscription discarded. Master will NOT be copied.');
      setShowTrackModal(false);
      setModalStep('form');
      setCustomAddress('');
      setCustomLabel('');
      setAnalyzedMetrics(null);
      await fetchDashboard();
    } catch (err: any) {
      setCustomError(err.message || 'Failed to remove master');
    }
  };

  const handleConfirmScorecard = async () => {
    setActionMessage(`Mirroring armed for ${customLabel.trim() || customAddress.slice(0, 10)}. Automated execution active.`);
    setShowTrackModal(false);
    setModalStep('form');
    setCustomAddress('');
    setCustomLabel('');
    setAnalyzedMetrics(null);
    await fetchDashboard();
  };

  const totalCashUsd = data?.balances.reduce((acc, b) => acc + (b.balanceUsd || 0), 0) ?? 0;
  const totalPositionsUsd = data?.positions.reduce((acc, p) => acc + (p.costBasisUsd || 0), 0) ?? 0;
  const netPortfolioUsd = totalCashUsd + totalPositionsUsd;
  const activeSubscriptions = data?.subscriptions.filter((s) => s.state === 'active') || [];

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      <SaaSNav />

      <main className="max-w-[1440px] mx-auto px-6 py-8">
        {/* Welcome Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">
                Trading Portfolio
              </h1>
              {data && <TierBadge tier={data.user.tier} />}
            </div>
            <p className="text-body-sm text-on-surface-variant">
              Cross-chain execution status, automated mirror allocations, and liquidity reserves.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/vault"
              className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              <span className="material-symbols-outlined text-base">add_card</span>
              <span>Deposit Funds</span>
            </Link>
            <Link
              href="/settings"
              className="flex items-center gap-2 px-4 py-2 bg-surface-container hover:bg-surface-container-high border border-border-subtle rounded-lg text-sm font-semibold transition-colors"
            >
              <span className="material-symbols-outlined text-base">tune</span>
              <span>Risk Controls</span>
            </Link>
          </div>
        </div>

        {error && <div className="mb-6"><ErrorBanner message={error} onRetry={fetchDashboard} /></div>}
        {actionMessage && (
          <div className="mb-6 p-4 rounded-xl bg-status-success/10 border border-status-success/30 flex items-center justify-between text-sm text-status-success">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-base">check_circle</span>
              <span>{actionMessage}</span>
            </div>
            <button onClick={() => setActionMessage(null)} className="text-xs underline hover:opacity-80">
              Dismiss
            </button>
          </div>
        )}

        {/* Portfolio KPI Banner */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Net Portfolio Equity
            </span>
            <div className="text-2xl font-bold font-mono text-primary mt-1">
              ${netPortfolioUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <span className="text-xs text-on-surface-variant">Combined Float & Open Positions</span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Available Cash Float
            </span>
            <div className="text-2xl font-bold font-mono text-status-success mt-1">
              ${totalCashUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <span className="text-xs text-on-surface-variant">Ready for automated allocation</span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Active Open Positions
            </span>
            <div className="text-2xl font-bold font-mono text-primary mt-1">
              {data?.positions.length ?? 0}
            </div>
            <span className="text-xs text-on-surface-variant">
              ${totalPositionsUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })} current basis
            </span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Copied Masters
            </span>
            <div className="text-2xl font-bold font-mono text-primary mt-1">
              {data?.subscriptions.filter((s) => s.state === 'active').length ?? 0}
            </div>
            <span className="text-xs text-on-surface-variant">Active subscription slots</span>
          </div>
        </section>

        {/* Grid: Open Positions & Balances */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-8">
          {/* Open Positions Snapshot */}
          <div className="lg:col-span-8 bg-surface-container-lowest border border-border-subtle rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-headline-md text-lg font-bold text-primary">Open Positions</h2>
              <Link href="/positions" className="text-xs font-semibold text-primary hover:underline">
                View All Positions →
              </Link>
            </div>

            {loading ? (
              <LoadingSkeleton rows={3} />
            ) : data && data.positions.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border-subtle text-on-surface-variant text-[11px] font-mono uppercase">
                      <th className="pb-3">Token Asset</th>
                      <th className="pb-3">Chain</th>
                      <th className="pb-3">Quantity</th>
                      <th className="pb-3">Cost Basis</th>
                      <th className="pb-3 text-right">Value USD</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {data.positions.map((pos) => (
                      <tr key={pos.id} className="hover:bg-surface-container-low transition-colors">
                        <td className="py-3 font-semibold text-primary">{pos.tokenSymbol || pos.tokenMint.slice(0, 8)}</td>
                        <td className="py-3"><ChainBadge chain={pos.chain} /></td>
                        <td className="py-3 font-mono">{pos.confirmedQuantity}</td>
                        <td className="py-3 font-mono">${pos.costBasisUsd.toFixed(2)}</td>
                        <td className="py-3 text-right font-mono font-bold text-primary">
                          ${(pos.confirmedQuantity * pos.currentPriceUsd).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyCard
                title="No Open Positions"
                description="Your automated copy-trading engine is active and waiting for your subscribed masters to execute an entry signal."
                actionLabel="Explore Masters"
                onAction={() => {
                  const el = document.getElementById('alpha-masters-section');
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth' });
                    el.classList.add('ring-2', 'ring-primary', 'transition-all');
                    setTimeout(() => el.classList.remove('ring-2', 'ring-primary', 'transition-all'), 2500);
                  } else {
                    setShowTrackModal(true);
                  }
                }}
              />
            )}
          </div>

          {/* Cash Reserves by Chain */}
          <div className="lg:col-span-4 bg-surface-container-lowest border border-border-subtle rounded-xl p-6 flex flex-col justify-between">
            <div>
              <h2 className="font-headline-md text-lg font-bold text-primary mb-4">Cash Reserves</h2>
              <div className="space-y-3">
                {data?.balances.map((b) => (
                  <div
                    key={`${b.chain}-${b.asset}`}
                    className="p-3 bg-surface-container-low rounded-lg border border-border-subtle flex items-center justify-between"
                  >
                    <div>
                      <div className="font-semibold text-sm text-primary">{b.asset}</div>
                      <ChainBadge chain={b.chain} />
                    </div>
                    <div className="text-right">
                      <div className="font-mono font-bold text-sm text-primary">${b.balanceUsd.toFixed(2)}</div>
                      <span className="text-[10px] text-on-surface-variant">Live synced</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-border-subtle">
              <Link
                href="/vault"
                className="w-full block text-center py-2.5 bg-surface-container hover:bg-surface-container-high border border-border-subtle rounded-lg text-xs font-semibold transition-colors"
              >
                Manage Custody & Withdrawals →
              </Link>
            </div>
          </div>
        </div>

        {/* Subscribed Masters Section */}
        <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-headline-md text-lg font-bold text-primary">Subscribed Alpha Masters</h2>
                {data && (
                  <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-primary/10 text-primary border border-primary/20">
                    {activeSubscriptions.length} Active
                  </span>
                )}
              </div>
              <p className="text-xs text-on-surface-variant mt-0.5">
                Signals from these wallets are automatically sized against your risk policy and executed on-chain.
              </p>
            </div>
            <button
              onClick={() => setShowTrackModal(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-primary text-white rounded-xl text-xs font-bold shadow-md shadow-primary/20 hover:opacity-90 transition-all cursor-pointer self-start sm:self-auto"
            >
              <span className="material-symbols-outlined text-base">person_add</span>
              <span>+ Track Custom Whale</span>
            </button>
          </div>

          {activeSubscriptions.length === 0 ? (
            <div className="text-center py-10 px-4 border border-dashed border-border-subtle rounded-xl bg-surface-container-low/40">
              <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto mb-3">
                <span className="material-symbols-outlined text-2xl">radar</span>
              </div>
              <h3 className="text-sm font-bold text-primary mb-1">No Active Master Subscriptions</h3>
              <p className="text-xs text-on-surface-variant max-w-md mx-auto mb-4">
                Track any high-conviction Polymarket, Solana, or Robinhood wallet to automatically backfill their history and mirror their trades forward.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  onClick={() => setShowTrackModal(true)}
                  className="px-4 py-2 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity flex items-center gap-1.5 cursor-pointer shadow-sm"
                >
                  <span className="material-symbols-outlined text-sm">add_circle</span>
                  <span>Enter Custom Wallet Address</span>
                </button>
                <a
                  href="#alpha-masters-section"
                  className="px-4 py-2 bg-surface-container hover:bg-surface-container-high border border-border-subtle text-xs font-semibold rounded-lg transition-colors"
                >
                  Browse Suggested Whales ↓
                </a>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {activeSubscriptions.map((s) => (
                <div
                  key={s.walletAddress}
                  className="p-4 bg-surface-container-low border border-border-subtle rounded-xl flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-primary truncate max-w-[160px]">
                        {s.label || s.walletAddress.slice(0, 10)}
                      </span>
                      <div className="flex items-center gap-1.5">
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-primary/10 text-primary border border-primary/30 uppercase">
                          {s.tier || 'speculative'}
                        </span>
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#14F195]/10 text-[#0E9F6E] dark:text-[#14F195] border border-[#14F195]/30">
                          SLOT #{s.membershipSlot ?? 1}/50
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <ChainBadge chain={s.chain} />
                      <span className="text-[11px] font-mono text-on-surface-variant">
                        Score: <strong>{s.compositeScore != null ? s.compositeScore : '--'}</strong>
                      </span>
                    </div>
                    <div className="text-xs font-mono text-on-surface-variant truncate mt-1 select-all">
                      {s.walletAddress}
                    </div>

                    <div className="grid grid-cols-2 gap-2 p-2 bg-surface-container rounded-lg text-xs mt-3 mb-2">
                      <div>
                        <span className="text-[10px] text-on-surface-variant block uppercase font-mono">Win Rate</span>
                        <span className={`font-bold font-mono ${s.winRate != null && s.winRate >= 50 ? 'text-status-success' : 'text-amber-500'}`}>
                          {s.winRate != null ? `${s.winRate}%` : 'Pending'}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] text-on-surface-variant block uppercase font-mono">Realized ROI</span>
                        <span className={`font-bold font-mono ${s.realizedRoi != null && s.realizedRoi >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                          {s.realizedRoi != null ? `${s.realizedRoi > 0 ? '+' : ''}${s.realizedRoi}%` : 'Pending'}
                        </span>
                      </div>
                    </div>

                    {(s.tier === 'speculative' || (s.realizedRoi != null && s.realizedRoi < 0)) && (
                      <div className="px-2.5 py-1.5 rounded-lg bg-status-error/10 border border-status-error/30 text-[11px] text-status-error flex items-center gap-1.5 mb-2">
                        <span className="material-symbols-outlined text-sm">warning</span>
                        <span className="font-semibold">Negative PnL / Speculative Tier</span>
                      </div>
                    )}
                  </div>

                  <div className="mt-3 pt-3 border-t border-border-subtle flex items-center justify-between text-xs">
                    <span className="text-status-success font-semibold flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
                      Mirroring Buys & Sells
                    </span>
                    <button
                      onClick={() => handleUnsubscribe(s.walletAddress)}
                      disabled={subscribingAddress === s.walletAddress}
                      className="text-[11px] text-on-surface-variant hover:text-status-error underline transition-colors"
                    >
                      {subscribingAddress === s.walletAddress ? 'Updating...' : 'Stop Copying'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Suggested Alpha Masters Section */}
        <section id="alpha-masters-section" className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6 mt-8 scroll-mt-20">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-headline-md text-lg font-bold text-primary">Explore & Copy Alpha Masters</h2>
              <p className="text-xs text-on-surface-variant">
                Top high-conviction traders discovered by the Wake Protocol intelligence daemon. 1-Click to mirror non-custodially.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {suggestedMasters.map((m) => {
              const isSubscribed = data?.subscriptions.some((s) => {
                if (s.state !== 'active') return false;
                const isSolana = m.chain === 'solana' || s.chain === 'solana';
                if (isSolana) {
                  // M-04: Base58 case-sensitive matching for Solana
                  const sAddr = s.walletAddress.replace(/^solana:/, '');
                  const mAddr = m.masterWalletAddress.replace(/^solana:/, '');
                  return sAddr === mAddr;
                }
                const sAddr = s.walletAddress.replace(/^[a-z0-9-]+:/, '').toLowerCase();
                const mAddr = m.masterWalletAddress.replace(/^[a-z0-9-]+:/, '').toLowerCase();
                return sAddr === mAddr;
              });

              return (
                <div
                  key={m.masterWalletAddress}
                  className="p-4 bg-surface-container-low border border-border-subtle rounded-xl flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold text-sm text-primary truncate max-w-[160px]">
                        {m.label || m.masterWalletAddress.slice(0, 10)}
                      </span>
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-primary/10 text-primary border border-primary/30 uppercase">
                        {m.tier}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 mb-2">
                      <ChainBadge chain={m.chain} />
                      <span className="text-[11px] font-mono text-on-surface-variant">
                        Score: <strong>{m.compositeScore}</strong>
                      </span>
                    </div>

                    <div className="text-xs font-mono text-on-surface-variant truncate mb-3">
                      {m.masterWalletAddress}
                    </div>

                    <div className="grid grid-cols-2 gap-2 p-2 bg-surface-container rounded-lg text-xs mb-3">
                      <div>
                        <span className="text-[10px] text-on-surface-variant block uppercase font-mono">Win Rate</span>
                        <span className="font-bold font-mono text-status-success">{m.winRate}%</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-on-surface-variant block uppercase font-mono">Realized ROI</span>
                        <span className="font-bold font-mono text-primary">+{m.realizedRoi}%</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-border-subtle flex items-center justify-between text-xs">
                    <span className="text-[11px] font-mono text-on-surface-variant">
                      Cap: {m.followerCount}/{m.followerCap}
                    </span>

                    {isSubscribed ? (
                      <span className="text-status-success font-semibold flex items-center gap-1 text-xs">
                        <span className="material-symbols-outlined text-sm">check</span>
                        <span>Active</span>
                      </span>
                    ) : (
                      <button
                        onClick={() => handleCopyMaster(m)}
                        disabled={subscribingAddress === m.masterWalletAddress}
                        className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                      >
                        {subscribingAddress === m.masterWalletAddress ? 'Copying...' : '+ Copy Master'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Track Custom Master Modal */}
        {showTrackModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
            <div className="bg-surface-container-lowest border border-border-subtle rounded-2xl w-full max-w-lg p-6 shadow-2xl relative">
              <div className="flex items-center justify-between pb-4 border-b border-border-subtle mb-5">
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full ${modalStep === 'scorecard' ? 'bg-status-success' : 'bg-primary'}`} />
                  <h3 className="font-headline-md text-lg font-bold text-primary">
                    {modalStep === 'form' && 'Track & Analyze Custom Master'}
                    {modalStep === 'analyzing' && 'Analyzing Trader History'}
                    {modalStep === 'scorecard' && 'Trader Alpha Scorecard'}
                  </h3>
                </div>
                <button
                  onClick={() => {
                    setShowTrackModal(false);
                    setModalStep('form');
                    setCustomError(null);
                  }}
                  className="text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-xl">close</span>
                </button>
              </div>

              {/* STEP 1: Input Form */}
              {modalStep === 'form' && (
                <form onSubmit={handleTrackCustom} className="space-y-4">
                  {customError && (
                    <div className="p-3 bg-status-error/10 border border-status-error/30 rounded-xl text-xs text-status-error flex items-start gap-2">
                      <span className="material-symbols-outlined text-sm mt-0.5">error</span>
                      <span>{customError}</span>
                    </div>
                  )}

                  {/* Chain Selector */}
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-on-surface-variant block mb-2">
                      Target Trading Chain
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { id: 'polygon', name: 'Polymarket', badge: 'Polygon (137)' },
                        { id: 'solana', name: 'Solana', badge: 'Mainnet-Beta' },
                        { id: 'robinhood-chain', name: 'Robinhood', badge: 'Arbitrum (4663)' },
                      ].map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => { setCustomChain(c.id as any); setCustomError(null); }}
                          className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                            customChain === c.id
                              ? 'border-primary bg-primary/10 text-primary font-bold shadow-sm'
                              : 'border-border-subtle bg-surface-container-low text-on-surface-variant hover:border-primary/50'
                          }`}
                        >
                          <div className="text-xs font-bold">{c.name}</div>
                          <div className="text-[10px] text-on-surface-variant font-mono">{c.badge}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Wallet Address Input */}
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-on-surface-variant block mb-1">
                      Master Wallet Address
                    </label>
                    <input
                      type="text"
                      required
                      value={customAddress}
                      onChange={(e) => setCustomAddress(e.target.value)}
                      placeholder={
                        customChain === 'solana'
                          ? 'Base58 Solana Address (e.g. 7xKXtg...)'
                          : 'Polygon 0x... Address (Safe Proxy or EOA)'
                      }
                      className="w-full bg-surface-container-low border border-border-subtle rounded-xl px-3.5 py-2.5 text-xs font-mono text-primary placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
                    />
                  </div>

                  {/* Label / Nickname Input */}
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wider text-on-surface-variant block mb-1">
                      Custom Label (Optional)
                    </label>
                    <input
                      type="text"
                      value={customLabel}
                      onChange={(e) => setCustomLabel(e.target.value)}
                      placeholder="e.g. Polymarket Whale Alpha"
                      className="w-full bg-surface-container-low border border-border-subtle rounded-xl px-3.5 py-2.5 text-xs text-primary placeholder:text-on-surface-variant/50 focus:outline-none focus:border-primary"
                    />
                  </div>

                  {/* Ingestion notice */}
                  <div className="p-3 bg-surface-container-low border border-border-subtle rounded-xl text-[11px] text-on-surface-variant space-y-1">
                    <div className="font-semibold text-primary flex items-center gap-1">
                      <span className="material-symbols-outlined text-sm text-status-success">timer</span>
                      <span>Review Before Mirroring</span>
                    </div>
                    <p>
                      Submitting starts background ingestion and quantitative scoring. You will inspect the trader's win rate, ROI, and composite score before any copy trades are executed.
                    </p>
                  </div>

                  <div className="flex items-center justify-end gap-3 pt-3 border-t border-border-subtle">
                    <button
                      type="button"
                      onClick={() => { setShowTrackModal(false); setCustomError(null); }}
                      className="px-4 py-2 text-xs font-semibold text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={trackingCustom || !customAddress.trim()}
                      className="px-5 py-2.5 bg-primary text-white rounded-xl text-xs font-bold shadow hover:opacity-90 transition-all disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
                    >
                      {trackingCustom ? (
                        <>
                          <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          <span>Enqueuing...</span>
                        </>
                      ) : (
                        <>
                          <span className="material-symbols-outlined text-sm">query_stats</span>
                          <span>Analyze Trader History</span>
                        </>
                      )}
                    </button>
                  </div>
                </form>
              )}

              {/* STEP 2: Analyzing State with 45s Countdown Timer */}
              {modalStep === 'analyzing' && (
                <div className="space-y-6 py-2">
                  <div className="text-center space-y-2">
                    <div className="relative w-16 h-16 mx-auto flex items-center justify-center">
                      <div className="absolute inset-0 rounded-full border-4 border-primary/20 border-t-primary animate-spin" />
                      <span className="material-symbols-outlined text-2xl text-primary animate-pulse">query_stats</span>
                    </div>
                    <h4 className="font-headline-md text-base font-bold text-primary">
                      Backfilling Historical Trades & Computing
                    </h4>
                    <p className="text-xs text-on-surface-variant max-w-sm mx-auto">
                      Backfilling historical trades & computing quant risk metrics from {customChain === 'polygon' ? 'Polymarket' : customChain === 'solana' ? 'Solana RPC' : 'Arbitrum'} before mirror execution.
                    </p>
                  </div>

                  {/* Progress Bar & Countdown */}
                  <div className="space-y-3 bg-surface-container-low p-4 rounded-xl border border-border-subtle">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-on-surface-variant">Backfilling historical trades & computing:</span>
                      <span className="font-bold text-primary">{Math.max(0, analysisSecondsLeft)}s remaining</span>
                    </div>
                    <div className="w-full bg-surface-container h-2.5 rounded-full overflow-hidden">
                      <div
                        className="bg-primary h-full transition-all duration-1000 ease-linear rounded-full"
                        style={{ width: `${Math.min(100, Math.round(((45 - analysisSecondsLeft) / 45) * 100))}%` }}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-on-surface-variant pt-1 font-mono">
                      <span>Target: <span className="text-primary">{customAddress.slice(0, 10)}...</span></span>
                      <span className="flex items-center gap-1 text-primary font-semibold">
                        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-ping" />
                        Live Ingesting
                      </span>
                    </div>
                  </div>

                  <div className="text-center pt-2">
                    <button
                      type="button"
                      onClick={() => { setShowTrackModal(false); setModalStep('form'); }}
                      className="text-xs text-on-surface-variant hover:text-primary underline cursor-pointer"
                    >
                      Run in background & return to dashboard
                    </button>
                  </div>
                </div>
              )}

              {/* STEP 3: Trader Scorecard Review */}
              {modalStep === 'scorecard' && (
                <div className="space-y-5">
                  <div className="flex items-center justify-between p-3.5 bg-surface-container-low rounded-xl border border-border-subtle">
                    <div>
                      <div className="text-[10px] text-on-surface-variant uppercase font-mono tracking-wider">Trader Scorecard Ready</div>
                      <div className="font-mono font-bold text-sm text-primary truncate max-w-[240px]">
                        {customLabel || analyzedMetrics?.address || customAddress}
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="px-2.5 py-1 rounded-full text-xs font-mono font-bold bg-primary/10 text-primary border border-primary/30 uppercase">
                        {analyzedMetrics?.tier || 'speculative'}
                      </span>
                    </div>
                  </div>

                  {/* Metrics Grid */}
                  <div className="grid grid-cols-3 gap-3">
                    <div className="p-3 bg-surface-container-low border border-border-subtle rounded-xl text-center">
                      <span className="text-[10px] text-on-surface-variant uppercase font-mono block">Composite Score</span>
                      <span className="text-xl font-bold font-mono text-primary">
                        {analyzedMetrics?.compositeScore != null ? analyzedMetrics.compositeScore : '--'}
                        <span className="text-xs text-on-surface-variant font-normal">/100</span>
                      </span>
                    </div>
                    <div className="p-3 bg-surface-container-low border border-border-subtle rounded-xl text-center">
                      <span className="text-[10px] text-on-surface-variant uppercase font-mono block">Win Rate</span>
                      <span className={`text-xl font-bold font-mono ${analyzedMetrics?.winRate != null && analyzedMetrics.winRate >= 50 ? 'text-status-success' : 'text-amber-500'}`}>
                        {analyzedMetrics?.winRate != null ? `${analyzedMetrics.winRate}%` : '--'}
                      </span>
                    </div>
                    <div className="p-3 bg-surface-container-low border border-border-subtle rounded-xl text-center">
                      <span className="text-[10px] text-on-surface-variant uppercase font-mono block">Realized ROI</span>
                      <span className={`text-xl font-bold font-mono ${analyzedMetrics?.realizedRoi != null && analyzedMetrics.realizedRoi >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                        {analyzedMetrics?.realizedRoi != null ? `${analyzedMetrics.realizedRoi > 0 ? '+' : ''}${analyzedMetrics.realizedRoi}%` : '--'}
                      </span>
                    </div>
                  </div>

                  <div className="px-3 py-2 bg-surface-container rounded-lg text-xs font-mono text-on-surface-variant flex items-center justify-between">
                    <span>Total Historical Trades:</span>
                    <span className="font-bold text-primary">{analyzedMetrics?.totalTrades ? analyzedMetrics.totalTrades.toLocaleString() : '0'} Trades</span>
                  </div>

                  {/* Risk Warning / Endorsement Callout */}
                  {analyzedMetrics && (analyzedMetrics.tier === 'speculative' || (analyzedMetrics.realizedRoi != null && analyzedMetrics.realizedRoi < 0)) ? (
                    <div className="p-3.5 bg-status-error/10 border border-status-error/30 rounded-xl text-xs space-y-1 text-status-error">
                      <div className="font-bold flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-base">warning</span>
                        <span>High Downside Risk Warning</span>
                      </div>
                      <p className="text-[11px] leading-relaxed opacity-90">
                        This trader has an unprofitable track record ({analyzedMetrics.realizedRoi}% Realized ROI, {analyzedMetrics.winRate}% win rate across {analyzedMetrics.totalTrades.toLocaleString()} trades). Copying trades from this wallet carries significant downside risk.
                      </p>
                    </div>
                  ) : (
                    <div className="p-3.5 bg-status-success/10 border border-status-success/30 rounded-xl text-xs space-y-1 text-status-success">
                      <div className="font-bold flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-base">verified</span>
                        <span>Performance Verified</span>
                      </div>
                      <p className="text-[11px] leading-relaxed opacity-90">
                        Consistent track record and positive ROI. Mirrored orders will be dynamically sized within your risk limits.
                      </p>
                    </div>
                  )}

                  {/* Explicit Decision Actions */}
                  <div className="flex items-center justify-end gap-3 pt-3 border-t border-border-subtle">
                    <button
                      type="button"
                      onClick={handleRejectScorecard}
                      className="px-4 py-2 text-xs font-bold text-status-error hover:bg-status-error/10 rounded-xl transition-colors cursor-pointer"
                    >
                      Cancel & Do Not Copy
                    </button>
                    <button
                      type="button"
                      onClick={handleConfirmScorecard}
                      className="px-5 py-2.5 bg-primary text-white rounded-xl text-xs font-bold shadow hover:opacity-90 transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-sm">check_circle</span>
                      <span>Confirm & Mirror Buys/Sells</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
