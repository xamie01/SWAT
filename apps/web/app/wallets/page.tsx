'use client';

import { useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const API_KEY = 'swat-dev-key';

export default function WalletsPage() {
  const [wallets, setWallets] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form states
  const [singleAddress, setSingleAddress] = useState('');
  const [bulkAddresses, setBulkAddresses] = useState('');

  const fetchWallets = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/v1/wallets`, {
        headers: { 'X-Api-Key': API_KEY }
      });
      if (!res.ok) throw new Error('Failed to fetch wallets');
      const data = await res.json();
      setWallets(data.items || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const addSingleWallet = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!singleAddress.trim()) return;

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`${API_BASE}/v1/wallets`, {
        method: 'POST',
        headers: {
          'X-Api-Key': API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          wallets: [{ address: singleAddress.trim(), source: 'manual' }]
        })
      });

      if (!res.ok) throw new Error('Failed to add wallet');

      setSuccess('Wallet added! Indexer is backfilling transaction history...');
      setSingleAddress('');
      setTimeout(() => fetchWallets(), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const addBulkWallets = async (e: React.FormEvent) => {
    e.preventDefault();
    const addresses = bulkAddresses
      .split('\n')
      .map(a => a.trim())
      .filter(a => a.length > 0);

    if (addresses.length === 0) return;

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`${API_BASE}/v1/wallets`, {
        method: 'POST',
        headers: {
          'X-Api-Key': API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          wallets: addresses.map(address => ({ address, source: 'manual' }))
        })
      });

      if (!res.ok) throw new Error('Failed to add wallets');

      setSuccess(`Added ${addresses.length} wallets! Indexer is backfilling...`);
      setBulkAddresses('');
      setTimeout(() => fetchWallets(), 2000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Load wallets on mount
  useState(() => {
    fetchWallets();
  });

  return (
    <main>
      <h1>Wallet Management</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        Add seed wallets to bootstrap the intelligence layer. The indexer will backfill their transaction history.
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

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: '2rem' }}>
        {/* Single wallet form */}
        <div className="card">
          <h3>Add Single Wallet</h3>
          <form onSubmit={addSingleWallet}>
            <input
              type="text"
              placeholder="Solana wallet address"
              value={singleAddress}
              onChange={(e) => setSingleAddress(e.target.value)}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                marginTop: '1rem'
              }}
            />
            <button
              type="submit"
              disabled={loading || !singleAddress.trim()}
              style={{
                marginTop: '1rem',
                padding: '0.75rem 1.5rem',
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: loading ? 'wait' : 'pointer',
                opacity: loading || !singleAddress.trim() ? 0.5 : 1
              }}
            >
              {loading ? 'Adding...' : 'Add Wallet'}
            </button>
          </form>
        </div>

        {/* Bulk wallet form */}
        <div className="card">
          <h3>Add Multiple Wallets</h3>
          <form onSubmit={addBulkWallets}>
            <textarea
              placeholder="Paste wallet addresses (one per line)"
              value={bulkAddresses}
              onChange={(e) => setBulkAddresses(e.target.value)}
              rows={5}
              style={{
                width: '100%',
                padding: '0.75rem',
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-color)',
                borderRadius: '8px',
                color: 'var(--text-primary)',
                fontSize: '0.9rem',
                marginTop: '1rem',
                resize: 'vertical',
                fontFamily: 'monospace'
              }}
            />
            <button
              type="submit"
              disabled={loading || !bulkAddresses.trim()}
              style={{
                marginTop: '1rem',
                padding: '0.75rem 1.5rem',
                background: 'var(--accent)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: loading ? 'wait' : 'pointer',
                opacity: loading || !bulkAddresses.trim() ? 0.5 : 1
              }}
            >
              {loading ? 'Adding...' : 'Add All'}
            </button>
          </form>
        </div>
      </div>

      {/* Wallet list */}
      <div style={{ marginTop: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2>Tracked Wallets ({wallets.length})</h2>
          <button
            onClick={fetchWallets}
            disabled={loading}
            style={{
              padding: '0.5rem 1rem',
              background: 'rgba(59, 130, 246, 0.1)',
              color: 'var(--accent)',
              border: '1px solid var(--accent)',
              borderRadius: '6px',
              cursor: loading ? 'wait' : 'pointer',
              fontWeight: 500
            }}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {wallets.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
            <p style={{ color: 'var(--text-secondary)' }}>
              No wallets yet. Add your first seed wallet above to get started.
            </p>
          </div>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
            {wallets.map((wallet: any) => (
              <div key={wallet.address} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <code style={{ fontSize: '0.9rem', color: 'var(--accent)' }}>
                      {wallet.address}
                    </code>
                    <div style={{ marginTop: '0.75rem' }}>
                      <span className={`badge ${
                        wallet.tier === 'elite' ? 'success' :
                        wallet.tier === 'pro' ? 'warning' : ''
                      }`} style={{ marginRight: '0.5rem' }}>
                        {wallet.tier || 'unscored'}
                      </span>
                      {wallet.wallet_score != null && (
                        <span className="badge" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
                          Score: {wallet.wallet_score}
                        </span>
                      )}
                    </div>
                    <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      {wallet.win_rate != null && `Win Rate: ${(wallet.win_rate * 100).toFixed(1)}% · `}
                      {wallet.total_roi != null && `ROI: ${(wallet.total_roi * 100).toFixed(0)}%`}
                      {wallet.last_active && ` · Last active: ${new Date(wallet.last_active).toLocaleDateString()}`}
                    </div>
                  </div>
                  <div>
                    <span className={`badge ${wallet.status === 'active' ? 'success' : 'warning'}`}>
                      {wallet.status}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
