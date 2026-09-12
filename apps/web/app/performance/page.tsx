import Link from 'next/link';
import { serverApiGet } from '../../lib/api-server.js';
import { describeApiError } from '../../lib/api-error-message.js';

export const dynamic = 'force-dynamic';

/**
 * Still a server component (checklist S6-3). Same reasoning as
 * `app/signals/page.tsx`: the browser client in `lib/api.ts` needs
 * `document.cookie` and `window.location`, so a server render has to forward the
 * incoming session cookie instead -- which is what `serverApiGet` does.
 */

/** Distinct from a data failure -- there is an action the reader can take. */
const SIGNED_OUT_MESSAGE = 'Sign in to view trading performance.';

/**
 * One panel's worth of data, with the same "render the page anyway" contract the
 * old local `apiFetch` had. It returned `null` on any failure so a dead
 * `/trading/trades` still left the win-rate tiles visible; that is preserved,
 * except the reason now travels alongside the `null` instead of only reaching
 * `console.error` on the host.
 */
async function load<T>(path: string, what: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const data = await serverApiGet<T>(path);
    if (data === null) return { data: null, error: SIGNED_OUT_MESSAGE };
    return { data, error: null };
  } catch (caught: unknown) {
    return { data: null, error: describeApiError(caught, `Failed to load ${what}`) };
  }
}

export default async function PerformancePage() {
  // Parallel rather than the three sequential awaits this replaced: independent
  // reads with no ordering between them, so serialising them only added latency.
  const [performanceResult, portfolioResult, tradesResult] = await Promise.all([
    load<any>('/v1/trading/performance', 'performance metrics'),
    load<any>('/v1/trading/portfolio', 'open positions'),
    load<any>('/v1/trading/trades', 'trade history')
  ]);

  const performance = performanceResult.data ?? {
    win_rate: 0,
    total_pnl_usd: 0,
    total_signals: 0
  };
  const positions = portfolioResult.data?.positions || [];
  const trades = tradesResult.data?.items || [];

  // First failure only. A lapsed session fails all three identically, and three
  // copies of the same banner reads as three separate problems.
  const error = performanceResult.error ?? portfolioResult.error ?? tradesResult.error;

  const winRatePercent = (parseFloat(performance.win_rate) * 100).toFixed(1);
  const totalPnL = parseFloat(performance.total_pnl_usd || 0);

  return (
    <main>
      <h1>Trading Performance</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        Track paper and live execution outcomes, open positions, and transaction history.
      </p>

      {/* Zeros below could mean "nothing traded yet" or "we could not ask".
          Without this banner those are the same screen. */}
      {error && (
        <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'var(--danger)', marginTop: '1rem' }}>
          <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Performance metrics */}
      <div className="grid" style={{ marginTop: '2rem' }}>
        <div className="card">
          <h3>Win Rate</h3>
          <div className="value" style={{ color: parseFloat(winRatePercent) >= 50 ? 'var(--success)' : 'inherit' }}>
            {winRatePercent}%
          </div>
          <span className="badge warning">Signals Triggered</span>
        </div>

        <div className="card">
          <h3>Total Net P&L</h3>
          <div className="value" style={{ color: totalPnL >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
          </div>
          <span className="badge warning">Simulated & Live Fills</span>
        </div>

        <div className="card">
          <h3>Total Monitored Signals</h3>
          <div className="value">
            {Number(performance.total_signals).toLocaleString()}
          </div>
          <span className="badge warning">SWAT Intel Stream</span>
        </div>
      </div>

      {/* Open Portfolio / Positions */}
      <div className="grid" style={{ gridTemplateColumns: '1fr', marginTop: '2rem' }}>
        <div className="card">
          <h3>Current Positions / Trades Summary</h3>
          {positions.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', marginTop: '1rem', fontStyle: 'italic' }}>
              No open positions or trades recorded yet.
            </p>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Token Mint Address</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Total Size (SOL)</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Total Cost (USD)</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos: any, idx: number) => (
                    <tr key={`${pos.token_mint || 'unknown'}-${idx}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '0.75rem 0.5rem', fontFamily: 'monospace' }}>
                        {pos.token_mint ? (
                          <a href={`https://dexscreener.com/${pos.token_mint.includes(':') ? pos.token_mint.split(':')[0] : 'solana'}/${pos.token_mint.includes(':') ? pos.token_mint.split(':')[1] : pos.token_mint}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                            {pos.token_mint.includes(':') ? pos.token_mint.split(':')[1] : pos.token_mint}
                          </a>
                        ) : 'N/A'}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', fontWeight: 600 }}>{parseFloat(pos.total_sol).toFixed(3)} SOL</td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>${parseFloat(pos.total_usd || 0).toFixed(2)}</td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <span className={`badge ${pos.direction === 'buy' ? 'success' : 'danger'}`}>
                          {pos.direction.toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Trades History Table */}
      <div className="grid" style={{ gridTemplateColumns: '1fr', marginTop: '2rem' }}>
        <div className="card">
          <h3>Execution Fills History (Last 50)</h3>
          {trades.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', marginTop: '1rem', fontStyle: 'italic' }}>
              No executed trades in database yet. Fills will appear as the trade-executor triggers on signals.
            </p>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)' }}>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Time</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Token</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Direction</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Size (SOL)</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Cost (USD)</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Tokens Acquired</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Mode</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Executor</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Impact</th>
                    <th style={{ padding: '0.75rem 0.5rem' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade: any) => (
                    <tr key={trade.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {new Date(trade.executed_at).toLocaleTimeString()}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', fontFamily: 'monospace' }}>
                        {trade.token_mint ? (
                          <a href={`https://dexscreener.com/${trade.token_mint.includes(':') ? trade.token_mint.split(':')[0] : 'solana'}/${trade.token_mint.includes(':') ? trade.token_mint.split(':')[1] : trade.token_mint}`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                            {(trade.token_mint.includes(':') ? trade.token_mint.split(':')[1] : trade.token_mint).slice(0, 8)}...
                          </a>
                        ) : 'N/A'}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <span className={`badge ${trade.direction === 'buy' ? 'success' : 'danger'}`}>
                          {trade.direction.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', fontWeight: 600 }}>
                        {trade.amount_sol ? `${parseFloat(trade.amount_sol).toFixed(3)} SOL` : 'N/A'}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        {trade.amount_usd ? `$${parseFloat(trade.amount_usd).toFixed(2)}` : 'N/A'}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        {trade.token_amount ? parseFloat(trade.token_amount).toLocaleString(undefined, { maximumFractionDigits: 2 }) : 'N/A'}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <span className={`badge ${trade.execution_mode === 'live' ? 'danger' : 'warning'}`}>
                          {trade.execution_mode}
                        </span>
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>
                        {trade.executor}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem', color: trade.price_impact_pct > 1 ? 'var(--warning)' : 'inherit' }}>
                        {trade.price_impact_pct != null ? `${parseFloat(trade.price_impact_pct).toFixed(2)}%` : 'N/A'}
                      </td>
                      <td style={{ padding: '0.75rem 0.5rem' }}>
                        <span className="badge success" style={{ textTransform: 'uppercase' }}>
                          {trade.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
