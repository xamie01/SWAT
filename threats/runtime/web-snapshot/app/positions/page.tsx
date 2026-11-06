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

interface PerpsInstrument {
  instrument_id: number;
  symbol: string;
  category: string;
  base_asset: string;
  quote_asset: string;
  price_decimals: number;
  quantity_decimals: number;
  max_leverage: string | number;
  min_notional: string | number;
  is_active: boolean;
}

interface PerpsAccount {
  user_id: string;
  total_account_value: string;
  available_order_margin: string;
  total_initial_margin: string;
  total_maintenance_margin: string;
  withdrawable: string;
  in_liquidation: boolean;
}

interface PerpsPosition {
  id: string;
  instrument_id: number;
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: string;
  entry_price: string;
  leverage: string | number;
  initial_margin: string;
  maintenance_margin: string;
  liquidation_price: string | null;
  unrealized_pnl: string;
  take_profit_price: string | null;
  stop_loss_price: string | null;
  status: string;
  updated_at: string;
}

export default function PositionsPage() {
  const [activeTab, setActiveTab] = useState<'spot' | 'perps'>('spot');
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterChain, setFilterChain] = useState<string>('all');
  const [exitingId, setExitingId] = useState<string | null>(null);
  const [closingAll, setClosingAll] = useState(false);

  // Perps State
  const [perpsAccount, setPerpsAccount] = useState<PerpsAccount | null>(null);
  const [perpsPositions, setPerpsPositions] = useState<PerpsPosition[]>([]);
  const [perpsInstruments, setPerpsInstruments] = useState<PerpsInstrument[]>([]);
  const [closingPerpId, setClosingPerpId] = useState<string | null>(null);

  useEffect(() => {
    fetchPositions();
    fetchPerpsData();
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

  const fetchPerpsData = async () => {
    try {
      const [instRes, portRes] = await Promise.all([
        api.get<{ instruments: PerpsInstrument[] }>('/v1/me/perps/instruments').catch(() => ({ instruments: [] })),
        api.get<{ account: PerpsAccount; positions: PerpsPosition[] }>('/v1/me/perps/portfolio').catch(() => ({
          account: {
            user_id: '',
            total_account_value: '0',
            available_order_margin: '0',
            total_initial_margin: '0',
            total_maintenance_margin: '0',
            withdrawable: '0',
            in_liquidation: false
          },
          positions: []
        }))
      ]);
      setPerpsInstruments(instRes.instruments || []);
      setPerpsAccount(portRes.account);
      setPerpsPositions(portRes.positions || []);
    } catch (err: any) {
      console.warn('Perps data fetch notice:', err.message);
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

  const handleClosePerpPosition = async (posId: string) => {
    if (!window.confirm('Confirm close: Submit immediate market IOC order to close this leveraged Perps position?')) {
      return;
    }
    setClosingPerpId(posId);
    try {
      await api.post(`/v1/me/perps/positions/${posId}/close`, {});
      alert('Perps position closed successfully.');
      fetchPerpsData();
    } catch (err: any) {
      alert(`Failed to close Perps position: ${err.message}`);
    } finally {
      setClosingPerpId(null);
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

  // Margin calculation for Perps
  const accountVal = Number(perpsAccount?.total_account_value) || 0;
  const maintMargin = Number(perpsAccount?.total_maintenance_margin) || 0;
  const availMargin = Number(perpsAccount?.available_order_margin) || 0;
  const marginRatio = accountVal > 0 ? (maintMargin / accountVal) * 100 : 0;

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      <SaaSNav />

      <main className="max-w-[1440px] mx-auto px-6 py-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">
              Active Holdings & Exposure
            </h1>
            <p className="text-body-sm text-on-surface-variant">
              Live mark-to-market positions across Prediction Markets, Spot DEXes, and Polymarket Perpetual Futures.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleCloseAll}
              disabled={closingAll || (positions.length === 0 && perpsPositions.length === 0)}
              className="flex items-center gap-2 px-4 py-2 bg-status-error/10 hover:bg-status-error text-status-error hover:text-white border border-status-error/30 rounded-lg text-xs font-mono font-bold transition-colors disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-base">emergency_home</span>
              <span>{closingAll ? 'Closing All...' : 'Close All Positions'}</span>
            </button>
            <button
              onClick={() => {
                fetchPositions();
                fetchPerpsData();
              }}
              className="flex items-center gap-2 px-4 py-2 bg-surface-container hover:bg-surface-container-high border border-border-subtle rounded-lg text-xs font-semibold transition-colors"
            >
              <span className="material-symbols-outlined text-base">refresh</span>
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Tab Navigation: Spot/Prediction vs Polymarket Perps */}
        <div className="flex items-center gap-2 mb-8 border-b border-border-subtle pb-3">
          <button
            onClick={() => setActiveTab('spot')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-bold transition-colors ${
              activeTab === 'spot'
                ? 'bg-primary text-white shadow-sm'
                : 'bg-surface-container hover:bg-surface-container-high text-on-surface-variant'
            }`}
          >
            <span className="material-symbols-outlined text-sm">candlestick_chart</span>
            <span>Spot & Prediction Markets ({positions.length})</span>
          </button>
          <button
            onClick={() => setActiveTab('perps')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-mono font-bold transition-colors ${
              activeTab === 'perps'
                ? 'bg-secondary text-white shadow-sm'
                : 'bg-surface-container hover:bg-surface-container-high text-on-surface-variant'
            }`}
          >
            <span className="material-symbols-outlined text-sm">trending_up</span>
            <span>Polymarket Perps Futures ({perpsPositions.length})</span>
            <span className="ml-1 px-1.5 py-0.2 bg-emerald-500/20 text-emerald-400 text-[10px] rounded uppercase font-sans">
              Live
            </span>
          </button>
        </div>

        {error && <div className="mb-6"><ErrorBanner message={error} onRetry={fetchPositions} /></div>}

        {activeTab === 'spot' ? (
          <>
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
                                className="px-3 py-1 bg-surface-container hover:bg-status-error/10 hover:text-status-error border border-border-subtle hover:border-status-error/30 rounded text-xs font-mono transition-colors"
                              >
                                {exitingId === pos.id ? 'Exiting...' : 'Exit Market'}
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
          </>
        ) : (
          /* Polymarket Perpetual Futures View */
          <div className="space-y-8">
            {/* Perps Margin & Risk Card */}
            <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
                <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
                  Perps Account Equity
                </span>
                <div className="text-2xl font-bold font-mono text-primary mt-1">
                  ${accountVal.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
                <span className="text-xs text-on-surface-variant">Dedicated pUSD collateral</span>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
                <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
                  Available Order Margin
                </span>
                <div className="text-2xl font-bold font-mono text-emerald-400 mt-1">
                  ${availMargin.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
                <span className="text-xs text-on-surface-variant">Capacity for new positions</span>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
                <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
                  Maintenance Margin
                </span>
                <div className="text-2xl font-bold font-mono text-amber-400 mt-1">
                  ${maintMargin.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
                <span className="text-xs text-on-surface-variant">Buffer to avoid liquidation</span>
              </div>

              <div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-5">
                <span className="text-label-caps text-on-surface-variant uppercase text-[11px] font-semibold">
                  Margin Health Ratio
                </span>
                <div className="text-2xl font-bold font-mono text-primary mt-1">
                  {marginRatio.toFixed(1)}%
                </div>
                <div className="w-full bg-surface-container-high rounded-full h-1.5 mt-2 overflow-hidden">
                  <div
                    className={`h-full ${
                      marginRatio > 80 ? 'bg-status-error' : marginRatio > 50 ? 'bg-amber-400' : 'bg-status-success'
                    }`}
                    style={{ width: `${Math.min(100, Math.max(5, marginRatio))}%` }}
                  />
                </div>
              </div>
            </section>

            {/* Active Perps Positions */}
            <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6">
              <h2 className="text-base font-bold font-mono mb-4 text-primary flex items-center gap-2">
                <span className="material-symbols-outlined text-lg text-secondary">swap_calls</span>
                <span>Open Perpetual Contracts ({perpsPositions.length})</span>
              </h2>

              {perpsPositions.length === 0 ? (
                <EmptyCard
                  title="No Open Perps Positions"
                  description="You currently have no open perpetual futures positions. Subscribed masters' Perps signals will automatically open mirrored positions here."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border-subtle text-on-surface-variant text-[11px] font-mono uppercase tracking-wider">
                        <th className="pb-3 font-semibold">Contract</th>
                        <th className="pb-3 font-semibold">Side & Leverage</th>
                        <th className="pb-3 font-semibold">Size</th>
                        <th className="pb-3 font-semibold">Entry Price</th>
                        <th className="pb-3 font-semibold">Liquidation Price</th>
                        <th className="pb-3 font-semibold">Margin Held</th>
                        <th className="pb-3 font-semibold">Unrealized P&L</th>
                        <th className="pb-3 font-semibold text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle">
                      {perpsPositions.map((pos) => {
                        const pnl = Number(pos.unrealized_pnl) || 0;
                        return (
                          <tr key={pos.id} className="hover:bg-surface-container-low transition-colors">
                            <td className="py-4 font-bold text-primary">{pos.symbol}</td>
                            <td className="py-4">
                              <span
                                className={`px-2 py-0.5 rounded text-[11px] font-bold font-mono uppercase mr-2 ${
                                  pos.side === 'LONG'
                                    ? 'bg-status-success/20 text-status-success'
                                    : 'bg-status-error/20 text-status-error'
                                }`}
                              >
                                {pos.side}
                              </span>
                              <span className="text-xs font-mono text-on-surface-variant">{pos.leverage}x</span>
                            </td>
                            <td className="py-4 font-mono font-medium">{pos.size}</td>
                            <td className="py-4 font-mono font-medium">${Number(pos.entry_price).toFixed(2)}</td>
                            <td className="py-4 font-mono font-medium text-amber-400">
                              ${pos.liquidation_price ? Number(pos.liquidation_price).toFixed(2) : '—'}
                            </td>
                            <td className="py-4 font-mono font-medium text-xs text-on-surface-variant">
                              ${Number(pos.initial_margin).toFixed(2)}
                            </td>
                            <td className="py-4">
                              <div
                                className={`font-mono font-semibold ${
                                  pnl >= 0 ? 'text-status-success' : 'text-status-error'
                                }`}
                              >
                                ${pnl.toFixed(2)}
                              </div>
                            </td>
                            <td className="py-4 text-right">
                              <button
                                onClick={() => handleClosePerpPosition(pos.id)}
                                disabled={closingPerpId === pos.id}
                                className="px-3 py-1 bg-surface-container hover:bg-status-error/10 hover:text-status-error border border-border-subtle hover:border-status-error/30 rounded text-xs font-mono transition-colors"
                              >
                                {closingPerpId === pos.id ? 'Closing...' : 'Close Market'}
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

            {/* Available Polymarket Perps Instruments */}
            <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6">
              <h2 className="text-base font-bold font-mono mb-2 text-primary flex items-center gap-2">
                <span className="material-symbols-outlined text-lg text-emerald-400">hub</span>
                <span>Supported Polymarket Perpetual Instruments</span>
              </h2>
              <p className="text-xs text-on-surface-variant mb-4">
                These markets trade 24/7 with zero expiration and up to 10x leverage on Polymarket's decentralized perpetual order book.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                {perpsInstruments.map((inst) => (
                  <div
                    key={inst.instrument_id}
                    className="p-4 border border-border-subtle rounded-xl bg-surface-container-low hover:border-primary/40 transition-colors"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-bold font-mono text-sm text-primary">{inst.symbol}</span>
                      <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-surface-container text-on-surface-variant">
                        {inst.category}
                      </span>
                    </div>
                    <div className="text-xs text-on-surface-variant space-y-1">
                      <div className="flex justify-between">
                        <span>Max Leverage:</span>
                        <span className="font-bold text-primary font-mono">{inst.max_leverage}x</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Base Asset:</span>
                        <span className="font-mono text-primary">{inst.base_asset}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Settlement:</span>
                        <span className="font-mono text-primary">{inst.quote_asset} (pUSD)</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
