/**
 * Cluster pattern detectors (checklist S4-M26).
 *
 * Extracted from index.ts so detector queries, scoring math, and signal
 * payloads can be unit tested without starting intervals or establishing
 * Redis connections at module import time.
 *
 * All four cluster detectors emit signals with `suppressTrade: true`
 * (discovery and alerting only — ADR-0005 §6.1). Copy trades derive strictly
 * from `source_trade` events.
 */
export interface SnipeRow {
    token_mint: string;
    cluster_id: string;
    buyer_count: number;
    cluster_confidence: number;
    cluster_roi: number;
}
export interface AccumulationRow {
    token_mint: string;
    cluster_id: string;
    buy_volume: number;
    buy_sessions: number;
    cluster_confidence: number;
}
export interface RotationRow {
    token_out: string;
    token_in: string;
    cluster_id: string;
    actor_count: number;
    cluster_confidence: number;
}
export interface ExitRow {
    token_mint: string;
    cluster_id: string;
    seller_count: number;
    cluster_size: number;
    exit_volume: number;
    cluster_confidence: number;
}
export interface SignalEnqueuePayload {
    patternType: string;
    clusterId: string | null;
    tokenMint: string;
    confidence: number;
    signalScore: number;
    triggerData: Record<string, unknown>;
    dedupeMinutes?: number;
    suppressTrade?: boolean;
}
export type DetectorQueryFn = (sql: string, params?: unknown[]) => Promise<any[]>;
export type DetectorEnqueueFn = (opts: SignalEnqueuePayload) => Promise<void>;
export declare const SNIPE_DETECTOR_QUERY = "\n  SELECT\n    t.target_token              AS token_mint,\n    cm.cluster_id,\n    COUNT(DISTINCT t.wallet_address)::int AS buyer_count,\n    wc.confidence               AS cluster_confidence,\n    COALESCE(wc.total_realized_roi, 0) AS cluster_roi\n  FROM transactions t\n  JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address\n  JOIN wallet_clusters wc ON cm.cluster_id = wc.id\n  WHERE t.direction = 'buy'\n    AND t.timestamp > NOW() - INTERVAL '5 minutes'\n    AND t.target_token IS NOT NULL\n  GROUP BY t.target_token, cm.cluster_id, wc.confidence, wc.total_realized_roi\n  HAVING COUNT(DISTINCT t.wallet_address) >= 3\n";
export declare const ACCUMULATION_DETECTOR_QUERY = "\n  SELECT\n    t.target_token              AS token_mint,\n    cm.cluster_id,\n    SUM(t.amount_in_usd)        AS buy_volume,\n    COUNT(DISTINCT DATE(t.timestamp)) AS buy_sessions,\n    wc.confidence               AS cluster_confidence\n  FROM transactions t\n  JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address\n  JOIN wallet_clusters wc ON cm.cluster_id = wc.id\n  WHERE t.direction = 'buy'\n    AND t.timestamp > NOW() - INTERVAL '7 days'\n    AND t.amount_in_usd IS NOT NULL\n    AND t.target_token IS NOT NULL\n  GROUP BY t.target_token, cm.cluster_id, wc.confidence\n  HAVING COUNT(DISTINCT DATE(t.timestamp)) >= 3\n     AND SUM(t.amount_in_usd) > 50000\n";
export declare const ROTATION_DETECTOR_QUERY = "\n  WITH sells AS (\n    SELECT t.target_token AS sold_token, cm.cluster_id, t.wallet_address, t.timestamp\n    FROM transactions t\n    JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address\n    WHERE t.direction = 'sell'\n      AND t.timestamp > NOW() - INTERVAL '1 hour'\n  ),\n  buys AS (\n    SELECT t.target_token AS bought_token, cm.cluster_id, t.wallet_address, t.timestamp\n    FROM transactions t\n    JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address\n    WHERE t.direction = 'buy'\n      AND t.timestamp > NOW() - INTERVAL '1 hour'\n  )\n  SELECT\n    s.sold_token     AS token_out,\n    b.bought_token   AS token_in,\n    s.cluster_id,\n    COUNT(DISTINCT s.wallet_address) AS actor_count,\n    wc.confidence    AS cluster_confidence\n  FROM sells s\n  JOIN buys b ON s.cluster_id = b.cluster_id\n    AND s.wallet_address = b.wallet_address\n    AND b.timestamp > s.timestamp\n    AND b.bought_token != s.sold_token\n  JOIN wallet_clusters wc ON s.cluster_id = wc.id\n  GROUP BY s.sold_token, b.bought_token, s.cluster_id, wc.confidence\n  HAVING COUNT(DISTINCT s.wallet_address) >= 2\n";
export declare const EXIT_DETECTOR_QUERY = "\n  WITH cluster_sizes AS (\n    SELECT cluster_id, COUNT(*) AS member_count\n    FROM cluster_memberships\n    GROUP BY cluster_id\n  ),\n  recent_sells AS (\n    SELECT\n      t.target_token,\n      cm.cluster_id,\n      COUNT(DISTINCT t.wallet_address) AS seller_count,\n      SUM(t.amount_out_usd)            AS exit_volume\n    FROM transactions t\n    JOIN cluster_memberships cm ON t.wallet_address = cm.wallet_address\n    WHERE t.direction = 'sell'\n      AND t.timestamp > NOW() - INTERVAL '1 hour'\n      AND t.amount_out_usd IS NOT NULL\n    GROUP BY t.target_token, cm.cluster_id\n  )\n  SELECT\n    rs.target_token         AS token_mint,\n    rs.cluster_id,\n    rs.seller_count,\n    cs.member_count         AS cluster_size,\n    rs.exit_volume,\n    wc.confidence           AS cluster_confidence\n  FROM recent_sells rs\n  JOIN cluster_sizes cs ON rs.cluster_id = cs.cluster_id\n  JOIN wallet_clusters wc ON rs.cluster_id = wc.id\n  WHERE rs.seller_count::float / cs.member_count >= 0.5\n    AND rs.exit_volume > 10000\n";
export declare function scoreSnipePattern(row: Pick<SnipeRow, 'cluster_confidence' | 'cluster_roi'>): number;
export declare function scoreAccumulationPattern(row: Pick<AccumulationRow, 'cluster_confidence'>): number;
export declare function scoreRotationPattern(row: Pick<RotationRow, 'cluster_confidence' | 'actor_count'>): number;
export declare function scoreExitPattern(row: Pick<ExitRow, 'cluster_confidence' | 'seller_count' | 'cluster_size'>): {
    signalScore: number;
    sellerPct: number;
};
export declare function runSnipeDetector(queryFn: DetectorQueryFn, enqueueFn: DetectorEnqueueFn): Promise<number>;
export declare function runAccumulationDetector(queryFn: DetectorQueryFn, enqueueFn: DetectorEnqueueFn): Promise<number>;
export declare function runRotationDetector(queryFn: DetectorQueryFn, enqueueFn: DetectorEnqueueFn): Promise<number>;
export declare function runExitDetector(queryFn: DetectorQueryFn, enqueueFn: DetectorEnqueueFn): Promise<number>;
//# sourceMappingURL=detectors.d.ts.map