'use client';

import { useState, useEffect } from 'react';

// Derive the API host from how the page is being viewed, so it works both on
// the dev machine (localhost) and from another device on the LAN (the host's IP).
// NEXT_PUBLIC_API_URL overrides this when set.
const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3001`
    : 'http://localhost:3001');
const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? 'swat-dev-key';

export default function ClustersPage() {
  const [clusters, setClusters] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  const [clusterMembers, setClusterMembers] = useState<Record<string, any[]>>({});

  const fetchClusters = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE}/v1/clusters`, {
        headers: { 'X-Api-Key': API_KEY }
      });
      if (!res.ok) throw new Error('Failed to fetch clusters');
      const data = await res.json();
      setClusters(data.items || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchClusterMembers = async (clusterId: string) => {
    if (clusterMembers[clusterId]) {
      setExpandedCluster(expandedCluster === clusterId ? null : clusterId);
      return;
    }

    try {
      // The API exposes members under GET /v1/clusters/:id (returns { cluster, members }).
      const res = await fetch(`${API_BASE}/v1/clusters/${clusterId}`, {
        headers: { 'X-Api-Key': API_KEY }
      });
      if (!res.ok) throw new Error('Failed to fetch members');
      const data = await res.json();
      setClusterMembers(prev => ({ ...prev, [clusterId]: data.members || [] }));
      setExpandedCluster(clusterId);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    fetchClusters();
  }, []);

  return (
    <main>
      <h1>Wallet Clusters</h1>
      <p style={{ color: 'var(--text-secondary)' }}>
        Clusters are groups of wallets with coordinated behavior patterns. Click to view members.
      </p>

      {error && (
        <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'var(--danger)', marginTop: '1rem' }}>
          <p style={{ color: 'var(--danger)', margin: 0 }}>{error}</p>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.5rem', marginBottom: '1rem' }}>
        <button
          onClick={fetchClusters}
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

      {clusters.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem' }}>
          <p style={{ color: 'var(--text-secondary)' }}>
            No clusters found. Run the scorer batch to generate clusters from tracked wallets.
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '1rem' }}>
            Go to <a href="/setup" style={{ color: 'var(--accent)' }}>Setup</a> to trigger the scorer.
          </p>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
          {clusters.map((cluster: any) => (
            <div key={cluster.id} className="card" style={{ cursor: 'pointer' }}>
              <div
                onClick={() => fetchClusterMembers(cluster.id)}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
              >
                <div style={{ flex: 1 }}>
                  <h3 style={{ margin: '0 0 0.5rem 0', color: 'var(--text-primary)', textTransform: 'none' }}>
                    Cluster {cluster.id.slice(0, 8)}
                  </h3>
                  <div style={{ marginTop: '0.75rem' }}>
                    <span className={`badge ${
                      cluster.cluster_type === 'funding' ? 'success' :
                      cluster.cluster_type === 'behavioral' ? 'warning' : ''
                    }`} style={{ marginRight: '0.5rem' }}>
                      {cluster.cluster_type}
                    </span>
                    <span className="badge" style={{ background: 'rgba(255, 255, 255, 0.05)', marginRight: '0.5rem' }}>
                      {cluster.wallet_count || 0} members
                    </span>
                    {cluster.confidence != null && (
                      <span className="badge" style={{ background: 'rgba(255, 255, 255, 0.05)' }}>
                        Confidence: {(cluster.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>
                  {cluster.total_realized_roi != null && (
                    <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                      Avg ROI: {(cluster.total_realized_roi * 100).toFixed(1)}%
                    </div>
                  )}
                </div>
                <div>
                  <span style={{ fontSize: '1.2rem' }}>
                    {expandedCluster === cluster.id ? '▼' : '▶'}
                  </span>
                </div>
              </div>

              {/* Expanded members */}
              {expandedCluster === cluster.id && clusterMembers[cluster.id] && (
                <div style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)' }}>
                  <h4 style={{ margin: '0 0 1rem 0', color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                    CLUSTER MEMBERS
                  </h4>
                  {clusterMembers[cluster.id].length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>No members found</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {clusterMembers[cluster.id].map((member: any, idx: number) => (
                        <div
                          key={idx}
                          style={{
                            padding: '0.75rem',
                            background: 'rgba(0, 0, 0, 0.2)',
                            borderRadius: '6px',
                            border: '1px solid var(--border-color)'
                          }}
                        >
                          <code style={{ fontSize: '0.85rem', color: 'var(--accent)' }}>
                            {member.address}
                          </code>
                          {member.tier && (
                            <span className={`badge ${
                              member.tier === 'elite' ? 'success' :
                              member.tier === 'pro' ? 'warning' : ''
                            }`} style={{ marginLeft: '0.75rem', fontSize: '0.7rem' }}>
                              {member.tier}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
