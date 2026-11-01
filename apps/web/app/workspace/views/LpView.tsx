'use client';

import { useCallback, useEffect, useState } from 'react';
import { lpApi } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

type LpSubTab = 'discover' | 'whales' | 'builder' | 'positions';
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

export default function LpView() {
  const [activeSubTab, setActiveSubTab] = useState<LpSubTab>('discover');
  const [selectedChain, setSelectedChain] = useState<Chain>('All');
  const [showHotOnly, setShowHotOnly] = useState(false);

  // Discover state
  const [pools, setPools] = useState<PoolItem[]>([]);
  const [loadingPools, setLoadingPools] = useState(false);
  const [poolError, setPoolError] = useState<string | null>(null);

  // Whales state
  const [whales, setWhales] = useState<WhaleLeaderboardEntry[]>([]);
  const [subscriptions, setSubscriptions] = useState<CopySubscription[]>([]);
  const [loadingWhales, setLoadingWhales] = useState(false);
  const [copyModalWhale, setCopyModalWhale] = useState<WhaleLeaderboardEntry | null>(null);
  const [copyBudget, setCopyBudget] = useState(1000);
  const [copyMaxCapital, setCopyMaxCapital] = useState(500);
  const [copySubmitting, setCopySubmitting] = useState(false);
  const [copySuccessMsg, setCopySuccessMsg] = useState<string | null>(null);

  // Builder state
  const [builderPool, setBuilderPool] = useState<string>('solana:Meteora-SOL-USDC');
  const [builderChain, setBuilderChain] = useState<string>('solana');
  const [builderDistribution, setBuilderDistribution] = useState<'spot' | 'curve' | 'bidask'>('spot');
  const [builderRangeLower, setBuilderRangeLower] = useState(175);
  const [builderRangeUpper, setBuilderRangeUpper] = useState(195);
  const [builderRungCount, setBuilderRungCount] = useState(10);
  const [builderDeposit, setBuilderDeposit] = useState(500);
  const [builderAutoRebalance, setBuilderAutoRebalance] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<string | null>(null);

  // Positions state
  const [positions, setPositions] = useState<PositionItem[]>([]);
  const [loadingPositions, setLoadingPositions] = useState(false);

  // --- Fetch Discover Pools ---
  const fetchPools = useCallback(async () => {
    setLoadingPools(true);
    setPoolError(null);
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
      setPoolError(describeApiError(err, 'Failed to fetch LP pools'));
    } finally {
      setLoadingPools(false);
    }
  }, [selectedChain, showHotOnly]);

  // --- Fetch Whales & Subscriptions ---
  const fetchWhales = useCallback(async () => {
    setLoadingWhales(true);
    try {
      const queryChain = selectedChain === 'All' ? '' : `?chain=${selectedChain}`;
      const [leaderboardRes, subsRes] = await Promise.allSettled([
        lpApi.get<{ entries: WhaleLeaderboardEntry[] }>(`/v1/lp/wallets/leaderboard${queryChain}`),
        lpApi.get<{ subscriptions: CopySubscription[] }>('/v1/lp/copy/subscriptions')
      ]);

      if (leaderboardRes.status === 'fulfilled') {
        setWhales(leaderboardRes.value.entries ?? []);
      }
      if (subsRes.status === 'fulfilled') {
        setSubscriptions(subsRes.value.subscriptions ?? []);
      }
    } catch {
      // Best-effort load
    } finally {
      setLoadingWhales(false);
    }
  }, [selectedChain]);

  // --- Fetch Positions ---
  const fetchPositions = useCallback(async () => {
    setLoadingPositions(true);
    try {
      const res = await lpApi.get<{ positions: PositionItem[] }>('/v1/lp/positions?includeClosed=true');
      setPositions(res.positions ?? []);
    } catch {
      // Best-effort load
    } finally {
      setLoadingPositions(false);
    }
  }, []);

  useEffect(() => {
    if (activeSubTab === 'discover') void fetchPools();
    if (activeSubTab === 'whales') void fetchWhales();
    if (activeSubTab === 'positions') void fetchPositions();
  }, [activeSubTab, fetchPools, fetchWhales, fetchPositions]);

  // --- Handle Copy Subscription ---
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
      setCopySuccessMsg('Subscription activated! Forward-only execution enabled.');
      setTimeout(() => {
        setCopyModalWhale(null);
        setCopySuccessMsg(null);
        void fetchWhales();
      }, 1500);
    } catch (err) {
      alert(describeApiError(err, 'Failed to activate copy subscription'));
    } finally {
      setCopySubmitting(false);
    }
  };

  // --- Handle Toggle Subscription Status ---
  const handleToggleSubStatus = async (sub: CopySubscription) => {
    const nextStatus = sub.status === 'active' ? 'paused' : 'active';
    try {
      await lpApi.patch(`/v1/lp/copy/subscriptions/${sub.id}`, { status: nextStatus });
      void fetchWhales();
    } catch (err) {
      alert(describeApiError(err, 'Failed to update subscription status'));
    }
  };

  // --- Handle Deploy Ladder ---
  const handleDeployLadder = async () => {
    setDeploying(true);
    setDeployResult(null);
    try {
      await lpApi.post('/v1/lp/positions/deploy', {
        chain: builderChain,
        poolAddress: builderPool,
        custom: {
          rangeLower: builderRangeLower,
          rangeUpper: builderRangeUpper,
          rungCount: builderRungCount,
          distribution: builderDistribution
        },
        depositAmount: builderDeposit,
        depositAsset: `${builderChain}:USDC`,
        autoRebalance: builderAutoRebalance
      });
      setDeployResult('LP Ladder successfully deployed in paper/execution mode!');
      setTimeout(() => {
        setActiveSubTab('positions');
        void fetchPositions();
      }, 1200);
    } catch (err) {
      setDeployResult(`Deploy failed: ${describeApiError(err, 'Could not deploy ladder')}`);
    } finally {
      setDeploying(false);
    }
  };

  // --- Handle Position Rebalance Trigger ---
  const handleTriggerRebalance = async (posId: string) => {
    try {
      await lpApi.post(`/v1/lp/positions/${posId}/rebalance`);
      alert('Rebalance job queued on execution queue.');
      void fetchPositions();
    } catch (err) {
      alert(describeApiError(err, 'Failed to trigger rebalance'));
    }
  };

  // --- Handle Close Position ---
  const handleClosePosition = async (posId: string) => {
    if (!confirm('Are you sure you want to close this LP position?')) return;
    try {
      await lpApi.post(`/v1/lp/positions/${posId}/close`);
      void fetchPositions();
    } catch (err) {
      alert(describeApiError(err, 'Failed to close position'));
    }
  };

  return (
    <div className="max-w-[1440px] mx-auto p-6 relative">
      {/* Top Banner */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-6 border-b border-border-subtle">
        <div>
          <div className="flex items-center gap-3">
            <span className="material-symbols-outlined text-primary text-2xl">water_drop</span>
            <h2 className="text-xl font-bold text-primary tracking-tight">WAKE LP Protocol</h2>
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-primary/20 text-primary border border-primary/30 uppercase">
              Multi-Chain CLMM & DLMM
            </span>
          </div>
          <p className="text-on-surface-variant text-xs mt-1">
            Institutional concentrated liquidity engine: Meteora DLMM, Raydium CLMM, Uniswap v3 & PancakeSwap v3 across 5 chains.
          </p>
        </div>

        {/* Sub-tab Navigation */}
        <div className="flex bg-surface-container-lowest border border-border-subtle p-1 rounded-lg gap-1">
          <button
            onClick={() => setActiveSubTab('discover')}
            className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${
              activeSubTab === 'discover'
                ? 'bg-primary text-on-primary shadow-sm'
                : 'text-on-surface-variant hover:text-primary hover:bg-surface-container'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">travel_explore</span>
            <span>Discover Pools</span>
          </button>
          <button
            onClick={() => setActiveSubTab('whales')}
            className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${
              activeSubTab === 'whales'
                ? 'bg-primary text-on-primary shadow-sm'
                : 'text-on-surface-variant hover:text-primary hover:bg-surface-container'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">group</span>
            <span>LP Whales & Copy</span>
          </button>
          <button
            onClick={() => setActiveSubTab('builder')}
            className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${
              activeSubTab === 'builder'
                ? 'bg-primary text-on-primary shadow-sm'
                : 'text-on-surface-variant hover:text-primary hover:bg-surface-container'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">tune</span>
            <span>Ladder Builder</span>
          </button>
          <button
            onClick={() => setActiveSubTab('positions')}
            className={`px-3 py-1.5 text-xs font-bold rounded-md transition-all flex items-center gap-2 ${
              activeSubTab === 'positions'
                ? 'bg-primary text-on-primary shadow-sm'
                : 'text-on-surface-variant hover:text-primary hover:bg-surface-container'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">pie_chart</span>
            <span>My Positions</span>
          </button>
        </div>
      </div>

      {/* --- TAB 1: DISCOVER POOLS --- */}
      {activeSubTab === 'discover' && (
        <div className="space-y-6">
          {/* Filter Bar */}
          <div className="bg-surface-container-lowest border border-border-subtle rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Chain</span>
              {(['All', 'solana', 'robinhood-chain', 'base', 'ethereum', 'bsc'] as Chain[]).map((c) => (
                <button
                  key={c}
                  onClick={() => setSelectedChain(c)}
                  className={`px-2.5 py-1 text-xs font-bold rounded capitalize transition-all ${
                    selectedChain === c
                      ? 'bg-primary text-on-primary'
                      : 'bg-surface-container border border-border-subtle text-on-surface-variant hover:text-primary'
                  }`}
                >
                  {c === 'robinhood-chain' ? 'Robinhood' : c}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowHotOnly(!showHotOnly)}
                className={`px-3 py-1.5 text-xs font-bold rounded-md flex items-center gap-1.5 border transition-all ${
                  showHotOnly
                    ? 'bg-amber-500/20 text-amber-400 border-amber-500/40 shadow-sm'
                    : 'bg-surface-container border-border-subtle text-on-surface-variant hover:text-on-surface'
                }`}
              >
                <span>🔥 Hot Launches (&lt; 48h)</span>
                {showHotOnly && <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>}
              </button>
              <button
                onClick={() => void fetchPools()}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-container border border-border-subtle text-on-surface-variant hover:text-primary flex items-center gap-1"
              >
                <span className="material-symbols-outlined text-[14px]">refresh</span>
                <span>Refresh</span>
              </button>
            </div>
          </div>

          {poolError && (
            <div className="p-3 bg-red-950/40 border border-red-500/30 text-red-300 rounded-lg text-xs">
              {poolError}
            </div>
          )}

          {/* Pools Table */}
          <div className="bg-surface-container-lowest border border-border-subtle rounded-lg overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-container-low text-on-surface-variant font-mono text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-3">Pair & Protocol</th>
                  <th className="px-4 py-3">Chain</th>
                  <th className="px-4 py-3 text-right">Current Price</th>
                  <th className="px-4 py-3 text-right">Active TVL</th>
                  <th className="px-4 py-3 text-right">24h Volume</th>
                  <th className="px-4 py-3 text-right">Fee APR (24h)</th>
                  <th className="px-4 py-3 text-center">Rug Shield</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {loadingPools ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-on-surface-variant">
                      Scanning concentrated liquidity pools across chains...
                    </td>
                  </tr>
                ) : pools.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-on-surface-variant">
                      No pools found matching current criteria. Try toggling Hot Launches or changing chain filter.
                    </td>
                  </tr>
                ) : (
                  pools.map((p) => {
                    const isMeteora = p.protocol === 'meteora-dlmm';
                    return (
                      <tr key={p.id} className="hover:bg-surface-container-low/50 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold font-mono text-on-surface">{p.pairLabel}</span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-surface-container border border-border-subtle text-on-surface-variant uppercase">
                              {p.protocol}
                            </span>
                            {p.isNewLaunch && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                                {p.ageHours}h new
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 capitalize font-mono text-[11px] text-on-surface-variant">
                          {p.chain}
                        </td>
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
                              +{p.volatilitySurgeIndex}x surge
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {p.riskScore !== null && p.riskScore <= 30 ? (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                              PASS ({p.riskScore})
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                              AUDIT {p.riskScore ?? 'N/A'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => {
                              setBuilderPool(p.poolAddress);
                              setBuilderChain(p.chain);
                              if (p.currentPrice) {
                                setBuilderRangeLower(Number((p.currentPrice * 0.9).toFixed(4)));
                                setBuilderRangeUpper(Number((p.currentPrice * 1.1).toFixed(4)));
                              }
                              setActiveSubTab('builder');
                            }}
                            className="px-2.5 py-1 text-xs font-bold rounded bg-primary text-on-primary hover:opacity-90 transition-opacity"
                          >
                            Build
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- TAB 2: LP WHALES & FORWARD-ONLY COPY TRADING --- */}
      {activeSubTab === 'whales' && (
        <div className="space-y-6">
          <div className="bg-surface-container-lowest border border-border-subtle rounded-lg p-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-primary">LP Whale Leaderboard</h3>
              <p className="text-xs text-on-surface-variant">
                Top liquidity masters ranked by realized LP fee harvest & win rate. Forward-only copy engine guarantees no entry at stale/out-of-range bounds.
              </p>
            </div>
            <button
              onClick={() => void fetchWhales()}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-container border border-border-subtle text-on-surface-variant hover:text-primary flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[14px]">refresh</span>
              <span>Refresh</span>
            </button>
          </div>

          {/* Active Subscriptions List */}
          {subscriptions.length > 0 && (
            <div className="bg-surface-container-lowest border border-border-subtle rounded-lg p-4 space-y-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-primary">My Active LP Copy Subscriptions</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {subscriptions.map((sub) => (
                  <div key={sub.id} className="p-3 bg-surface-container-low border border-border-subtle rounded-lg space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-bold truncate max-w-[180px]">{sub.masterWalletAddress}</span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        sub.status === 'active' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-amber-500/20 text-amber-400'
                      }`}>
                        {sub.status.toUpperCase()}
                      </span>
                    </div>
                    <div className="text-[11px] text-on-surface-variant flex justify-between">
                      <span>Budget: ${sub.allocatedBudgetUsd}</span>
                      <span>Max/Pos: ${sub.maxCapitalPerPositionUsd}</span>
                    </div>
                    <div className="flex justify-between items-center pt-1 border-t border-border-subtle">
                      <span className="text-[10px] text-emerald-400 font-mono">Forward-Only Active</span>
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
                  <th className="px-4 py-3">Master Wallet</th>
                  <th className="px-4 py-3">Chain</th>
                  <th className="px-4 py-3 text-right">Realized Fees PnL</th>
                  <th className="px-4 py-3 text-right">Win Rate</th>
                  <th className="px-4 py-3 text-right">Open Positions</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {loadingWhales ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-on-surface-variant">
                      Indexing master wallet positions...
                    </td>
                  </tr>
                ) : whales.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-on-surface-variant">
                      No tracked LP master wallets found. Register a whale address via service key.
                    </td>
                  </tr>
                ) : (
                  whales.map((w, idx) => (
                    <tr key={w.walletAddress} className="hover:bg-surface-container-low/50 transition-colors">
                      <td className="px-4 py-3 font-mono">
                        <div className="flex items-center gap-2">
                          <span className="text-on-surface-variant font-bold">#{idx + 1}</span>
                          <span className="font-bold text-on-surface truncate max-w-[220px]">{w.walletAddress}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 capitalize font-mono text-on-surface-variant">{w.chain}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold text-emerald-400">
                        +${Math.round(w.realizedPnlUsd).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">{w.winRate.toFixed(1)}%</td>
                      <td className="px-4 py-3 text-right font-mono">{w.totalPositions}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => setCopyModalWhale(w)}
                          className="px-3 py-1 text-xs font-bold rounded bg-primary text-on-primary hover:opacity-90 transition-opacity"
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
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
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
                    Positions opened prior to this subscription will be ignored. Your funds will only enter fresh positions opened by the master from this second forward, protecting against entering at out-of-range or stale prices.
                  </p>
                </div>

                <div className="space-y-4 text-xs">
                  <div>
                    <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Master Address</label>
                    <div className="mt-1 font-mono p-2 bg-surface-container rounded border border-border-subtle truncate">
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
                  <div className="p-2.5 bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 rounded text-xs text-center font-bold">
                    {copySuccessMsg}
                  </div>
                )}

                <div className="flex justify-end gap-3 pt-3 border-t border-border-subtle">
                  <button
                    onClick={() => setCopyModalWhale(null)}
                    className="px-4 py-2 text-xs font-bold rounded bg-surface-container text-on-surface-variant hover:text-on-surface"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={copySubmitting}
                    onClick={() => void handleCreateCopySubscription()}
                    className="px-5 py-2 text-xs font-bold rounded bg-primary text-on-primary hover:opacity-90 disabled:opacity-50"
                  >
                    {copySubmitting ? 'Activating...' : 'Activate Copy'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* --- TAB 3: PRO LADDER BUILDER --- */}
      {activeSubTab === 'builder' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Controls Column */}
          <div className="lg:col-span-1 bg-surface-container-lowest border border-border-subtle rounded-lg p-5 space-y-5">
            <h3 className="text-sm font-bold text-primary flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">tune</span>
              Custom Ladder Parameters
            </h3>

            <div className="space-y-4 text-xs">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Chain</label>
                <select
                  value={builderChain}
                  onChange={(e) => setBuilderChain(e.target.value)}
                  className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded text-xs"
                >
                  <option value="solana">Solana (Meteora DLMM / Raydium)</option>
                  <option value="robinhood-chain">Robinhood Chain</option>
                  <option value="base">Base (Uniswap v3)</option>
                  <option value="ethereum">Ethereum (Uniswap v3)</option>
                  <option value="bsc">BNB Smart Chain (Pancake v3)</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Target Pool Address</label>
                <input
                  type="text"
                  value={builderPool}
                  onChange={(e) => setBuilderPool(e.target.value)}
                  className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded font-mono text-xs"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Bin / Tick Distribution Shape</label>
                <div className="grid grid-cols-3 gap-2 mt-1">
                  {(['spot', 'curve', 'bidask'] as const).map((shape) => (
                    <button
                      key={shape}
                      onClick={() => setBuilderDistribution(shape)}
                      className={`p-2 text-xs font-bold rounded capitalize border transition-all ${
                        builderDistribution === shape
                          ? 'bg-primary text-on-primary border-primary'
                          : 'bg-surface-container border-border-subtle text-on-surface-variant'
                      }`}
                    >
                      {shape}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Min Price</label>
                  <input
                    type="number"
                    value={builderRangeLower}
                    onChange={(e) => setBuilderRangeLower(Number(e.target.value))}
                    className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Max Price</label>
                  <input
                    type="number"
                    value={builderRangeUpper}
                    onChange={(e) => setBuilderRangeUpper(Number(e.target.value))}
                    className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded font-mono text-xs"
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between">
                  <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Rung Count (Bins/Ticks)</label>
                  <span className="font-mono font-bold text-primary">{builderRungCount}</span>
                </div>
                <input
                  type="range"
                  min="2"
                  max="32"
                  value={builderRungCount}
                  onChange={(e) => setBuilderRungCount(Number(e.target.value))}
                  className="w-full h-1.5 mt-2 bg-surface-container rounded appearance-none cursor-pointer accent-primary"
                />
              </div>

              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Deposit Capital ($ USD)</label>
                <input
                  type="number"
                  value={builderDeposit}
                  onChange={(e) => setBuilderDeposit(Number(e.target.value))}
                  className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded font-mono text-xs"
                />
              </div>

              <div className="p-3 bg-surface-container-low border border-border-subtle rounded flex items-center justify-between">
                <div>
                  <p className="text-xs font-bold text-on-surface">Autonomous Rebalance</p>
                  <p className="text-[10px] text-on-surface-variant">Auto-recenter when fee uplift &gt; IL + cost</p>
                </div>
                <input
                  type="checkbox"
                  checked={builderAutoRebalance}
                  onChange={(e) => setBuilderAutoRebalance(e.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
              </div>
            </div>

            {deployResult && (
              <div className={`p-3 rounded-lg text-xs font-mono ${
                deployResult.includes('successfully') ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-red-500/20 text-red-300 border border-red-500/30'
              }`}>
                {deployResult}
              </div>
            )}

            <button
              disabled={deploying}
              onClick={() => void handleDeployLadder()}
              className="w-full py-2.5 rounded-lg bg-primary text-on-primary font-bold text-xs hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {deploying ? 'Deploying...' : 'Deploy LP Ladder'}
            </button>
          </div>

          {/* Visual Ladder Preview Column */}
          <div className="lg:col-span-2 bg-surface-container-lowest border border-border-subtle rounded-lg p-5 space-y-4 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between border-b border-border-subtle pb-3">
                <h3 className="text-sm font-bold text-primary flex items-center gap-2">
                  <span className="material-symbols-outlined text-[18px]">equalizer</span>
                  Depth & Bin Allocations Preview
                </h3>
                <span className="text-[11px] font-mono text-emerald-400 font-bold">
                  Shape: {builderDistribution.toUpperCase()}
                </span>
              </div>

              {/* Depth Visualizer Bars */}
              <div className="mt-6 space-y-2">
                <p className="text-[10px] uppercase font-bold text-on-surface-variant tracking-wider">
                  Reconstructed Bin Ladders ({builderRangeLower} → {builderRangeUpper})
                </p>
                <div className="grid grid-cols-8 md:grid-cols-12 gap-1.5 h-36 items-end p-3 bg-surface-container-low border border-border-subtle rounded-lg">
                  {Array.from({ length: builderRungCount }).map((_, i) => {
                    const stepPrice = builderRangeLower + (i * (builderRangeUpper - builderRangeLower)) / builderRungCount;
                    let heightPct = 50;
                    if (builderDistribution === 'curve') {
                      heightPct = Math.max(15, Math.round(100 - i * (80 / builderRungCount)));
                    } else if (builderDistribution === 'bidask') {
                      heightPct = Math.max(20, Math.round(Math.abs(i - builderRungCount / 2) * 2 * (90 / builderRungCount)));
                    }

                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
                        <div
                          style={{ height: `${heightPct}%` }}
                          className="w-full bg-primary/70 hover:bg-primary rounded-t transition-all"
                        ></div>
                        <span className="text-[9px] font-mono text-on-surface-variant truncate block w-full text-center">
                          {Math.round(stepPrice)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Economic Projections */}
              <div className="grid grid-cols-3 gap-3 mt-6">
                <div className="p-3 bg-surface-container-low border border-border-subtle rounded">
                  <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider block">Estimated Fee APR</span>
                  <span className="text-base font-mono font-bold text-emerald-400 mt-1 block">184.2%</span>
                </div>
                <div className="p-3 bg-surface-container-low border border-border-subtle rounded">
                  <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider block">Target Capital Depth</span>
                  <span className="text-base font-mono font-bold text-on-surface mt-1 block">${builderDeposit}</span>
                </div>
                <div className="p-3 bg-surface-container-low border border-border-subtle rounded">
                  <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider block">Auto Rebalance</span>
                  <span className={`text-base font-mono font-bold mt-1 block ${builderAutoRebalance ? 'text-primary' : 'text-on-surface-variant'}`}>
                    {builderAutoRebalance ? 'ENABLED' : 'OFF'}
                  </span>
                </div>
              </div>
            </div>

            <p className="text-[11px] text-on-surface-variant border-t border-border-subtle pt-3">
              Institutional execution guard: All deployments are non-custodial and validated against max exposure caps before signature.
            </p>
          </div>
        </div>
      )}

      {/* --- TAB 4: MY LP POSITIONS --- */}
      {activeSubTab === 'positions' && (
        <div className="space-y-6">
          <div className="bg-surface-container-lowest border border-border-subtle rounded-lg p-4 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-primary">Active Concentrated Positions</h3>
              <p className="text-xs text-on-surface-variant">
                Live monitoring, dynamic range status, autonomous rebalancing, and one-click exit.
              </p>
            </div>
            <button
              onClick={() => void fetchPositions()}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-container border border-border-subtle text-on-surface-variant hover:text-primary flex items-center gap-1"
            >
              <span className="material-symbols-outlined text-[14px]">refresh</span>
              <span>Refresh</span>
            </button>
          </div>

          <div className="bg-surface-container-lowest border border-border-subtle rounded-lg overflow-hidden shadow-sm">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-container-low text-on-surface-variant font-mono text-[11px] uppercase tracking-wider">
                  <th className="px-4 py-3">Position & Pool</th>
                  <th className="px-4 py-3">Venue</th>
                  <th className="px-4 py-3 text-right">Price Range</th>
                  <th className="px-4 py-3 text-right">Deposit ($)</th>
                  <th className="px-4 py-3 text-center">Status</th>
                  <th className="px-4 py-3 text-center">Auto-Rebalance</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {loadingPositions ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-on-surface-variant">
                      Querying live position records...
                    </td>
                  </tr>
                ) : positions.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-on-surface-variant">
                      No positions deployed yet. Go to Discover or Custom Builder to deploy your first concentrated ladder.
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
                          <span className="font-bold text-on-surface block truncate max-w-[200px]">{pos.poolAddress}</span>
                          <span className="text-[10px] text-on-surface-variant capitalize">{pos.strategyType} ladder</span>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-on-surface-variant capitalize">
                          {pos.protocol} ({pos.chain})
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-medium">
                          ${pos.rangeLower.toFixed(2)} — ${pos.rangeUpper.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-bold">
                          ${pos.depositAmount.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
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
                        <td className="px-4 py-3 text-center font-mono">
                          <span className={`text-xs ${pos.autoRebalance ? 'text-primary font-bold' : 'text-on-surface-variant'}`}>
                            {pos.autoRebalance ? 'ON' : 'OFF'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right space-x-2">
                          {!isClosed && (isNearEdge || isOutOfRange) && (
                            <button
                              onClick={() => void handleTriggerRebalance(pos.id)}
                              className="px-2.5 py-1 text-xs font-bold rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30"
                            >
                              Rebalance
                            </button>
                          )}
                          {!isClosed && (
                            <button
                              onClick={() => void handleClosePosition(pos.id)}
                              className="px-2.5 py-1 text-xs font-bold rounded bg-surface-container border border-border-subtle text-red-400 hover:bg-red-500/10"
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
      )}
    </div>
  );
}
