'use client';

import { useState, useEffect } from 'react';
import { api } from '../../../lib/api.js';
import { describeApiError } from '../../../lib/api-error-message.js';

function logAndIgnore(what: string) {
  return (err: unknown): null => {
    console.error(describeApiError(err, `Command centre could not load ${what}`), err);
    return null;
  };
}

export default function CommandCenterView() {
  const [solanaMode, setSolanaMode] = useState('LIVE');
  const [polygonMode, setPolygonMode] = useState('PAPER');
  const [robinhoodMode, setRobinhoodMode] = useState('OFF');
  
  const [stats, setStats] = useState({ signalsToday: 0, trades: 0, clusters: 0 });
  const [walletCount, setWalletCount] = useState(0);
  const [signals, setSignals] = useState<any[]>([]);

  /**
   * Each tile keeps its own failure, as before: the old code guarded every
   * response with `if (res.ok)`, so one endpoint being down left the other two
   * populated. A shared try/catch would now abandon the rest of the panel the
   * moment `apiFetch` threw.
   *
   * There is no error surface on this view, so a failure still shows as zeros --
   * logged with its status, but not visible to the operator. Worth an error state
   * eventually; adding one is outside this conversion.
   */
  const fetchData = async () => {
    const [statsData, walletsData, sigsData] = await Promise.all([
      api.get<any>('/v1/signals/stats').catch(logAndIgnore('signal stats')),
      api.get<any>('/v1/wallets').catch(logAndIgnore('wallets')),
      api.get<any>('/v1/signals?limit=10').catch(logAndIgnore('recent signals'))
    ]);
    if (statsData) setStats(statsData);
    if (walletsData) setWalletCount(walletsData.length || 0);
    if (sigsData) setSignals(sigsData.items || []);
  };

  useEffect(() => {
    fetchData();
    const int = setInterval(fetchData, 5000);
    return () => clearInterval(int);
  }, []);

  return (
    <div className="max-w-[1440px] mx-auto p-6 space-y-6">
      {/* Dashboard Header */}
      <div className="flex justify-between items-end mb-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-lg font-bold text-primary">Command Center</h2>
            <span className="px-2 py-0.5 rounded bg-tertiary text-white text-[10px] font-bold uppercase tracking-wider">Sandbox</span>
          </div>
          <p className="text-xs text-secondary">Global operational overview and real-time execution matrix.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={fetchData} className="flex items-center gap-2 px-3 py-2 bg-surface-container border border-outline-variant rounded hover:bg-surface-container-high transition-colors text-xs font-bold">
            <span className="material-symbols-outlined">refresh</span>
            Refresh
          </button>
          <button className="flex items-center gap-2 px-3 py-2 bg-primary text-white rounded hover:opacity-90 transition-opacity text-xs font-bold">
            <span className="material-symbols-outlined">bolt</span>
            Quick Execute
          </button>
        </div>
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="p-4 bg-surface border border-outline-variant rounded shadow-sm">
          <p className="text-[11px] font-bold text-secondary uppercase tracking-wider mb-2">Tracked Wallets</p>
          <div className="flex justify-between items-end">
            <h3 className="text-2xl font-bold font-mono">{walletCount}</h3>
            <span className="text-status-success text-xs font-bold flex items-center">
              LIVE
            </span>
          </div>
        </div>
        <div className="p-4 bg-surface border border-outline-variant rounded shadow-sm">
          <p className="text-[11px] font-bold text-secondary uppercase tracking-wider mb-2">Active Clusters</p>
          <div className="flex justify-between items-end">
            <h3 className="text-2xl font-bold font-mono">{stats.clusters}</h3>
            <span className="text-secondary text-xs font-bold flex items-center">
              LIVE
            </span>
          </div>
        </div>
        <div className="p-4 bg-surface border border-outline-variant rounded shadow-sm">
          <p className="text-[11px] font-bold text-secondary uppercase tracking-wider mb-2">Signals (24h)</p>
          <div className="flex justify-between items-end">
            <h3 className="text-2xl font-bold font-mono">{stats.signalsToday}</h3>
            <span className="text-status-success text-xs font-bold flex items-center">
              LIVE
            </span>
          </div>
        </div>
        <div className="p-4 bg-surface border border-outline-variant rounded shadow-sm">
          <p className="text-[11px] font-bold text-secondary uppercase tracking-wider mb-2">Confirmed Executions</p>
          <div className="flex justify-between items-end">
            <h3 className="text-2xl font-bold font-mono">{stats.trades}</h3>
            <span className="text-secondary text-xs font-bold flex items-center">
              LIVE
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Signal Feed Table (Main Area) */}
        <div className="col-span-12 lg:col-span-9 space-y-6">
          <section className="bg-surface border border-outline-variant rounded overflow-hidden">
            <div className="px-4 py-3 border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
              <h4 className="text-sm font-bold flex items-center gap-2 text-primary">
                <span className="material-symbols-outlined text-primary">sensors</span>
                Live Signal Feed
              </h4>
              <div className="flex gap-2">
                <button className="text-[10px] uppercase font-bold text-secondary hover:text-primary">Filter</button>
                <button className="text-[10px] uppercase font-bold text-secondary hover:text-primary">Export</button>
              </div>
            </div>
            <div className="overflow-x-auto custom-scrollbar">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-surface-container-low text-[11px] font-bold text-secondary border-b border-outline-variant">
                    <th className="px-4 py-3">Time (UTC)</th>
                    <th className="px-4 py-3">Chain</th>
                    <th className="px-4 py-3">Pattern</th>
                    <th className="px-4 py-3">Source</th>
                    <th className="px-4 py-3">Asset</th>
                    <th className="px-4 py-3">Conf.</th>
                    <th className="px-4 py-3">Safety</th>
                    <th className="px-4 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant text-[13px]">
                  {signals.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-secondary">
                        No active signals detected. Monitoring engine is online.
                      </td>
                    </tr>
                  ) : (
                    signals.map((sig) => {
                      const time = new Date(sig.created_at).toLocaleTimeString([], { hour12: false });
                      let chainStr = 'SOL';
                      let chainColor = 'border-solana-teal';
                      const mint = sig.token_mint || '';
                      if (mint.startsWith('0x')) {
                        chainStr = 'ROBIN';
                        chainColor = 'border-robinhood-amber';
                      } else if (mint.includes(':')) {
                        chainStr = 'POLY';
                        chainColor = 'border-polymarket-violet';
                      }
                      const pattern = (sig.pattern_type || 'UNKNOWN').toUpperCase();
                      const patternBg = pattern === 'SNIPE' ? 'bg-tertiary-fixed text-primary' : 'bg-surface-container-highest text-secondary';
                      const asset = sig.token_symbol ? `$${sig.token_symbol}` : sig.token_name || mint.slice(0, 8);
                      const conf = sig.confidence || 0;
                      const isSecure = conf >= 80;

                      return (
                        <tr key={sig.id} className="hover:bg-surface-container-low transition-colors group">
                          <td className="px-4 py-3 font-mono">{time}</td>
                          <td className="px-4 py-3">
                            <span className={`border-l-2 ${chainColor} pl-2 text-[11px] font-bold`}>{chainStr}</span>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`px-1.5 py-0.5 ${patternBg} text-[10px] font-bold rounded`}>{pattern}</span>
                          </td>
                          <td className="px-4 py-3 font-mono text-secondary">{sig.cluster_id || 'Global'}</td>
                          <td className="px-4 py-3 font-bold text-primary">{asset}</td>
                          <td className="px-4 py-3">
                            <div className="w-full bg-outline-variant rounded-full h-1.5 max-w-[60px]">
                              <div className="bg-primary h-1.5 rounded-full" style={{ width: `${conf}%` }}></div>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <span className={`px-2 py-0.5 rounded-sm ${isSecure ? 'bg-status-success/10 text-status-success' : 'bg-status-warning/10 text-status-warning'} text-[10px] font-bold`}>
                              {isSecure ? 'SECURE' : 'CAUTION'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button className="px-3 py-1 bg-primary text-white text-[11px] font-bold rounded opacity-0 group-hover:opacity-100 transition-opacity">EXECUTE</button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>

              </table>
            </div>
          </section>

          {/* Execution Control Plane */}
          <section className="bg-surface border border-outline-variant rounded p-6">
            <h4 className="text-sm font-bold mb-6 flex items-center gap-2 uppercase tracking-tight text-primary">
              <span className="material-symbols-outlined">settings_input_component</span>
              Execution Control Plane
            </h4>
            <div className="space-y-4">
              {/* Solana Row */}
              <div className="grid grid-cols-12 items-center gap-4 py-3 border-b border-outline-variant last:border-0">
                <div className="col-span-3 flex items-center gap-3">
                  <div className="w-2 h-8 bg-solana-teal"></div>
                  <div>
                    <p className="text-sm font-bold text-primary">SOLANA MAINNET</p>
                    <p className="text-[10px] text-secondary">Low Latency RPC Active</p>
                  </div>
                </div>
                <div className="col-span-6">
                  <div className="inline-flex bg-surface-container p-1 rounded border border-outline-variant">
                    {['OFF', 'PAPER', 'LIVE', 'LIVE + SHADOW'].map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setSolanaMode(mode)}
                        className={`px-4 py-1 text-[11px] font-bold rounded transition-colors ${
                          solanaMode === mode 
                            ? 'bg-primary text-on-primary shadow-sm' 
                            : 'text-secondary hover:text-primary'
                        }`}
                      >
                        {mode === 'LIVE + SHADOW' ? 'LIVE + S' : mode}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="col-span-3 text-right">
                  <span className="text-status-success text-[11px] font-bold flex items-center justify-end gap-1">
                    <span className="w-1.5 h-1.5 bg-status-success rounded-full animate-pulse"></span>
                    Operational
                  </span>
                </div>
              </div>
              {/* Polygon Row */}
              <div className="grid grid-cols-12 items-center gap-4 py-3 border-b border-outline-variant last:border-0">
                <div className="col-span-3 flex items-center gap-3">
                  <div className="w-2 h-8 bg-polymarket-violet"></div>
                  <div>
                    <p className="text-sm font-bold text-primary">POLYGON POS</p>
                    <p className="text-[10px] text-secondary">Standard Priority</p>
                  </div>
                </div>
                <div className="col-span-6">
                  <div className="inline-flex bg-surface-container p-1 rounded border border-outline-variant">
                    {['OFF', 'PAPER', 'LIVE', 'LIVE + SHADOW'].map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setPolygonMode(mode)}
                        className={`px-4 py-1 text-[11px] font-bold rounded transition-colors ${
                          polygonMode === mode 
                            ? 'bg-primary text-on-primary shadow-sm' 
                            : 'text-secondary hover:text-primary'
                        }`}
                      >
                        {mode === 'LIVE + SHADOW' ? 'LIVE + S' : mode}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="col-span-3 text-right">
                  <span className="text-status-success text-[11px] font-bold flex items-center justify-end gap-1">
                    <span className="w-1.5 h-1.5 bg-status-success rounded-full"></span>
                    Operational
                  </span>
                </div>
              </div>
              {/* Robinhood Row */}
              <div className="grid grid-cols-12 items-center gap-4 py-3 border-b border-outline-variant last:border-0">
                <div className="col-span-3 flex items-center gap-3">
                  <div className="w-2 h-8 bg-robinhood-amber"></div>
                  <div>
                    <p className="text-sm font-bold text-primary">ROBINHOOD CHAIN</p>
                    <p className="text-[10px] text-secondary">Pending Integration</p>
                  </div>
                </div>
                <div className="col-span-6">
                  <div className="inline-flex bg-surface-container p-1 rounded border border-outline-variant opacity-60">
                    <button className="px-4 py-1 text-[11px] font-bold rounded bg-primary text-white shadow-sm cursor-not-allowed">OFF</button>
                    <button className="px-4 py-1 text-[11px] font-bold rounded text-secondary cursor-not-allowed" disabled>PAPER</button>
                    <button className="px-4 py-1 text-[11px] font-bold rounded text-secondary cursor-not-allowed" disabled>LIVE</button>
                    <button className="px-4 py-1 text-[11px] font-bold rounded text-secondary cursor-not-allowed" disabled>LIVE + S</button>
                  </div>
                </div>
                <div className="col-span-3 text-right">
                  <span className="text-status-warning text-[10px] font-bold">Paper Only (Certification Pending)</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Side Panels (Right Column) */}
        <div className="col-span-12 lg:col-span-3 space-y-6">
          {/* Ingestion Health */}
          <section className="bg-surface border border-outline-variant rounded p-4">
            <h4 className="text-[11px] font-bold text-secondary mb-4 uppercase tracking-wider">Ingestion Health</h4>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-status-success rounded-full"></div>
                  <span className="text-sm font-bold text-primary">Solana Stream</span>
                </div>
                <span className="font-mono text-[11px]">12ms lag</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-status-warning rounded-full animate-pulse"></div>
                  <span className="text-sm font-bold text-primary">Polygon RPC</span>
                </div>
                <span className="font-mono text-[11px] text-status-warning">1.4s lag</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-status-success rounded-full"></div>
                  <span className="text-sm font-bold text-primary">Ethereum WSS</span>
                </div>
                <span className="font-mono text-[11px]">45ms lag</span>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-outline-variant">
              <p className="text-[10px] text-secondary leading-relaxed">System health is nominal across 92% of nodes. Latency spike detected in Tokyo region.</p>
            </div>
          </section>

          {/* Recent Attribution */}
          <section className="bg-surface border border-outline-variant rounded p-4">
            <h4 className="text-[11px] font-bold text-secondary mb-4 uppercase tracking-wider">Recent Attribution</h4>
            <div className="space-y-6">
              <div className="relative pl-6 border-l-2 border-outline-variant">
                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-primary border-4 border-surface"></div>
                <div className="mb-1 flex justify-between">
                  <p className="text-sm font-bold text-primary">Signal #882-A</p>
                  <span className="text-status-success font-mono text-[11px]">+$1,242</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-secondary font-mono uppercase">
                  <span>Signal</span>
                  <span className="material-symbols-outlined text-[12px]">chevron_right</span>
                  <span className="text-primary font-bold">Paper</span>
                  <span className="material-symbols-outlined text-[12px]">chevron_right</span>
                  <span className="text-primary font-bold">Live</span>
                </div>
                <p className="mt-2 text-[10px] text-outline">Slippage: 0.12bps | Cost Delta: -$4.20</p>
              </div>
              
              <div className="relative pl-6 border-l-2 border-outline-variant">
                <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-outline-variant border-4 border-surface"></div>
                <div className="mb-1 flex justify-between">
                  <p className="text-sm font-bold text-primary">Signal #879-C</p>
                  <span className="text-status-neutral font-mono text-[11px]">+$0.00</span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-secondary font-mono uppercase">
                  <span>Signal</span>
                  <span className="material-symbols-outlined text-[12px]">chevron_right</span>
                  <span className="text-primary font-bold">Paper</span>
                  <span className="material-symbols-outlined text-[12px]">close</span>
                  <span className="text-outline">Skipped</span>
                </div>
                <p className="mt-2 text-[10px] text-outline">Rejected: Risk exposure limit exceeded.</p>
              </div>
            </div>
          </section>

          {/* Status Legend / Help */}
          <div className="p-4 bg-surface-container-low border border-outline-variant rounded">
            <p className="text-[11px] font-bold mb-2 uppercase tracking-tight text-secondary">System Protocols</p>
            <ul className="text-[10px] text-secondary space-y-1">
              <li className="flex items-center gap-2"><span className="w-1 h-1 bg-primary rounded-full"></span> All signals middle-truncated by default</li>
              <li className="flex items-center gap-2"><span className="w-1 h-1 bg-primary rounded-full"></span> Latency &gt; 500ms triggers amber state</li>
              <li className="flex items-center gap-2"><span className="w-1 h-1 bg-primary rounded-full"></span> Live mode requires dual-key cert</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
