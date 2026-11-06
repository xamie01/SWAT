'use client';

import React, { useState, useEffect } from 'react';
import { AdminNav } from '../../../components/AdminNav.js';
import { ChainBadge, TierBadge, LoadingSkeleton, ErrorBanner } from '../../../components/UIPrimitives.js';
import { api, resolveApiBase } from '../../../lib/api.js';

interface Overview {
  totalFleetAumUsd: number;
  netRealizedPnlUsd: number;
  netRealizedPnl24hUsd: number;
  unrealizedPnlUsd: number;
  fleetWinRatePct: number;
  cumulativeGasTipBurnUsd: number;
  totalCopiersActive: number;
  openPositionsCount: number;
}

interface UserSummary {
  id: string;
  email: string;
  role: string;
  tier: string;
  createdAt: string;
  tierExpiresAt: string | null;
  gracePeriodEndsAt: string | null;
  custodyStatus: Record<string, string>;
  totalCashFloatUsd: number;
  copiedMasters: Array<{
    masterAddress: string;
    label: string | null;
    chain: string;
    state: string;
    membershipSlot: number | null;
  }>;
  openPositionsCount: number;
  openPositionsValueUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  trades24hCount: number;
  killSwitchActive: boolean;
}

interface MasterSummary {
  masterWalletAddress: string;
  chain: string;
  label: string | null;
  followerCount: number;
  followerCap: number;
  totalFollowerCapitalUsd: number;
  copierRealizedPnlUsd: number;
  avgCopierSlippageBps: number;
  copierWinRatePct: number;
}

interface TokenSummary {
  tokenMint: string;
  tokenSymbol: string | null;
  chain: string;
  totalHolders: number;
  totalQuantity: number;
  totalExposureUsd: number;
  concentrationPct: number;
}

