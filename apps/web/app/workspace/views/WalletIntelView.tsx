'use client';

import { useState, useEffect } from 'react';

export default function WalletIntelView() {
  const [activeTab, setActiveTab] = useState('Activity Feed');
  const [searchValue, setSearchValue] = useState('0x8a2...f3b');
  const [selectedChain, setSelectedChain] = useState('solana');
  const [walletData, setWalletData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  const apiKey = process.env.NEXT_PUBLIC_API_KEY ?? 'swat-dev-key';

  const fetchWallet = async (address: string, chain: string) => {
    setIsLoading(true);
    try {
      const res = await fetch(`${apiUrl}/v1/wallets/${address}?chain=${chain}`, {
        headers: { 'X-Api-Key': apiKey }
      });
      if (res.ok) {
        const data = await res.json();
        setWalletData(data);
      } else {
        setWalletData(null);
      }
    } catch (err) {
      console.error(err);
      setWalletData(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    // Optionally fetch a default wallet or wait for user action
  }, []);

  return (
    <div className="max-w-[1440px] mx-auto p-6 space-y-6">
      {/* Search & Control Row */}
      <div className="mb-6 flex flex-col md:flex-row gap-4 items-end">
        <div className="flex-1 w-full">
          <label className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant mb-1 block">Intel Search</label>
          <div className="flex gap-2">
            <div className="relative w-48 shrink-0">
              <select 
                value={selectedChain}
                onChange={(e) => setSelectedChain(e.target.value)}
                className="w-full pl-3 pr-8 py-2 bg-white border border-border-subtle rounded-lg text-xs font-medium appearance-none focus:border-primary focus:ring-0"
              >
                <option value="solana">Solana (SOL)</option>
                <option value="polygon">Polygon (POLY)</option>
                <option value="robinhood-chain">Robinhood (RH)</option>
              </select>
              <span className="material-symbols-outlined absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-outline">expand_more</span>
            </div>
            
            <div className="relative flex-1">
              <input 
                type="text" 
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                className="w-full pl-4 pr-12 py-2 bg-white border border-border-subtle rounded-lg font-mono text-xs focus:border-primary focus:ring-0"
              />
              <button 
                onClick={() => { navigator.clipboard.writeText(searchValue); alert('Address copied!'); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-outline hover:text-primary"
              >
                <span className="material-symbols-outlined text-[18px]">content_copy</span>
              </button>
            </div>
            
            <button 
              onClick={() => fetchWallet(searchValue, selectedChain)}
              className="px-6 bg-primary text-white rounded-lg font-bold text-xs hover:opacity-90 transition-opacity disabled:opacity-50"
              disabled={isLoading}
            >
              {isLoading ? 'Verifying...' : 'Verify Address'}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 items-start">
        {/* Left Column: Wallet Detail */}
        <div className="col-span-12 lg:col-span-8 space-y-6">
          {/* Wallet Scorecard */}
          <div className="bg-white border border-border-subtle rounded-lg p-6 flex items-center gap-8 relative overflow-hidden shadow-sm">
            {/* Subtle chain accent line */}
            <div className={`absolute left-0 top-0 bottom-0 w-1 ${selectedChain === 'solana' ? 'bg-solana-teal' : selectedChain === 'polygon' ? 'bg-polymarket-violet' : 'bg-robinhood-amber'}`}></div>
            <div className="text-center shrink-0">
              <div className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest mb-1">Reputation Score</div>
              <div className="text-4xl font-black text-primary leading-none">{walletData?.composite_score ?? 'N/A'}<span className="text-lg text-outline font-medium">/100</span></div>
              <div className={`mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 bg-primary/10 text-primary text-[10px] font-bold rounded uppercase`}>
                <span className={`w-1.5 h-1.5 rounded-full bg-primary`}></span> {walletData?.tier ?? 'Unknown Tier'}
              </div>
            </div>
            <div className="h-16 w-px bg-border-subtle"></div>
            <div className="grid grid-cols-4 flex-1 gap-6">
              <div>
                <p className="text-[10px] text-outline font-bold uppercase mb-1">Chain</p>
                <div className="flex items-center gap-1.5 font-bold text-xs text-primary capitalize">
                  <span className={`w-2.5 h-2.5 rounded-full ${selectedChain === 'solana' ? 'bg-solana-teal' : selectedChain === 'polygon' ? 'bg-polymarket-violet' : 'bg-robinhood-amber'}`}></span> {selectedChain}
                </div>
              </div>
              <div>
                <p className="text-[10px] text-outline font-bold uppercase mb-1">Trades (30D)</p>
                <p className="font-mono text-xs font-bold text-primary">{walletData?.total_trades ?? 0}</p>
              </div>
              <div>
                <p className="text-[10px] text-outline font-bold uppercase mb-1">Win Rate</p>
                <p className="font-mono text-xs font-bold text-status-success">{walletData?.win_rate ? Number(walletData.win_rate).toFixed(1) + '%' : 'N/A'}</p>
              </div>
              <div>
                <p className="text-[10px] text-outline font-bold uppercase mb-1">Realized P&amp;L</p>
                <p className="font-mono text-xs font-bold text-status-success">{walletData?.realized_roi ? (Number(walletData.realized_roi) > 0 ? '+' : '') + Number(walletData.realized_roi).toFixed(2) + '%' : 'N/A'}</p>
              </div>
            </div>
          </div>

          {/* Evidence Tabs */}
          <div className="bg-white border border-border-subtle rounded-lg overflow-hidden shadow-sm">
            <div className="flex border-b border-border-subtle px-2">
              {['Activity Feed', 'Positions', 'Funding Graph', 'Linked Clusters'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-6 py-4 text-xs font-bold transition-all border-b-2 ${
                    activeTab === tab 
                      ? 'border-primary text-primary' 
                      : 'border-transparent text-on-surface-variant hover:text-primary'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            
            <div className="p-0">
              {activeTab === 'Activity Feed' && (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-surface-container-low border-b border-border-subtle text-[11px] font-bold text-on-surface-variant">
                      <th className="px-6 py-3">Time (UTC)</th>
                      <th className="px-6 py-3">Action</th>
                      <th className="px-6 py-3">Asset</th>
                      <th className="px-6 py-3">Value</th>
                      <th className="px-6 py-3 text-right">TX Hash</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle font-mono text-xs text-primary">
                    <tr className="hover:bg-surface-container-low/50 transition-colors cursor-pointer group">
                      <td className="px-6 py-3 text-outline">14:22:08</td>
                      <td className="px-6 py-3 font-bold text-status-success">
                        BUY <span className="ml-1 material-symbols-outlined text-sm align-middle">trending_up</span>
                      </td>
                      <td className="px-6 py-3 font-bold">$JUP</td>
                      <td className="px-6 py-3">12.5K SOL</td>
                      <td className="px-6 py-3 text-right text-outline group-hover:text-primary">8a2f...3bc9</td>
                    </tr>
                    <tr className="hover:bg-surface-container-low/50 transition-colors cursor-pointer group">
                      <td className="px-6 py-3 text-outline">14:15:22</td>
                      <td className="px-6 py-3 font-bold text-status-success">
                        BUY <span className="ml-1 material-symbols-outlined text-sm align-middle">trending_up</span>
                      </td>
                      <td className="px-6 py-3 font-bold">$SOL</td>
                      <td className="px-6 py-3">50.0K USDC</td>
                      <td className="px-6 py-3 text-right text-outline group-hover:text-primary">f922...11d1</td>
                    </tr>
                    <tr className="hover:bg-surface-container-low/50 transition-colors cursor-pointer group">
                      <td className="px-6 py-3 text-outline">13:48:10</td>
                      <td className="px-6 py-3 font-bold text-status-error">
                        SELL <span className="ml-1 material-symbols-outlined text-sm align-middle">trending_down</span>
                      </td>
                      <td className="px-6 py-3 font-bold">$PYTH</td>
                      <td className="px-6 py-3">8.2K SOL</td>
                      <td className="px-6 py-3 text-right text-outline group-hover:text-primary">c011...982x</td>
                    </tr>
                    <tr className="hover:bg-surface-container-low/50 transition-colors cursor-pointer group">
                      <td className="px-6 py-3 text-outline">12:02:44</td>
                      <td className="px-6 py-3 font-bold text-status-success">
                        BUY <span className="ml-1 material-symbols-outlined text-sm align-middle">trending_up</span>
                      </td>
                      <td className="px-6 py-3 font-bold">$BONK</td>
                      <td className="px-6 py-3">2.1K SOL</td>
                      <td className="px-6 py-3 text-right text-outline group-hover:text-primary">12e5...ff09</td>
                    </tr>
                  </tbody>
                </table>
              )}
              {activeTab !== 'Activity Feed' && (
                <div className="p-8 text-center text-xs text-on-surface-variant font-medium">
                  Behavioral profile sync active. No additional data loaded for <span className="font-bold text-primary">{activeTab}</span>.
                </div>
              )}
            </div>
          </div>

          {/* Cluster Awareness Banner */}
          <div className="bg-primary p-5 rounded-lg text-white flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center">
                <span className="material-symbols-outlined text-3xl text-solana-teal">hub</span>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-white/60 mb-0.5">Primary Behavioral Group</p>
                <h3 className="text-lg font-bold">Stealth Snipe Cluster #41</h3>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-bold text-white/60 uppercase mb-1">Affinity Match</p>
              <p className="text-xl font-black text-solana-teal">98.2%</p>
            </div>
          </div>
        </div>

        {/* Right Column: Cluster Exploration */}
        <div className="col-span-12 lg:col-span-4 space-y-6">
          {/* Cluster Conviction Matrix */}
          <div className="bg-white border border-border-subtle rounded-lg p-6 shadow-sm">
            <h4 className="text-xs font-bold text-primary mb-6 flex items-center gap-2">
              <span className="material-symbols-outlined text-primary">analytics</span>
              Cluster Conviction Matrix
            </h4>
            <div className="space-y-6">
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] font-bold uppercase text-on-surface-variant">Asset Aggregation: $JUP</span>
                  <span className="text-xs font-mono font-bold text-primary">8/12 Wallets</span>
                </div>
                <div className="h-2 w-full bg-surface-container-high rounded-full overflow-hidden flex">
                  <div className="h-full bg-solana-teal w-[66%]"></div>
                </div>
                <p className="mt-2 text-[10px] text-outline italic">Recent coordinated buy action detected within last 4 hours.</p>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] font-bold uppercase text-on-surface-variant">Prediction Market: Polymarket</span>
                  <span className="text-xs font-mono font-bold text-primary">4/12 Wallets</span>
                </div>
                <div className="h-2 w-full bg-surface-container-high rounded-full overflow-hidden">
                  <div className="h-full bg-polymarket-violet w-[33%]"></div>
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] font-bold uppercase text-on-surface-variant">Robinhood Outflow</span>
                  <span className="text-xs font-mono font-bold text-primary">11/12 Wallets</span>
                </div>
                <div className="h-2 w-full bg-surface-container-high rounded-full overflow-hidden">
                  <div className="h-full bg-robinhood-amber w-[91%]"></div>
                </div>
              </div>
            </div>
          </div>

          {/* Related Clusters */}
          <div className="bg-white border border-border-subtle rounded-lg overflow-hidden shadow-sm">
            <div className="p-4 border-b border-border-subtle flex justify-between items-center bg-surface-container-lowest">
              <h4 className="text-xs font-bold text-primary">Related Clusters</h4>
              <span className="text-[10px] bg-primary text-white px-2 py-0.5 rounded font-bold">LIVE FEED</span>
            </div>
            <div className="divide-y divide-border-subtle">
              {/* Cluster 1 */}
              <div className="p-4 hover:bg-surface-container-low transition-colors cursor-pointer">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <p className="text-xs font-bold text-primary">#41 Stealth Snipe</p>
                    <p className="text-[10px] text-outline">Solana Native</p>
                  </div>
                  <div className="text-right">
                    <span className="text-mono text-xs font-bold text-status-success">High Confidence</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-4 bg-solana-teal rounded-[1px]"></span>
                    <span className="w-1.5 h-4 bg-border-subtle rounded-[1px]"></span>
                    <span className="w-1.5 h-4 bg-border-subtle rounded-[1px]"></span>
                  </div>
                  <span className="text-[10px] font-bold text-on-surface-variant">12 Wallets • 2m ago</span>
                </div>
              </div>
              {/* Cluster 2 */}
              <div className="p-4 hover:bg-surface-container-low transition-colors cursor-pointer">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <p className="text-xs font-bold text-primary">#102 Predic-Alpha</p>
                    <p className="text-[10px] text-outline">Polygon/RH Hybrid</p>
                  </div>
                  <div className="text-right">
                    <span className="text-mono text-xs font-bold text-status-warning">Med Confidence</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-4 bg-border-subtle rounded-[1px]"></span>
                    <span className="w-1.5 h-4 bg-polymarket-violet rounded-[1px]"></span>
                    <span className="w-1.5 h-4 bg-robinhood-amber rounded-[1px]"></span>
                  </div>
                  <span className="text-[10px] font-bold text-on-surface-variant">42 Wallets • 14m ago</span>
                </div>
              </div>
            </div>
            <button className="w-full py-3 text-[10px] font-bold text-outline hover:text-primary hover:bg-surface-container-low transition-all border-t border-border-subtle uppercase tracking-widest">
              Expand Cluster Registry
            </button>
          </div>

          {/* Operator Briefing */}
          <div className="bg-surface-container-highest border border-border-subtle rounded-lg p-4 border-l-4 border-l-primary shadow-sm">
            <p className="text-[10px] font-bold uppercase text-on-surface-variant mb-2">Operator Briefing</p>
            <p className="text-xs text-on-surface leading-relaxed">
              Wallet <span className="font-mono font-bold">0x8a2...f3b</span> exhibits high behavioral correlation with known insider accumulation patterns on JUP. Cross-chain funding originated from a Robinhood Tier-2 institutional bridge. Recommend monitoring <span className="font-bold text-polymarket-violet">Cluster #102</span> for corresponding hedge positions.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
