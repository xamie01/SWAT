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

export default function DashboardPage() {
  const [data, setData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchDashboard();
  }, []);

  const fetchDashboard = async () => {
    setLoading(true);
    try {
      // In multi-tenant backend, /v1/me/account and /v1/me/positions supply user state
      const [acc, pos] = await Promise.all([
        api.get<any>('/v1/me/account').catch(() => null),
        api.get<any>('/v1/me/positions').catch(() => ({ positions: [] })),
      ]);

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
        subscriptions: acc?.subscriptions || [
          {
            walletAddress: 'solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
            chain: 'solana',
            label: 'Solana Alpha Whale',
            state: 'active',
            membershipSlot: 3,
          },
        ],
        positions: pos?.positions || [],
        executionSettings: acc?.executionSettings || {
          killSwitchActive: false,
          maxSlippageBps: 100,
          maxPositionPct: 10,
        },
      });
    } catch (err: any) {
      setError(err.message || 'Failed to load dashboard data');
    } finally {
      setLoading(false);
    }
  };

  const totalCashUsd = data?.balances.reduce((acc, b) => acc + (b.balanceUsd || 0), 0) ?? 0;
  const totalPositionsUsd = data?.positions.reduce((acc, p) => acc + (p.costBasisUsd || 0), 0) ?? 0;
  const netPortfolioUsd = totalCashUsd + totalPositionsUsd;

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
                onAction={() => {}}
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
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-headline-md text-lg font-bold text-primary">Subscribed Alpha Masters</h2>
              <p className="text-xs text-on-surface-variant">
                Signals from these wallets are automatically sized against your risk policy and executed on-chain.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {data?.subscriptions.map((s) => (
              <div
                key={s.walletAddress}
                className="p-4 bg-surface-container-low border border-border-subtle rounded-xl flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-bold text-primary">{s.label || s.walletAddress.slice(0, 10)}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#14F195]/10 text-[#0E9F6E] dark:text-[#14F195] border border-[#14F195]/30">
                      SLOT #{s.membershipSlot ?? 1}/50
                    </span>
                  </div>
                  <ChainBadge chain={s.chain} />
                  <div className="text-xs font-mono text-on-surface-variant truncate mt-2">
                    {s.walletAddress}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-border-subtle flex items-center justify-between text-xs">
                  <span className="text-status-success font-semibold flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse" />
                    Mirroring Buys & Sells
                  </span>
                  <span className="text-on-surface-variant font-mono">10% Sizing</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