export default function AdminPortfolioPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [totalUsers, setTotalUsers] = useState<number>(0);
  const [masters, setMasters] = useState<MasterSummary[]>([]);
  const [tokens, setTokens] = useState<TokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [tierFilter, setTierFilter] = useState('');
  const [page, setPage] = useState(1);

  // Drilldown drawer state
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [userDetail, setUserDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'positions' | 'masters' | 'executions'>('positions');

  // Export drawer state
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportType, setExportType] = useState<'users' | 'positions' | 'executions' | 'masters'>('users');
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv');

  const fetchOverview = async () => {
    try {
      const data = await api.get<Overview>('/v1/admin/portfolio/overview');
      setOverview(data);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch overview metrics');
    }
  };

  const fetchUsers = async () => {
    try {
      const query = new URLSearchParams({
        page: page.toString(),
        limit: '25',
        ...(search ? { search } : {}),
        ...(tierFilter ? { tier: tierFilter } : {}),
      });
      const data = await api.get<{ users: UserSummary[]; total: number }>(`/v1/admin/portfolio/users?${query}`);
      setUsers(data.users);
      setTotalUsers(data.total);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch user trading matrix');
    }
  };

  const fetchMastersAndTokens = async () => {
    try {
      const [mRes, tRes] = await Promise.all([
        api.get<{ masters: MasterSummary[] }>('/v1/admin/portfolio/masters'),
        api.get<{ tokens: TokenSummary[] }>('/v1/admin/portfolio/tokens'),
      ]);
      setMasters(mRes.masters);
      setTokens(tRes.tokens);
    } catch (err: any) {
      // Non-fatal
    }
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchOverview(), fetchUsers(), fetchMastersAndTokens()]).finally(() => {
      setLoading(false);
    });
  }, [page, tierFilter]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchUsers();
  };

  const openUserDrillDown = async (userId: string) => {
    setSelectedUserId(userId);
    setDetailLoading(true);
    try {
      const detail = await api.get(`/v1/admin/portfolio/users/${userId}`);
      setUserDetail(detail);
    } catch (err: any) {
      alert(`Could not load user detail: ${err.message}`);
    } finally {
      setDetailLoading(false);
    }
  };

  const triggerExport = async () => {
    try {
      const apiUrl = resolveApiBase(typeof window !== 'undefined' ? window.location : null);
      const url = `${apiUrl}/v1/admin/portfolio/export?type=${exportType}&format=${exportFormat}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        throw new Error(`Export failed: HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `wake-${exportType}-export.${exportFormat}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);
      setShowExportModal(false);
    } catch (err: any) {
      alert(`Export error: ${err.message}`);
    }
  };

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      <AdminNav />

      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* Page Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">
              Fleet Portfolio & Copy-Trading Matrix
            </h1>
            <p className="text-body-sm text-on-surface-variant">
              Cross-user trading oversight, master attribution intelligence, and multi-tenant custody telemetry.
            </p>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={() => setShowExportModal(true)}
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 bg-surface-container-high hover:bg-surface-dim border border-border-subtle rounded-lg text-xs sm:text-sm font-semibold transition-colors"
            >
              <span className="material-symbols-outlined text-base">download</span>
              <span>Export Data</span>
            </button>
            <button
              onClick={() => {
                setLoading(true);
                Promise.all([fetchOverview(), fetchUsers(), fetchMastersAndTokens()]).finally(() => setLoading(false));
              }}
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 px-3 sm:px-4 py-2 bg-primary text-white rounded-lg text-xs sm:text-sm font-semibold hover:opacity-90 transition-opacity"
            >
              <span className="material-symbols-outlined text-base">refresh</span>
              <span>Sync Fleet</span>
            </button>
          </div>
        </div>

        {error && <div className="mb-6"><ErrorBanner message={error} onRetry={() => setError(null)} /></div>}

        {/* 1. Fleet-Wide KPI Banner */}
        <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4 mb-8">
          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Total Fleet AUM
            </span>
            <div className="text-xl font-bold font-mono text-primary mt-1">
              ${overview ? overview.totalFleetAumUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '0.00'}
            </div>
            <span className="text-[11px] text-on-surface-variant">Float + Positions</span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Net Realized P&L
            </span>
            <div
              className={`text-xl font-bold font-mono mt-1 ${
                overview && overview.netRealizedPnlUsd >= 0 ? 'text-status-success' : 'text-status-error'
              }`}
            >
              ${overview ? overview.netRealizedPnlUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '0.00'}
            </div>
            <span className="text-[11px] text-on-surface-variant">All-Time Fleet P&L</span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              24h Realized P&L
            </span>
            <div
              className={`text-xl font-bold font-mono mt-1 ${
                overview && overview.netRealizedPnl24hUsd >= 0 ? 'text-status-success' : 'text-status-error'
              }`}
            >
              ${overview ? overview.netRealizedPnl24hUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '0.00'}
            </div>
            <span className="text-[11px] text-on-surface-variant">Past 24 Hours</span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Fleet Win Rate
            </span>
            <div className="text-xl font-bold font-mono text-[#0E9F6E] dark:text-solana-teal mt-1">
              {overview ? overview.fleetWinRatePct : 0}%
            </div>
            <span className="text-[11px] text-on-surface-variant">Closed Lots</span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Gas & Tip Burn
            </span>
            <div className="text-xl font-bold font-mono text-status-warning mt-1">
              ${overview ? overview.cumulativeGasTipBurnUsd.toLocaleString('en-US', { minimumFractionDigits: 2 }) : '0.00'}
            </div>
            <span className="text-[11px] text-on-surface-variant">Solana / EVM Tips</span>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4">
            <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
              Active Copiers
            </span>
            <div className="text-xl font-bold font-mono text-primary mt-1">
              {overview ? overview.totalCopiersActive : 0}
            </div>
            <span className="text-[11px] text-on-surface-variant">
              {overview ? overview.openPositionsCount : 0} Open Positions
            </span>
          </div>
        </section>

        {/* 2. User-by-User Trading Matrix */}
        <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6 mb-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
            <div>
              <h2 className="font-headline-md text-lg font-bold text-primary">Multi-Tenant User Trading Matrix</h2>
              <span className="text-body-sm text-on-surface-variant">
                Showing {users.length} of {totalUsers} registered users
              </span>
            </div>

            <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 w-full md:w-auto">
              <input
                type="text"
                placeholder="Search email or UUID..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="px-3 py-1.5 bg-surface-container border border-border-subtle rounded-lg text-sm outline-none focus:border-primary w-full sm:w-64"
              />
              <div className="flex gap-2">
                <select
                  value={tierFilter}
                  onChange={(e) => {
                    setTierFilter(e.target.value);
                    setPage(1);
                  }}
                  className="flex-1 sm:flex-none px-3 py-1.5 bg-surface-container border border-border-subtle rounded-lg text-sm outline-none focus:border-primary"
                >
                  <option value="">All Tiers</option>
                  <option value="free">Free</option>
                  <option value="operator">Operator</option>
                  <option value="ultra">Ultra</option>
                  <option value="lifetime">Lifetime</option>
                </select>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-primary text-white text-sm font-semibold rounded-lg hover:opacity-90 transition-opacity"
                >
                  Filter
                </button>
              </div>
            </form>
          </div>

          {loading ? (
            <LoadingSkeleton rows={5} />
          ) : users.length === 0 ? (
            <div className="text-center py-12 text-on-surface-variant text-sm">
              No users found matching query criteria.
            </div>
          ) : (
            <div className="overflow-x-auto -mx-6 px-6 sm:mx-0 sm:px-0">
              <table className="w-full text-left text-sm min-w-[850px]">
                <thead>
                  <tr className="border-b border-border-subtle text-on-surface-variant text-[11px] font-mono uppercase tracking-wider">
                    <th className="pb-3 font-semibold">User</th>
                    <th className="pb-3 font-semibold">Tier</th>
                    <th className="pb-3 font-semibold">Custody Grants</th>
                    <th className="pb-3 font-semibold">Cash Float</th>
                    <th className="pb-3 font-semibold">Copied Masters</th>
                    <th className="pb-3 font-semibold">Open Positions</th>
                    <th className="pb-3 font-semibold">Realized P&L</th>
                    <th className="pb-3 font-semibold">24h Ops</th>
                    <th className="pb-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {users.map((u) => (
                    <tr key={u.id} className="hover:bg-surface-container-low transition-colors">
                      <td className="py-4">
                        <div className="font-semibold text-primary">{u.email}</div>
                        <div className="font-mono text-[11px] text-on-surface-variant">{u.id.slice(0, 13)}...</div>
                      </td>
                      <td className="py-4">
                        <TierBadge tier={u.tier} />
                      </td>
                      <td className="py-4">
                        <div className="flex flex-wrap gap-1">
                          {Object.keys(u.custodyStatus).length === 0 ? (
                            <span className="text-xs text-on-surface-variant italic">None</span>
                          ) : (
                            Object.entries(u.custodyStatus).map(([chain, grant]) => (
                              <span
                                key={chain}
                                className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-surface-container text-on-surface-variant border border-border-subtle"
                              >
                                {chain}: {grant}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="py-4 font-mono font-medium text-primary">
                        ${u.totalCashFloatUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-4">
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {u.copiedMasters.length === 0 ? (
                            <span className="text-xs text-on-surface-variant italic">0 masters</span>
                          ) : (
                            u.copiedMasters.map((m) => (
                              <span
                                key={m.masterAddress}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-surface-container border border-border-subtle"
                              >
                                <span className="font-semibold">{m.label || m.masterAddress.slice(0, 8)}</span>
                                {m.membershipSlot !== null && (
                                  <span className="text-[10px] text-on-surface-variant">#{m.membershipSlot}/50</span>
                                )}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="py-4">
                        <div className="font-mono font-medium text-primary">
                          {u.openPositionsCount} pos (${u.openPositionsValueUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })})
                        </div>
                      </td>
                      <td className="py-4">
                        <span
                          className={`font-mono font-semibold ${
                            u.realizedPnlUsd >= 0 ? 'text-status-success' : 'text-status-error'
                          }`}
                        >
                          ${u.realizedPnlUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </span>
                      </td>
                      <td className="py-4 font-mono text-on-surface-variant">
                        {u.trades24hCount}
                      </td>
                      <td className="py-4 text-right">
                        <button
                          onClick={() => openUserDrillDown(u.id)}
                          className="px-3 py-1 bg-surface-container hover:bg-surface-container-high border border-border-subtle rounded text-xs font-semibold text-primary transition-colors"
                        >
                          Drill Down
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-border-subtle pt-4 mt-4">
            <span className="text-xs text-on-surface-variant">
              Page {page} of {Math.max(1, Math.ceil(totalUsers / 25))}
            </span>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-3 py-1 bg-surface-container rounded border border-border-subtle text-xs font-semibold disabled:opacity-40"
              >
                Previous
              </button>
              <button
                disabled={page >= Math.ceil(totalUsers / 25)}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 bg-surface-container rounded border border-border-subtle text-xs font-semibold disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </section>

        {/* 3. Bottom Grid: Master Alpha & Fleet Token Concentration */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Master Alpha Board */}
          <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-headline-md text-lg font-bold text-primary">Master Alpha & Follower Profitability</h2>
              <span className="text-xs text-on-surface-variant font-mono">CAP 50/MASTER</span>
            </div>
            <div className="overflow-x-auto -mx-6 px-6 sm:mx-0 sm:px-0">
              <table className="w-full text-left text-sm min-w-[520px]">
                <thead>
                  <tr className="border-b border-border-subtle text-on-surface-variant text-[11px] font-mono uppercase">
                    <th className="pb-2">Master Wallet</th>
                    <th className="pb-2">Members</th>
                    <th className="pb-2">Follower Float</th>
                    <th className="pb-2">Copier P&L</th>
                    <th className="pb-2 text-right">Win Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {masters.map((m) => (
                    <tr key={m.masterWalletAddress} className="hover:bg-surface-container-low">
                      <td className="py-3">
                        <div className="font-semibold text-primary">{m.label || m.masterWalletAddress.slice(0, 12)}</div>
                        <ChainBadge chain={m.chain} />
                      </td>
                      <td className="py-3 font-mono font-medium">
                        <span className={m.followerCount >= 45 ? 'text-status-warning font-bold' : ''}>
                          {m.followerCount}/{m.followerCap}
                        </span>
                      </td>
                      <td className="py-3 font-mono">
                        ${m.totalFollowerCapitalUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 font-mono font-semibold">
                        <span className={m.copierRealizedPnlUsd >= 0 ? 'text-status-success' : 'text-status-error'}>
                          ${m.copierRealizedPnlUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </span>
                      </td>
                      <td className="py-3 text-right font-mono font-bold text-[#0E9F6E] dark:text-solana-teal">
                        {m.copierWinRatePct}%
                      </td>
                    </tr>
                  ))}
                  {masters.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-on-surface-variant text-xs italic">
                        No active master allocations indexed yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Fleet Token Concentration */}
          <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-headline-md text-lg font-bold text-primary">Fleet Token Concentration Heatmap</h2>
              <span className="text-xs text-on-surface-variant font-mono">SYSTEMIC RISK</span>
            </div>
            <div className="overflow-x-auto -mx-6 px-6 sm:mx-0 sm:px-0">
              <table className="w-full text-left text-sm min-w-[520px]">
                <thead>
                  <tr className="border-b border-border-subtle text-on-surface-variant text-[11px] font-mono uppercase">
                    <th className="pb-2">Token</th>
                    <th className="pb-2">Holders</th>
                    <th className="pb-2">Fleet Exposure</th>
                    <th className="pb-2 text-right">Pool Conc. %</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {tokens.map((t) => (
                    <tr key={t.tokenMint} className="hover:bg-surface-container-low">
                      <td className="py-3">
                        <div className="font-semibold text-primary">{t.tokenSymbol}</div>
                        <div className="font-mono text-[10px] text-on-surface-variant">{t.tokenMint.slice(0, 16)}...</div>
                      </td>
                      <td className="py-3 font-mono">{t.totalHolders} copiers</td>
                      <td className="py-3 font-mono font-semibold text-primary">
                        ${t.totalExposureUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </td>
                      <td className="py-3 text-right font-mono">
                        <span
                          className={`px-2 py-0.5 rounded text-xs font-bold ${
                            t.concentrationPct > 5
                              ? 'bg-status-error/10 text-status-error border border-status-error/30'
                              : 'text-on-surface-variant'
                          }`}
                        >
                          {t.concentrationPct}%
                        </span>
                      </td>
                    </tr>
                  ))}
                  {tokens.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-on-surface-variant text-xs italic">
                        No open positions held across the fleet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* 4. Single-User Drilldown Drawer */}
        {selectedUserId && (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex justify-end animate-fade-in">
            <div className="w-full max-w-2xl bg-surface-container-lowest h-full overflow-y-auto p-6 flex flex-col shadow-2xl">
              <div className="flex items-center justify-between border-b border-border-subtle pb-4 mb-6">
                <div>
                  <h3 className="font-headline-md text-xl font-bold text-primary">User Trading Dossier</h3>
                  <span className="text-xs font-mono text-on-surface-variant">{selectedUserId}</span>
                </div>
                <button
                  onClick={() => setSelectedUserId(null)}
                  className="p-2 rounded-lg hover:bg-surface-container text-on-surface-variant"
                >
                  <span className="material-symbols-outlined text-xl">close</span>
                </button>
              </div>

              {detailLoading || !userDetail ? (
                <LoadingSkeleton rows={6} />
              ) : (
                <div className="space-y-6">
                  {/* User Profile Bar */}
                  <div className="bg-surface-container-high/40 rounded-xl p-4 border border-border-subtle grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                    <div>
                      <span className="text-[11px] text-on-surface-variant uppercase font-semibold">Email</span>
                      <div className="font-semibold text-primary truncate">{userDetail.user.email}</div>
                    </div>
                    <div>
                      <span className="text-[11px] text-on-surface-variant uppercase font-semibold">Tier</span>
                      <div><TierBadge tier={userDetail.user.tier} /></div>
                    </div>
                    <div>
                      <span className="text-[11px] text-on-surface-variant uppercase font-semibold">Kill Switch</span>
                      <div className="font-mono font-bold text-xs">
                        {userDetail.user.killSwitchActive ? (
                          <span className="text-status-error">ACTIVE</span>
                        ) : (
                          <span className="text-status-success">NORMAL</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <span className="text-[11px] text-on-surface-variant uppercase font-semibold">Slippage Cap</span>
                      <div className="font-mono font-bold text-xs">{userDetail.user.maxSlippageBps} bps</div>
                    </div>
                  </div>

                  {/* Tabs */}
                  <div className="flex border-b border-border-subtle gap-4">
                    <button
                      onClick={() => setActiveTab('positions')}
                      className={`pb-2 text-sm font-semibold border-b-2 transition-colors ${
                        activeTab === 'positions'
                          ? 'border-primary text-primary'
                          : 'border-transparent text-on-surface-variant hover:text-primary'
                      }`}
                    >
                      Open Positions ({userDetail.openPositions.length})
                    </button>
                    <button
                      onClick={() => setActiveTab('masters')}
                      className={`pb-2 text-sm font-semibold border-b-2 transition-colors ${
                        activeTab === 'masters'
                          ? 'border-primary text-primary'
                          : 'border-transparent text-on-surface-variant hover:text-primary'
                      }`}
                    >
                      Subscribed Masters ({userDetail.subscriptions.length})
                    </button>
                    <button
                      onClick={() => setActiveTab('executions')}
                      className={`pb-2 text-sm font-semibold border-b-2 transition-colors ${
                        activeTab === 'executions'
                          ? 'border-primary text-primary'
                          : 'border-transparent text-on-surface-variant hover:text-primary'
                      }`}
                    >
                      Execution Audit (50 Trades)
                    </button>
                  </div>

                  {/* Tab 1: Open Positions */}
                  {activeTab === 'positions' && (
                    <div className="space-y-3">
                      {userDetail.openPositions.length === 0 ? (
                        <div className="text-center py-8 text-on-surface-variant text-sm italic">
                          No open positions currently held by this user.
                        </div>
                      ) : (
                        userDetail.openPositions.map((pos: any) => (
                          <div
                            key={pos.id}
                            className="bg-surface-container-low border border-border-subtle rounded-lg p-4 flex items-center justify-between"
                          >
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-primary">{pos.tokenSymbol}</span>
                                <ChainBadge chain={pos.chain} />
                              </div>
                              <div className="text-xs font-mono text-on-surface-variant mt-1">
                                Qty: {pos.confirmedQuantity} · Basis: ${pos.costBasisUsd}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="text-sm font-mono font-bold text-primary">
                                ${(pos.confirmedQuantity * pos.currentPriceUsd).toFixed(2)}
                              </div>
                              <button
                                onClick={async () => {
                                  if (confirm('Force exit this position immediately on-chain?')) {
                                    try {
                                      await api.post(`/v1/me/positions/${pos.id}/exit`, {});
                                      alert('Exit order submitted');
                                    } catch (err: any) {
                                      alert(`Exit failed: ${err.message}`);
                                    }
                                  }
                                }}
                                className="mt-1 px-2.5 py-1 bg-status-error/10 hover:bg-status-error text-status-error hover:text-white border border-status-error/30 rounded text-xs font-bold transition-colors"
                              >
                                Force Exit
                              </button>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {/* Tab 2: Subscribed Masters */}
                  {activeTab === 'masters' && (
                    <div className="space-y-3">
                      {userDetail.subscriptions.map((s: any) => (
                        <div
                          key={s.walletAddress}
                          className="bg-surface-container-low border border-border-subtle rounded-lg p-4 flex items-center justify-between"
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-primary">{s.label || s.walletAddress.slice(0, 14)}</span>
                              <ChainBadge chain={s.chain} />
                              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface-container">
                                Slot #{s.membershipSlot ?? 'N/A'}/50
                              </span>
                            </div>
                            <div className="text-xs font-mono text-on-surface-variant mt-1">
                              Status: {s.state} · Joined: {new Date(s.createdAt).toLocaleDateString()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Tab 3: Execution Audit */}
                  {activeTab === 'executions' && (
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {userDetail.executionLedger.map((ex: any) => (
                        <div
                          key={ex.id}
                          className="bg-surface-container-low border border-border-subtle rounded-lg p-3 text-xs flex items-center justify-between"
                        >
                          <div>
                            <div className="flex items-center gap-2 font-mono">
                              <span className={`font-bold ${ex.direction === 'buy' ? 'text-status-success' : 'text-status-error'}`}>
                                {ex.direction.toUpperCase()}
                              </span>
                              <span>{ex.tokenMint.slice(0, 8)}...</span>
                              <span className="text-on-surface-variant">[{ex.executionMode}]</span>
                            </div>
                            <div className="text-[11px] text-on-surface-variant font-mono mt-0.5">
                              {ex.confirmedAt ? new Date(ex.confirmedAt).toLocaleTimeString() : 'Pending'} · Fee: ${ex.feeUsd}
                            </div>
                          </div>
                          <div className="text-right font-mono">
                            <div className="font-semibold text-primary">${ex.fillPriceUsd}</div>
                            {ex.txHash && (
                              <span className="text-[10px] text-blue-600 underline">tx: {ex.txHash.slice(0, 8)}...</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 5. Data Export Modal */}
        {showExportModal && (
          <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-surface-container-lowest border border-border-subtle rounded-xl max-w-md w-full p-6 shadow-2xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-headline-md text-lg font-bold text-primary">Export Trading Data</h3>
                <button onClick={() => setShowExportModal(false)} className="text-on-surface-variant">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold block mb-1">
                    Export Type
                  </label>
                  <select
                    value={exportType}
                    onChange={(e: any) => setExportType(e.target.value)}
                    className="w-full bg-surface-container border border-border-subtle rounded-lg p-2.5 text-sm"
                  >
                    <option value="users">Fleet User Summary (Balances & P&L)</option>
                    <option value="positions">Open Positions Snapshot (All Tenants)</option>
                    <option value="executions">Trade Executions Ledger (Granular Transactions)</option>
                    <option value="masters">Master Attribution Matrix</option>
                  </select>
                </div>

                <div>
                  <label className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold block mb-1">
                    Output Format
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setExportFormat('csv')}
                      className={`p-3 rounded-lg border text-sm font-semibold transition-colors ${
                        exportFormat === 'csv'
                          ? 'border-primary bg-surface-container text-primary'
                          : 'border-border-subtle text-on-surface-variant'
                      }`}
                    >
                      CSV (Excel / Sheets)
                    </button>
                    <button
                      type="button"
                      onClick={() => setExportFormat('json')}
                      className={`p-3 rounded-lg border text-sm font-semibold transition-colors ${
                        exportFormat === 'json'
                          ? 'border-primary bg-surface-container text-primary'
                          : 'border-border-subtle text-on-surface-variant'
                      }`}
                    >
                      JSON (Quant / API)
                    </button>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    onClick={triggerExport}
                    className="w-full bg-primary text-white py-3 rounded-xl font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
                  >
                    <span className="material-symbols-outlined text-lg">download</span>
                    <span>Download Stream</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
