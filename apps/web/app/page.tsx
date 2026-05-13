async function getApiStats() {
  try {
    const response = await fetch('http://localhost:3001/v1/stats', { cache: 'no-store' });
    if (!response.ok) return { wallets: 0, signals: 0, trades: 0 };
    return await response.json();
  } catch {
    return { wallets: 0, signals: 0, trades: 0 };
  }
}

export default async function HomePage() {
  const stats = await getApiStats();

  return (
    <main>
      <h1>Intelligence Dashboard</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        Real-time metrics for the SWAT (Solana Wallet Analysis & Tracking) Intelligence Layer.
      </p>

      <div className="grid">
        <div className="card">
          <h3>Tracked Wallets</h3>
          <div className="value">{stats.wallets.toLocaleString()}</div>
          <span className="badge success">+124 Today</span>
        </div>
        <div className="card">
          <h3>Active Clusters</h3>
          <div className="value">42</div>
          <span className="badge warning">Scanning</span>
        </div>
        <div className="card">
          <h3>Signals Detected</h3>
          <div className="value">{stats.signals.toLocaleString()}</div>
          <span className="badge success">High Conviction</span>
        </div>
        <div className="card">
          <h3>Auto-Trades Executed</h3>
          <div className="value">{stats.trades.toLocaleString()}</div>
          <span className="badge warning">Paper Mode</span>
        </div>
      </div>

      <div className="grid">
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <h3>Recent System Activity</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0 0' }}>
            <li style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border-color)' }}>
              <span className="badge success" style={{ marginRight: '1rem' }}>CLUSTER</span>
              Funding Group Fx99a detected accumulating TRUMP.
            </li>
            <li style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border-color)' }}>
              <span className="badge danger" style={{ marginRight: '1rem' }}>SAFETY</span>
              Execution aborted for CA XYZ123 (Mint Authority Enabled).
            </li>
            <li style={{ padding: '0.75rem 0' }}>
              <span className="badge warning" style={{ marginRight: '1rem' }}>SIGNAL</span>
              Snipe Pattern detected from Cluster B7x (Confidence: 87%).
            </li>
          </ul>
        </div>
      </div>
    </main>
  );
}
