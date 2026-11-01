'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { lpApi } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

function BuilderContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [chain, setChain] = useState<string>('solana');
  const [poolAddress, setPoolAddress] = useState<string>('solana:Meteora-SOL-USDC');
  const [distribution, setDistribution] = useState<'spot' | 'curve' | 'bidask'>('spot');
  const [rangeLower, setRangeLower] = useState(175);
  const [rangeUpper, setRangeUpper] = useState(195);
  const [rungCount, setRungCount] = useState(12);
  const [depositAmount, setDepositAmount] = useState(500);
  const [autoRebalance, setAutoRebalance] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<string | null>(null);

  useEffect(() => {
    const pPool = searchParams.get('pool');
    const pChain = searchParams.get('chain');
    const pPrice = searchParams.get('price');

    if (pPool) setPoolAddress(pPool);
    if (pChain) setChain(pChain);
    if (pPrice) {
      const price = Number(pPrice);
      if (price > 0) {
        setRangeLower(Number((price * 0.9).toFixed(4)));
        setRangeUpper(Number((price * 1.1).toFixed(4)));
      }
    }
  }, [searchParams]);

  const handleDeploy = async () => {
    setDeploying(true);
    setDeployResult(null);
    try {
      await lpApi.post('/v1/lp/positions/deploy', {
        chain,
        poolAddress,
        custom: {
          rangeLower,
          rangeUpper,
          rungCount,
          distribution
        },
        depositAmount,
        depositAsset: `${chain}:USDC`,
        autoRebalance
      });
      setDeployResult('LP Ladder successfully deployed in paper/execution mode!');
      setTimeout(() => {
        router.push('/lp/positions');
      }, 1500);
    } catch (err) {
      setDeployResult(`Deploy failed: ${describeApiError(err, 'Could not deploy ladder')}`);
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-primary tracking-tight">Pro Custom Ladder Builder</h1>
        <p className="text-xs text-on-surface-variant mt-1">
          Customize discrete price bins or continuous ticks, shape liquidity distributions, and enable autonomous rebalancing.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Controls Column */}
        <div className="lg:col-span-1 bg-surface-container-lowest border border-border-subtle rounded-lg p-5 space-y-5 shadow-sm">
          <h2 className="text-sm font-bold text-primary flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">tune</span>
            Position Parameters
          </h2>

          <div className="space-y-4 text-xs">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Chain</label>
              <select
                value={chain}
                onChange={(e) => setChain(e.target.value)}
                className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded text-xs text-on-surface"
              >
                <option value="solana">Solana (Meteora DLMM / Raydium CLMM)</option>
                <option value="robinhood-chain">Robinhood Chain (Uniswap v3)</option>
                <option value="base">Base (Uniswap v3)</option>
                <option value="ethereum">Ethereum Mainnet (Uniswap v3)</option>
                <option value="bsc">BNB Smart Chain (PancakeSwap v3)</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Pool Address</label>
              <input
                type="text"
                value={poolAddress}
                onChange={(e) => setPoolAddress(e.target.value)}
                className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded font-mono text-xs text-on-surface"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Distribution Curve</label>
              <div className="grid grid-cols-3 gap-2 mt-1">
                {(['spot', 'curve', 'bidask'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setDistribution(s)}
                    className={`p-2 text-xs font-bold rounded capitalize border transition-all ${
                      distribution === s
                        ? 'bg-primary text-on-primary border-primary'
                        : 'bg-surface-container border-border-subtle text-on-surface-variant'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-on-surface-variant mt-1.5">
                {distribution === 'spot' && 'Uniform spread across the range.'}
                {distribution === 'curve' && 'Heavy weight near current price to absorb dumps.'}
                {distribution === 'bidask' && 'Concentrated at outer boundaries for spread capture.'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Lower Price Bound</label>
                <input
                  type="number"
                  value={rangeLower}
                  onChange={(e) => setRangeLower(Number(e.target.value))}
                  className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded font-mono text-xs text-on-surface"
                />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Upper Price Bound</label>
                <input
                  type="number"
                  value={rangeUpper}
                  onChange={(e) => setRangeUpper(Number(e.target.value))}
                  className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded font-mono text-xs text-on-surface"
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between">
                <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Rung Count (Bins/Ticks)</label>
                <span className="font-mono font-bold text-primary">{rungCount}</span>
              </div>
              <input
                type="range"
                min="2"
                max="32"
                value={rungCount}
                onChange={(e) => setRungCount(Number(e.target.value))}
                className="w-full h-1.5 mt-2 bg-surface-container rounded appearance-none cursor-pointer accent-primary"
              />
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-on-surface-variant">Deposit Amount ($ USD)</label>
              <input
                type="number"
                value={depositAmount}
                onChange={(e) => setDepositAmount(Number(e.target.value))}
                className="w-full mt-1 p-2 bg-surface-container border border-border-subtle rounded font-mono text-xs text-on-surface"
              />
            </div>

            <div className="p-3 bg-surface-container-low border border-border-subtle rounded flex items-center justify-between">
              <div>
                <p className="text-xs font-bold text-on-surface">Autonomous Rebalance</p>
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

          {deployResult && (
            <div className={`p-3 rounded-lg text-xs font-mono ${
              deployResult.includes('successfully')
                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                : 'bg-red-500/20 text-red-300 border border-red-500/30'
            }`}>
              {deployResult}
            </div>
          )}

          <button
            disabled={deploying}
            onClick={() => void handleDeploy()}
            className="w-full py-2.5 rounded-lg bg-primary text-on-primary font-bold text-xs hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {deploying ? 'Deploying...' : 'Deploy LP Ladder'}
          </button>
        </div>

        {/* Visualizer Column */}
        <div className="lg:col-span-2 bg-surface-container-lowest border border-border-subtle rounded-lg p-5 space-y-4 flex flex-col justify-between shadow-sm">
          <div>
            <div className="flex items-center justify-between border-b border-border-subtle pb-3">
              <h2 className="text-sm font-bold text-primary flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">equalizer</span>
                Reconstructed Liquidity Depth & Bin Allocations
              </h2>
              <span className="text-[11px] font-mono text-emerald-400 font-bold uppercase">
                {distribution} Distribution
              </span>
            </div>

            {/* Visualizer Bars */}
            <div className="mt-6 space-y-2">
              <p className="text-[10px] uppercase font-bold text-on-surface-variant tracking-wider">
                Active Tick & Bin Distribution ({rangeLower} → {rangeUpper})
              </p>
              <div className="grid grid-cols-8 md:grid-cols-12 gap-1.5 h-44 items-end p-4 bg-surface-container-low border border-border-subtle rounded-lg">
                {Array.from({ length: rungCount }).map((_, i) => {
                  const stepPrice = rangeLower + (i * (rangeUpper - rangeLower)) / rungCount;
                  let heightPct = 50;
                  if (distribution === 'curve') {
                    heightPct = Math.max(15, Math.round(100 - i * (80 / rungCount)));
                  } else if (distribution === 'bidask') {
                    heightPct = Math.max(20, Math.round(Math.abs(i - rungCount / 2) * 2 * (90 / rungCount)));
                  }

                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
                      <div
                        style={{ height: `${heightPct}%` }}
                        className="w-full bg-primary/70 hover:bg-primary rounded-t transition-all cursor-pointer"
                      ></div>
                      <span className="text-[9px] font-mono text-on-surface-variant truncate block w-full text-center">
                        {Math.round(stepPrice)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Projected Analytics */}
            <div className="grid grid-cols-3 gap-3 mt-6">
              <div className="p-3 bg-surface-container-low border border-border-subtle rounded">
                <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider block">Target Fee Yield</span>
                <span className="text-base font-mono font-bold text-emerald-400 mt-1 block">184.2% APR</span>
              </div>
              <div className="p-3 bg-surface-container-low border border-border-subtle rounded">
                <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider block">Capital Allocation</span>
                <span className="text-base font-mono font-bold text-on-surface mt-1 block">${depositAmount}</span>
              </div>
              <div className="p-3 bg-surface-container-low border border-border-subtle rounded">
                <span className="text-[10px] text-on-surface-variant font-bold uppercase tracking-wider block">Auto Rebalance</span>
                <span className={`text-base font-mono font-bold mt-1 block ${autoRebalance ? 'text-primary' : 'text-on-surface-variant'}`}>
                  {autoRebalance ? 'ENABLED' : 'OFF'}
                </span>
              </div>
            </div>
          </div>

          <p className="text-[11px] text-on-surface-variant border-t border-border-subtle pt-3">
            Non-custodial execution: Position tokens (NFTs / DLMM keys) remain under sole ownership of your session vault.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LpBuilderPage() {
  return (
    <Suspense fallback={<div className="p-12 text-center text-xs text-on-surface-variant font-mono">Loading LP Ladder Builder...</div>}>
      <BuilderContent />
    </Suspense>
  );
}
