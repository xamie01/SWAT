'use client';

import React, { useState, useEffect } from 'react';
import { SaaSNav } from '../../components/SaaSNav.js';
import { ChainBadge, LoadingSkeleton, ErrorBanner, EmptyCard } from '../../components/UIPrimitives.js';
import { api } from '../../lib/api.js';
import { describeApiError } from '../../lib/api-error-message.js';
import { FinancialRequestPanel } from '../../components/FinancialRequestPanel.js';
import { loadingObservation, observe, perpsRisk, spotTotals, submitReduction, usd, type Observation, type SpotPortfolio, type PerpsPortfolio } from '../../lib/portfolio-model.js';

export default function PositionsPage() {
  const [activeTab, setActiveTab] = useState<'spot' | 'perps'>('spot');
  const [spot, setSpot] = useState<Observation<SpotPortfolio>>(loadingObservation);
  const [perps, setPerps] = useState<Observation<PerpsPortfolio>>(loadingObservation);
  const [filterChain, setFilterChain] = useState('all');
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchPositions = async () => {
    setSpot(loadingObservation());
    setSpot(await observe(() => api.get<SpotPortfolio>('/v1/me/positions'), 'Spot positions unavailable'));
  };
  const fetchPerpsData = async () => {
    setPerps(loadingObservation());
    setPerps(await observe(() => api.get<PerpsPortfolio>('/v1/me/perps/portfolio'), 'Perps portfolio unavailable'));
  };
  useEffect(() => { void fetchPositions(); void fetchPerpsData(); }, []);

  // These entry points have no authorized reducing implementation. Guard the
  // handler as well as the button; a future response flag cannot enable it.
  const refuseReduction = async (path: string) => {
    try { await submitReduction(() => api.post(path, {})); }
    catch (error) { setActionError(describeApiError(error, 'Action unavailable')); }
  };
  const filtered = spot.data?.positions.filter(position => filterChain === 'all' || position.chain.toLowerCase().includes(filterChain)) ?? [];
  const totals = spotTotals(spot.state === 'observed' ? filtered : null);
  const risk = perpsRisk(perps.data?.account ?? null);
  const financialClass = (value: number | null) => value === null ? 'text-on-surface-variant' : value >= 0 ? 'text-status-success' : 'text-status-error';
  const cardClass = 'bg-surface-container-lowest border border-border-subtle rounded-xl p-5';
  const thClass = 'pb-3 font-semibold';
  const actionClass = 'px-3 py-1 bg-surface-container border border-border-subtle rounded text-xs font-mono opacity-40';

  return (
    <div className="bg-background text-on-background min-h-screen antialiased font-sans">
      <SaaSNav />
      <main className="max-w-[1440px] mx-auto px-6 py-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="font-headline-lg text-2xl font-bold tracking-tight text-primary">Active Holdings &amp; Exposure</h1>
            <p className="text-body-sm text-on-surface-variant">Recorded position observations. Exact reducing admission may be configured; runtime/live execution remains unaccepted.</p>
          </div>
          <div className="flex items-center gap-3">
            <button disabled onClick={() => void refuseReduction('/v1/me/positions/close-all')} title="No authorized reducing handoff or receipt reconciliation" className={actionClass}>Close all unavailable</button>
            <button onClick={() => { void fetchPositions(); void fetchPerpsData(); }} className="flex items-center gap-2 px-4 py-2 bg-surface-container hover:bg-surface-container-high border border-border-subtle rounded-lg text-xs font-semibold">
              <span className="material-symbols-outlined text-base">refresh</span>Refresh
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2 mb-8 border-b border-border-subtle pb-3">
          {(['spot', 'perps'] as const).map(tab => <button key={tab} onClick={() => setActiveTab(tab)} className={`px-4 py-2 rounded-lg text-xs font-mono font-bold ${activeTab === tab ? 'bg-primary text-white' : 'bg-surface-container text-on-surface-variant'}`}>
            {tab === 'spot' ? `Spot & Prediction Markets (${spot.data?.positions.length ?? 'Unknown'})` : `Perps observations (${perps.data?.positions.length ?? 'Unknown'})`}
          </button>)}
        </div>
        {actionError && <div className="mb-6"><ErrorBanner message={actionError} /></div>}
        {activeTab === 'spot' ? <>
          {spot.error && <div className="mb-6"><ErrorBanner message={spot.error} onRetry={fetchPositions} /></div>}
          <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {[['Total Positions Value', totals.value], ['Net Cost Basis', totals.cost], ['Observed Unrealized P&L', totals.pnl]].map(([label, value]) => <div key={String(label)} className={cardClass}>
              <span className="text-on-surface-variant uppercase text-[11px] font-semibold">{label}</span>
              <div className="text-2xl font-bold font-mono text-primary mt-1">{spot.state === 'loading' ? 'Loading…' : spot.state === 'unavailable' ? 'Unavailable' : usd(value)}</div>
              <span className="text-xs text-on-surface-variant">{spot.state === 'observed' ? 'Recorded observations, not verified live valuation' : 'No current observation'}</span>
            </div>)}
          </section>
          <div className="flex items-center gap-2 mb-6">
            <span className="text-xs font-semibold text-on-surface-variant uppercase">Filter Venue:</span>
            {['all', 'solana', 'robinhood', 'polymarket'].map(chain => <button key={chain} onClick={() => setFilterChain(chain)} className={`px-3 py-1 rounded-lg text-xs font-mono ${filterChain === chain ? 'bg-primary text-white' : 'bg-surface-container text-on-surface-variant'}`}>{chain.toUpperCase()}</button>)}
          </div>
          <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6">
            {spot.state === 'loading' ? <LoadingSkeleton rows={4} /> : spot.state === 'unavailable' ? <EmptyCard title="Positions unavailable" description="Holdings could not be assessed. An API failure is not an empty portfolio." /> : filtered.length === 0 ? <EmptyCard title="No recorded positions" description="The successful API observation returned no open positions matching this filter." /> : <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr className="border-b border-border-subtle text-on-surface-variant text-[11px] font-mono uppercase tracking-wider">{['Token', 'Venue', 'Master Attribution', 'Holding Qty', 'Cost Basis', 'Mark Price', 'Unrealized P&L', 'Action'].map(label => <th key={label} className={thClass}>{label}</th>)}</tr></thead>
                <tbody className="divide-y divide-border-subtle">{filtered.map(position => <tr key={position.id} className="hover:bg-surface-container-low">
                  <td className="py-4"><div className="font-bold text-primary">{position.tokenSymbol || position.tokenMint.slice(0, 8)}</div><div className="text-[11px] font-mono text-on-surface-variant truncate max-w-[140px]">{position.tokenMint}</div></td>
                  <td className="py-4"><ChainBadge chain={position.chain} /></td>
                  <td className="py-4 font-mono text-xs">{position.masterWalletAddress ? `${position.masterWalletAddress.slice(0, 12)}…` : 'Unassessed'}</td>
                  <td className="py-4 font-mono">{position.confirmedQuantityExact ?? position.confirmedQuantity ?? 'Unassessed'}</td>
                  <td className="py-4 font-mono">{usd(position.costBasisUsd)}</td>
                  <td className="py-4 font-mono text-primary">{usd(position.currentPriceUsd, 4)}</td>
                  <td className={`py-4 font-mono ${financialClass(position.unrealizedPnlUsd)}`}>{usd(position.unrealizedPnlUsd)}{position.unrealizedPnlPct !== null ? ` (${position.unrealizedPnlPct.toFixed(2)}%)` : ''}</td>
                  <td className="py-4"><FinancialRequestPanel kind="reducing" positionId={position.id} capability={spot.data?.reducingExecution} /></td>
                </tr>)}</tbody>
              </table>
            </div>}
          </section>
        </> : <div className="space-y-8">
          {perps.error && <ErrorBanner message={perps.error} onRetry={fetchPerpsData} />}
          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[['Perps Account Equity', usd(risk.equity)], ['Available Order Margin', usd(risk.available)], ['Maintenance Margin', usd(risk.maintenance)], ['Margin Ratio', risk.ratio === null ? 'Unassessed' : `${risk.ratio.toFixed(1)}%`]].map(([label, value]) => <div key={label} className={cardClass}>
              <span className="text-on-surface-variant uppercase text-[11px] font-semibold">{label}</span>
              <div className="text-2xl font-bold font-mono text-primary mt-1">{perps.state === 'loading' ? 'Loading…' : perps.state === 'unavailable' ? 'Unavailable' : value}</div>
            </div>)}
          </section>
          <p role="status" className="text-xs text-on-surface-variant">Account assessment: {perps.data?.accountAssessment ?? 'Unavailable'}. Liquidation status: {risk.liquidation === null ? 'Unassessed' : risk.liquidation ? 'Reported in liquidation' : 'Reported not in liquidation (runtime unverified)'}. Reducing admission is not confirmed financial closure.</p>
          <section className="bg-surface-container-lowest border border-border-subtle rounded-xl p-6">
            <h2 className="text-base font-bold font-mono mb-4 text-primary">Recorded Open Perpetual Contracts</h2>
            {perps.state === 'loading' ? <LoadingSkeleton rows={4} /> : perps.state === 'unavailable' ? <EmptyCard title="Perps portfolio unavailable" description="Exposure and margin could not be assessed." /> : perps.data.positions.length === 0 ? <EmptyCard title="No recorded open perps positions" description="The successful API observation returned no open contracts. This does not imply safe margin or available execution." /> : <div className="overflow-x-auto">
              <table className="w-full text-left text-sm"><thead><tr className="border-b border-border-subtle text-on-surface-variant text-[11px] font-mono uppercase tracking-wider">{['Contract', 'Side & Leverage', 'Size', 'Entry Price', 'Liquidation Price', 'Margin Held', 'Unrealized P&L', 'Action'].map(label => <th key={label} className={thClass}>{label}</th>)}</tr></thead>
                <tbody className="divide-y divide-border-subtle">{perps.data.positions.map(position => <tr key={position.id} className="hover:bg-surface-container-low">
                  <td className="py-4 font-bold text-primary">{position.symbol}</td><td className="py-4 font-mono">{position.side} {position.leverage}x</td><td className="py-4 font-mono">{position.size}</td>
                  <td className="py-4 font-mono">{usd(position.entry_price)}</td><td className="py-4 font-mono">{usd(position.liquidation_price)}</td><td className="py-4 font-mono">{usd(position.initial_margin)}</td><td className="py-4 font-mono">{usd(position.unrealized_pnl)}</td>
                  <td className="py-4"><FinancialRequestPanel kind="reducing" venue="polymarket-perps" positionId={position.id} capability={perps.data?.reducingExecution} /></td>
                </tr>)}</tbody>
              </table>
            </div>}
          </section>
        </div>}
      </main>
    </div>
  );
}
