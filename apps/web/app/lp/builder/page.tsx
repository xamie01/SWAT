'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { FinancialRequestPanel } from '../../../components/FinancialRequestPanel.js';
import { observedBuilderBounds } from '../../../lib/lp-observation.js';

function BuilderContent() {
  const searchParams = useSearchParams();

  const [chain, setChain] = useState<'solana' | 'robinhood-chain' | 'base' | 'ethereum' | 'bsc'>('solana');
  const [poolAddress, setPoolAddress] = useState<string>('solana:Meteora-SOL-USDC');
  const [distribution, setDistribution] = useState<'spot' | 'curve' | 'bidask'>('spot');
  const [rangeSource, setRangeSource] = useState('Manual example bounds — not observed market price');
  const [rangeLower, setRangeLower] = useState(175);
  const [rangeUpper, setRangeUpper] = useState(195);
  const [rungCount, setRungCount] = useState(12);
  const [depositRaw, setDepositRaw] = useState('');
  const [depositScale, setDepositScale] = useState('9');
  const [depositAsset, setDepositAsset] = useState('solana:USDC');
  const [autoRebalance, setAutoRebalance] = useState(false);

  useEffect(() => {
    const pPool = searchParams.get('pool');
    const pChain = searchParams.get('chain');
    const pPrice = searchParams.get('price');

    if (pPool) setPoolAddress(pPool);
    if (pChain && ['solana', 'robinhood-chain', 'base', 'ethereum', 'bsc'].includes(pChain)) setChain(pChain as typeof chain);
    const bounds = observedBuilderBounds(pPrice);
    if (bounds) {
      setRangeLower(bounds.lower); setRangeUpper(bounds.upper);
      setRangeSource('Bounds suggested from a recorded price — runtime freshness unverified');
    } else setRangeSource('Manual example bounds — no valid price observation supplied');
  }, [searchParams]);


  return (
    <div className="space-y-4 sm:space-y-6 max-w-full overflow-hidden">
      <div className="bg-surface-container-low border border-border-subtle rounded-xl p-4 sm:p-5 shadow-xs space-y-1">
        <h1 className="text-lg sm:text-xl font-bold text-primary tracking-tight">
          Pro Custom Ladder Builder
        </h1>
        <p className="text-xs text-on-surface-variant max-w-2xl leading-relaxed">
          {rangeSource}. Plan a paper liquidity ladder with locally recorded rebalancing. Live deployment is unavailable; server valuation and current paper policy must permit acquisition.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Controls Column */}
        <div className="lg:col-span-1 bg-surface-container-lowest border border-border-subtle rounded-xl p-4 sm:p-5 space-y-4 sm:space-y-5 shadow-xs">
          <h2 className="text-sm font-bold text-primary flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">tune</span>
            <span>Position Parameters</span>
          </h2>

          <div className="space-y-3.5 text-xs">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant block">
                Chain
              </label>
              <select
                value={chain}
                onChange={(e) => setChain(e.target.value as typeof chain)}
                className="w-full mt-1 p-2.5 bg-surface-container border border-border-subtle rounded-lg text-xs text-on-surface"
              >
                <option value="solana">Solana (Meteora DLMM; Raydium unavailable)</option>
                <option value="robinhood-chain">Robinhood Chain (Uniswap v3)</option>
                <option value="base">Base (Uniswap v3)</option>
                <option value="ethereum">Ethereum Mainnet (Uniswap v3)</option>
                <option value="bsc">BNB Smart Chain (PancakeSwap v3)</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant block">
                Pool Address
              </label>
              <input
                type="text"
                value={poolAddress}
                onChange={(e) => setPoolAddress(e.target.value)}
                className="w-full mt-1 p-2.5 bg-surface-container border border-border-subtle rounded-lg font-mono text-xs text-on-surface"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant block">
                Distribution Curve
              </label>
              <div className="grid grid-cols-3 gap-2 mt-1">
                {(['spot', 'curve', 'bidask'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setDistribution(s)}
                    className={`py-2 text-xs font-bold rounded-lg capitalize border transition-all active:scale-95 ${
                      distribution === s
                        ? 'bg-primary text-on-primary border-primary shadow-xs'
                        : 'bg-surface-container border-border-subtle text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-on-surface-variant mt-1.5 leading-tight">
                {distribution === 'spot' && 'Uniform spread across the entire range.'}
                {distribution === 'curve' && 'Heavy weight near current price to capture high swap volume.'}
                {distribution === 'bidask' && 'Concentrated at outer boundaries for spread capture.'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant block">
                  Lower Price
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={rangeLower}
                  onChange={(e) => { setRangeLower(Number(e.target.value)); setRangeSource('Manual user bounds — not an observed price'); }}
                  className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded-lg font-mono text-xs text-on-surface"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant block">
                  Upper Price
                </label>
                <input
                  type="number"
                  step="0.0001"
                  value={rangeUpper}
                  onChange={(e) => { setRangeUpper(Number(e.target.value)); setRangeSource('Manual user bounds — not an observed price'); }}
                  className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded-lg font-mono text-xs text-on-surface"
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center">
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">
                  Rung Count (Bins/Ticks)
                </label>
                <span className="font-mono font-bold text-primary">{rungCount}</span>
              </div>
              <input
                type="range"
                min="2"
                max="32"
                value={rungCount}
                onChange={(e) => setRungCount(Number(e.target.value))}
                className="w-full h-2 mt-2 bg-surface-container rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>

            <div>
              <p className="text-xs">Deposit quantity uses canonical raw units and explicit scale, never floating USD. Scale is validated against trusted asset evidence.</p>
              <label className="block">Deposit asset<input aria-label="depositAsset" value={depositAsset} onChange={e => setDepositAsset(e.target.value)} className="border p-2 w-full" /></label>
              <label className="block">Deposit raw<input aria-label="depositRaw" inputMode="numeric" value={depositRaw} onChange={e => setDepositRaw(e.target.value)} className="border p-2 w-full" /></label>
              <label className="block">Deposit scale<input aria-label="depositScale" inputMode="numeric" value={depositScale} onChange={e => setDepositScale(e.target.value)} className="border p-2 w-full" /></label>
            </div>

            <div className="p-3 bg-surface-container-low border border-border-subtle rounded-lg flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-on-surface">Paper Auto-Rebalance</p>
                <p className="text-[10px] text-on-surface-variant">Auto-recenter when fee uplift &gt; IL + cost</p>
              </div>
              <input
                type="checkbox"
                checked={autoRebalance}
                onChange={(e) => setAutoRebalance(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
            </div>
          </div>

          <FinancialRequestPanel kind="lp-acquire" lpRequest={{ chain, poolAddress, depositAsset,
            deposit: { raw: depositRaw, scale: Number(depositScale) }, strategy: { distribution, rangeLower, rangeUpper, rungCount }, autoRebalance }} />
        </div>

        {/* Visualizer Column */}
        <div className="lg:col-span-2 bg-surface-container-lowest border border-border-subtle rounded-xl p-4 sm:p-5 space-y-4 flex flex-col justify-between shadow-xs">
          <div>
            <div className="flex items-center justify-between border-b border-border-subtle pb-3">
              <h2 className="text-sm font-bold text-primary flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">equalizer</span>
                <span>Liquidity Depth & Bin Allocations</span>
              </h2>
              <span className="text-[10px] sm:text-[11px] font-mono text-emerald-400 font-bold uppercase bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                {distribution} Curve
              </span>
            </div>

            {/* Visualizer Bars (Horizontally Continuous & Scrollable) */}
            <div className="mt-4 sm:mt-6 space-y-2">
              <div className="flex items-center justify-between text-[10px] uppercase font-bold text-on-surface-variant tracking-wider">
                <span>Active Bins ({rangeLower} → {rangeUpper})</span>
                <span className="font-mono">{rungCount} Rungs</span>
              </div>

              <div className="flex items-end gap-1 sm:gap-1.5 h-40 sm:h-48 p-3 sm:p-4 bg-surface-container-low border border-border-subtle rounded-xl overflow-x-auto no-scrollbar">
                {Array.from({ length: rungCount }).map((_, i) => {
                  const stepPrice = rangeLower + (i * (rangeUpper - rangeLower)) / rungCount;
                  let heightPct = 50;
                  if (distribution === 'curve') {
                    heightPct = Math.max(15, Math.round(100 - i * (80 / rungCount)));
                  } else if (distribution === 'bidask') {
                    heightPct = Math.max(20, Math.round(Math.abs(i - rungCount / 2) * 2 * (90 / rungCount)));
                  }

                  return (
                    <div key={i} className="flex-1 min-w-[14px] sm:min-w-[18px] flex flex-col items-center gap-1 group h-full justify-end">
                      <div
                        style={{ height: `${heightPct}%` }}
                        className="w-full bg-primary/70 group-hover:bg-primary rounded-t transition-all cursor-pointer"
                        title={`Bin #${i + 1}: Price ~${stepPrice.toFixed(2)}`}
                      ></div>
                      <span className="text-[8px] sm:text-[9px] font-mono text-on-surface-variant truncate block w-full text-center">
                        {Math.round(stepPrice)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Projected Analytics */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 mt-4 sm:mt-6">
              <div className="p-3 bg-surface-container-low border border-border-subtle rounded-xl">
                <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider block">
                  Fee Yield Assessment
                </span>
                <span className="text-sm sm:text-base font-mono font-bold text-emerald-400 mt-1 block">
                  Unassessed — no yield forecast
                </span>
              </div>
              <div className="p-3 bg-surface-container-low border border-border-subtle rounded-xl">
                <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider block">
                  Capital Allocation
                </span>
                <span className="text-sm sm:text-base font-mono font-bold text-on-surface mt-1 block">
                  {depositRaw || 'Unset'} raw · scale {depositScale} · {depositAsset} · USD valuation unassessed
                </span>
              </div>
              <div className="p-3 bg-surface-container-low border border-border-subtle rounded-xl">
                <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider block">
                  Auto Rebalance
                </span>
                <span
                  className={`text-sm sm:text-base font-mono font-bold mt-1 block ${
                    autoRebalance ? 'text-primary' : 'text-on-surface-variant'
                  }`}
                >
                  {autoRebalance ? 'PAPER OPT-IN' : 'OFF'}
                </span>
              </div>
            </div>
          </div>

          <div className="border-t border-border-subtle pt-3 mt-4 flex items-center gap-2 text-[11px] text-on-surface-variant">
            <span className="material-symbols-outlined text-[16px] text-primary">lock</span>
            <span>Paper planning only: no position NFT, DLMM key, deployed vault or live custody ownership is established.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LpBuilderPage() {
  return (
    <Suspense
      fallback={
        <div className="p-12 text-center text-xs text-on-surface-variant font-mono">
          Loading LP Ladder Builder...
        </div>
      }
    >
      <BuilderContent />
    </Suspense>
  );
}
