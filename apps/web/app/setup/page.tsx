'use client';

import { useState } from 'react';

// Derive the API host from how the page is being viewed, so it works both on
// the dev machine (localhost) and from another device on the LAN (the host's IP).
// NEXT_PUBLIC_API_URL overrides this when set.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : 'http://localhost:3001');
const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? 'swat-dev-key';

export default function SetupPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tokenMint, setTokenMint] = useState('');

  const triggerDiscovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenMint.trim()) return;

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`${API_BASE}/v1/discovery/from-token`, {
        method: 'POST',
        headers: {
          'X-Api-Key': API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ tokenMint: tokenMint.trim() })
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || data.message || 'Failed to trigger discovery');
      }

      const data = await res.json();
      // The API returns `ingested` (from existing data) and `queued` (the deeper
      // on-chain scan has been kicked off in the background).
      setSuccess(
        `Found ${data.ingested || 0} wallets from existing data. ` +
        `Now scanning the chain for this token's early & biggest buyers — they'll be backfilled, scored, and clustered automatically.`
      );
      setTokenMint('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main>
      <h1>Setup & Administration</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        Bootstrap the intelligence layer and trigger batch jobs.
      </p>

      {error && (
        <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'var(--danger)', marginTop: '1rem' }}>
          <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
        </div>
      )}

      {success && (
        <div className="card" style={{ background: 'rgba(16, 185, 129, 0.1)', borderColor: 'var(--success)', marginTop: '1rem' }}>
          <p style={{ color: 'var(--success)', margin: 0 }}>{success}</p>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: '1fr', marginTop: '2rem' }}>
        {/* Scorer status card */}
        <div className="card">
          <h3>Step 2: Run Scorer Batch</h3>
          <p style={{ color: 'var(--text-secondary)', margin: '1rem 0' }}>
            The scorer computes wallet metrics, assigns tiers, and generates clusters from tracked wallets.
            By default it runs at <strong>02:00 UTC</strong> daily.
          </p>
          <div style={{
            padding: '1rem',
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid var(--warning)',
            borderRadius: '8px',
            marginTop: '1rem'
          }}>
            <p style={{ color: 'var(--warning)', margin: 0, fontSize: '0.9rem' }}>
              <strong>Manual Trigger:</strong> Set <code>RUN_ON_STARTUP=true</code> in <code>.env</code> and restart the scorer service.
            </p>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '1rem' }}>
            After the scorer runs, check <a href="/clusters" style={{ color: 'var(--accent)' }}>Clusters</a> to verify clusters were generated.
          </p>
        </div>

        {/* Discovery form */}
        <div className="card">
          <h3>Step 3: Discover Wallets from Token</h3>
          <p style={{ color: 'var(--text-secondary)', margin: '1rem 0' }}>
            Auto-discover profitable wallets that bought a token early (within 10 min of launch, &gt;0.5 SOL invested).
            This expands your seed wallet set.
          </p>
          <form onSubmit={triggerDiscovery}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
              Token Mint Address
            </label>
            <input
              type="text"
              placeholder="TokenMintAddress111111111111111111111111111"
              value={tokenMint}
              onChange={(e) => setTokenMint(e.target.value)}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                fontFamily: 'monospace'
              }}
            />
            <button
              type="submit"
              disabled={loading || !tokenMint.trim()}
              style={{
                marginTop: '1rem',
                padding: '0.75rem 1.5rem',
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: loading || !tokenMint.trim() ? 'not-allowed' : 'pointer',
                opacity: loading || !tokenMint.trim() ? 0.5 : 1
              }}
            >
              {loading ? 'Discovering...' : 'Discover Wallets'}
            </button>
          </form>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '1rem' }}>
            Returns up to 50 early buyers. Run the scorer again after discovery completes.
          </p>
        </div>

        {/* Bootstrap checklist */}
        <div className="card">
          <h3>Bootstrap Checklist</h3>
          <p style={{ color: 'var(--text-secondary)', margin: '1rem 0 1.5rem 0' }}>
            Follow this sequence to get your first signal:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'var(--accent)',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.9rem',
                flexShrink: 0
              }}>
                1
              </div>
              <div>
                <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  Add Seed Wallets
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Go to <a href="/wallets" style={{ color: 'var(--accent)' }}>Wallets</a> and add 5–10 known profitable wallets.
                  Find them on Solscan or whale-tracker Discord.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'var(--warning)',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.9rem',
                flexShrink: 0
              }}>
                2
              </div>
              <div>
                <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  Run Scorer Batch
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Set <code>RUN_ON_STARTUP=true</code> in <code>.env</code> and restart <code>pnpm dev:scorer</code>.
                  This generates clusters.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'var(--success)',
                color: 'white',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.9rem',
                flexShrink: 0
              }}>
                3
              </div>
              <div>
                <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  Expand via Discovery
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  Use the form above to discover wallets from a profitable token.
                  This auto-expands your wallet network.
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                background: 'rgba(255, 255, 255, 0.2)',
                color: 'var(--text-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                fontSize: '0.9rem',
                flexShrink: 0
              }}>
                4
              </div>
              <div>
                <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '1rem', color: 'var(--text-primary)' }}>
                  Wait for Signals
                </h4>
                <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  The signal-engine polls every 15 seconds. When cluster wallets trade together, signals appear on the <a href="/signals" style={{ color: 'var(--accent)' }}>Signals</a> page.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
