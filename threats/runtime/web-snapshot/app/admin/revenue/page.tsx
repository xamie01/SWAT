'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { AdminNav } from '../../../components/AdminNav.js';
import { TierBadge, LoadingSkeleton } from '../../../components/UIPrimitives.js';
import { api } from '../../../lib/api.js';
import { copyToClipboard } from '../../../lib/wallets.js';

interface SubscriberUser {
  id: string;
  email: string;
  role: string;
  tier: string;
  createdAt: string;
  totalCashFloatUsd: number;
}

export default function AdminRevenuePage() {
  const [users, setUsers] = useState<SubscriberUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await api.get<{ users: SubscriberUser[] }>('/v1/admin/portfolio/users?page=1&limit=100');
      if (res?.users) {
        setUsers(res.users);
      }
    } catch (err) {
      console.error('Failed to load user subscriptions for revenue ledger:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (text: string, key: string) => {
    if (copyToClipboard(text)) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 2000);
    }
  };

  // Derive counts and metrics
  const freeCount = users.filter((u) => u.tier === 'free').length;
  const operatorCount = users.filter((u) => u.tier === 'operator').length;
  const ultraCount = users.filter((u) => u.tier === 'ultra').length;
  const lifetimeCount = users.filter((u) => u.tier === 'lifetime').length;

  const totalPaidSubscribers = operatorCount + ultraCount + lifetimeCount;
  const mrrUsd = operatorCount * 35 + ultraCount * 150;
  const cumulativeRevenueUsd = mrrUsd + lifetimeCount * 1999;

  const plans = [
    {
      id: 'free',
      name: 'Starter (View-Only)',
      price: '$0 / mo',
      count: freeCount,
      features: 'Mempool telemetry, token discovery stream, cluster viewing',
      mrr: '$0',
      badgeColor: 'border-slate-500/30 text-slate-400 bg-slate-500/10',
    },
    {
      id: 'operator',
      name: 'Operator Tier',
      price: '$35 / mo',
      count: operatorCount,
      features: 'Autonomous live copy trading, 25 tracked wallets across Solana, Robinhood, and Polymarket, instant signals',
      mrr: `$${(operatorCount * 35).toLocaleString()}`,
      badgeColor: 'border-[#14F195]/30 text-[#0E9F6E] dark:text-[#14F195] bg-[#14F195]/10',
    },
    {
      id: 'ultra',
      name: 'Ultra Tier',
      price: '$150 / mo',
      count: ultraCount,
      features: 'Unlimited tracked wallets, dynamic custom EVM chains, maximum contract backfill depth, priority execution',
      mrr: `$${(ultraCount * 150).toLocaleString()}`,
      badgeColor: 'border-[#8B5CF6]/30 text-[#8B5CF6] bg-[#8B5CF6]/10',
    },
    {
      id: 'lifetime',
      name: 'Lifetime Pass',
      price: '$1,999 once',
      count: lifetimeCount,
      features: 'Permanent Ultra tier access, bespoke cluster scoring API, VIP routing (Zero monthly renewals)',
      mrr: `$${(lifetimeCount * 1999).toLocaleString()} (Fixed)`,
      badgeColor: 'border-[#FFB800]/30 text-[#B45309] dark:text-[#FFB800] bg-[#FFB800]/10',
    },
  ];

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      <AdminNav />

      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#14F195]/10 text-[#0E9F6E] dark:text-[#14F195] border border-[#14F195]/30">
                ON-CHAIN FINANCIALS
              </span>
              <span className="text-xs text-on-surface-variant font-mono">ADR-0063 USDC BILLING</span>
            </div>
            <h1 className="font-headline-lg text-2xl sm:text-3xl font-bold tracking-tight text-primary">
              Operator SaaS Revenue &amp; Subscriptions
            </h1>
            <p className="text-body-sm text-on-surface-variant max-w-2xl mt-1">
              Live audit of platform revenue, subscription tier retention, on-chain treasury floats, and verified crypto billing intents.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={fetchUsers}
              className="px-3.5 py-2 bg-surface-container hover:bg-surface-container-high border border-border-subtle rounded-lg text-xs font-semibold text-primary transition-colors flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-sm">refresh</span>
              <span>Sync Ledgers</span>
            </button>
            <Link
              href="/admin/portfolio"
              className="px-3.5 py-2 bg-primary text-white text-xs font-bold rounded-lg hover:opacity-90 transition-opacity flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-sm">hub</span>
              <span>Trading Matrix</span>
            </Link>
          </div>
        </div>

        {/* 1. Executive Revenue KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 shadow-sm">
            <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider block mb-1">
              Monthly Recurring Revenue (MRR)
            </span>
            <div className="font-mono text-2xl font-bold text-primary">
              ${mrrUsd.toLocaleString()} <span className="text-xs text-on-surface-variant font-normal">USDC/mo</span>
            </div>
            <p className="text-[11px] text-status-success font-medium mt-1">
              ↑ 100% On-Chain Non-Custodial
            </p>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 shadow-sm">
            <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider block mb-1">
              Active Paid Subscribers
            </span>
            <div className="font-mono text-2xl font-bold text-primary">
              {totalPaidSubscribers}{' '}
              <span className="text-xs text-on-surface-variant font-normal">/ {users.length} total users</span>
            </div>
            <p className="text-[11px] text-on-surface-variant mt-1">
              {users.length > 0 ? ((totalPaidSubscribers / users.length) * 100).toFixed(1) : 0}% Paid Conversion Rate
            </p>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 shadow-sm">
            <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider block mb-1">
              Cumulative Platform Revenue
            </span>
            <div className="font-mono text-2xl font-bold text-[#14F195]">
              ${cumulativeRevenueUsd.toLocaleString()} <span className="text-xs text-on-surface-variant font-normal">USDC</span>
            </div>
            <p className="text-[11px] text-on-surface-variant mt-1">
              Zero Chargeback &amp; Zero Intermediary Risk
            </p>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5 shadow-sm">
            <span className="text-[11px] font-bold text-on-surface-variant uppercase tracking-wider block mb-1">
              Active Billing Protocol
            </span>
            <div className="font-mono text-lg font-bold text-primary truncate mt-1">
              Solana &amp; Polygon USDC
            </div>
            <p className="text-[11px] text-on-surface-variant mt-1">
              Direct On-Chain Treasury Routing
            </p>
          </div>
        </div>

        {/* 2. Tier Breakdown Matrix */}
        <section className="bg-surface-container-lowest border border-border-subtle rounded-xl overflow-hidden mb-8 shadow-sm">
          <div className="p-5 border-b border-border-subtle flex items-center justify-between">
            <div>
              <h2 className="font-headline-md text-base font-bold text-primary">Subscription Tier Breakdown</h2>
              <p className="text-xs text-on-surface-variant">Active subscriber retention and feature limits per tier.</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-surface-container border-b border-border-subtle font-mono uppercase text-on-surface-variant">
                  <th className="p-4 font-semibold">Tier</th>
                  <th className="p-4 font-semibold">Price</th>
                  <th className="p-4 font-semibold">Active Subscribers</th>
                  <th className="p-4 font-semibold">Execution Limits</th>
                  <th className="p-4 font-semibold text-right">Contribution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {plans.map((p) => (
                  <tr key={p.id} className="hover:bg-surface-container/50 transition-colors">
                    <td className="p-4">
                      <span className={`px-2 py-1 rounded font-bold font-mono text-[11px] border ${p.badgeColor}`}>
                        {p.name}
                      </span>
                    </td>
                    <td className="p-4 font-mono font-bold text-primary">{p.price}</td>
                    <td className="p-4 font-mono text-primary">
                      <strong>{p.count}</strong> subscriber{p.count === 1 ? '' : 's'}
                    </td>
                    <td className="p-4 text-on-surface-variant">{p.features}</td>
                    <td className="p-4 font-mono font-bold text-right text-primary">{p.mrr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 3. Protocol Treasury Addresses & Balances */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-[#14F195]" />
                <h3 className="font-bold text-primary text-base">Solana Treasury Wallet</h3>
              </div>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#14F195]/10 text-[#0E9F6E] dark:text-[#14F195] border border-[#14F195]/30">
                SPL USDC
              </span>
            </div>
            <p className="text-xs text-on-surface-variant mb-4">
              Receiving destination for Solana USDC subscriptions and gas float deposits.
            </p>
            <div className="p-3 bg-surface-container-low rounded-lg border border-border-subtle font-mono text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-on-surface-variant uppercase font-semibold">Address</span>
                <button
                  type="button"
                  onClick={() => handleCopy('WAKETreasurySolana1111111111111111111111111', 'sol-treasury')}
                  className="text-[10px] text-primary underline font-bold"
                >
                  {copiedKey === 'sol-treasury' ? <span className="text-status-success">✓ Copied!</span> : 'Copy'}
                </button>
              </div>
              <div className="font-bold text-primary truncate select-all">
                WAKETreasurySolana1111111111111111111111111
              </div>
            </div>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-[#8B5CF6]" />
                <h3 className="font-bold text-primary text-base">Polygon Treasury Wallet</h3>
              </div>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#8B5CF6]/10 text-[#8B5CF6] border border-[#8B5CF6]/30">
                ERC-20 USDC
              </span>
            </div>
            <p className="text-xs text-on-surface-variant mb-4">
              Receiving destination for Polygon USDC subscriptions and Polymarket prediction float deposits.
            </p>
            <div className="p-3 bg-surface-container-low rounded-lg border border-border-subtle font-mono text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-on-surface-variant uppercase font-semibold">Address</span>
                <button
                  type="button"
                  onClick={() => handleCopy('0xWAKETreasuryPolygon00000000000000000000000', 'poly-treasury')}
                  className="text-[10px] text-primary underline font-bold"
                >
                  {copiedKey === 'poly-treasury' ? <span className="text-status-success">✓ Copied!</span> : 'Copy'}
                </button>
              </div>
              <div className="font-bold text-primary truncate select-all">
                0xWAKETreasuryPolygon00000000000000000000000
              </div>
            </div>
          </div>
        </section>

        {/* 4. Active Subscriber Ledger */}
        <section className="bg-surface-container-lowest border border-border-subtle rounded-xl overflow-hidden shadow-sm">
          <div className="p-5 border-b border-border-subtle">
            <h2 className="font-headline-md text-base font-bold text-primary">Registered Accounts &amp; Subscription Ledger</h2>
            <p className="text-xs text-on-surface-variant">Live audit of all provisioned accounts across the protocol.</p>
          </div>

          {loading ? (
            <div className="p-6">
              <LoadingSkeleton rows={4} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-surface-container border-b border-border-subtle font-mono uppercase text-on-surface-variant">
                    <th className="p-4 font-semibold">User</th>
                    <th className="p-4 font-semibold">Role</th>
                    <th className="p-4 font-semibold">Tier</th>
                    <th className="p-4 font-semibold">Created At</th>
                    <th className="p-4 font-semibold text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-surface-container/50 transition-colors">
                      <td className="p-4">
                        <div className="font-bold text-primary">{u.email}</div>
                        <div className="font-mono text-[10px] text-on-surface-variant">{u.id}</div>
                      </td>
                      <td className="p-4">
                        <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-surface-container text-on-surface-variant uppercase">
                          {u.role}
                        </span>
                      </td>
                      <td className="p-4">
                        <TierBadge tier={u.tier} />
                      </td>
                      <td className="p-4 font-mono text-on-surface-variant">
                        {new Date(u.createdAt).toLocaleDateString()}
                      </td>
                      <td className="p-4 text-right">
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-status-success/10 text-status-success border border-status-success/30 uppercase">
                          ACTIVE
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
