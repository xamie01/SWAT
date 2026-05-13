const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const API_KEY = process.env.API_KEY ?? 'swat-dev-key';

async function apiFetch(path: string) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      cache: 'no-store',
      headers: { 'x-api-key': API_KEY }
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const stats = await apiFetch('/v1/stats') ?? {
    wallets: 0, active: 0, elite: 0, pro: 0,
    signals: 0, signalsToday: 0, clusters: 0
  };

  const signalsData = await apiFetch('/v1/signals?limit=5') ?? { items: [] };
  const recentSignals = signalsData.items ?? [];

  return (
    <main>
      <h1>Intelligence Dashboard</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        Live metrics for the SWAT intelligence layer.
      </p>

      {/* Stat cards */}
      <div className="grid">
        <div className="card">
          <h3>Tracked Wallets</h3>
          <div className="value">{Number(stats.wallets).toLocaleString()}</div>
          <span className="badge success">{Number(stats.active).toLocaleString()} active</span>
        </div>
        <div className="card">
          <h3>Elite / Pro</h3>
          <div className="value">{Number(stats.elite) + Number(stats.pro)}</div>
          <span className="badge warning">{stats.elite} elite · {stats.pro} pro</span>
        </div>
        <div className="card">
          <h3>Active Clusters</h3>
          <div className="value">{Number(stats.clusters).toLocaleString()}</div>
          <span className="badge success">Scanning</span>
        </div>
        <div className="card">
          <h3>Signals (Today)</h3>
          <div className="value">{Number(stats.signalsToday).toLocaleString()}</div>
          <span className="badge success">{Number(stats.signals).toLocaleString()} total</span>
        </div>
      </div>

      {/* Recent signals */}
      <div className="grid" style={{ gridTemplateColumns: '1fr', marginTop: '1.5rem' }}>
        <div className="card">
          <h3>Recent Signals</h3>
          {recentSignals.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', marginTop: '1rem' }}>
              No signals yet. The engine is monitoring.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: '1rem 0 0 0' }}>
              {(recentSignals as any[]).map((signal) => (
                <li key={signal.id} style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border-color)' }}>
                  <span
                    className={`badge ${signal.pattern_type === 'exit' ? 'danger' : signal.signal_score >= 90 ? 'success' : 'warning'}`}
                    style={{ marginRight: '0.75rem', textTransform: 'uppercase' }}
                  >
                    {signal.pattern_type}
                  </span>
                  <code style={{ fontSize: '0.8rem', color: 'var(--accent)' }}>
                    {signal.token_mint?.slice(0, 8)}...
                  </code>
                  <span style={{ float: 'right', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                    Score: {signal.signal_score} · {new Date(signal.created_at).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </main>
  );
}
