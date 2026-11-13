import type { Chain } from './types.js';

export const INGESTION_CHAINS: readonly Chain[] = [
  'solana',
  'polygon',
  'robinhood-chain',
  'base',
  'ethereum',
  'bsc'
];

export const INGESTION_HEALTH_POLICY: Record<
  Chain,
  { staleAfterSeconds: number; targetLagSeconds: number }
> = {
  solana: { staleAfterSeconds: 5 * 60, targetLagSeconds: 5 * 60 },
  polygon: { staleAfterSeconds: 10 * 60, targetLagSeconds: 5 * 60 },
  'robinhood-chain': { staleAfterSeconds: 15 * 60, targetLagSeconds: 15 * 60 },
  base: { staleAfterSeconds: 15 * 60, targetLagSeconds: 15 * 60 },
  ethereum: { staleAfterSeconds: 15 * 60, targetLagSeconds: 15 * 60 },
  bsc: { staleAfterSeconds: 15 * 60, targetLagSeconds: 15 * 60 }
};

// Fetch coverage is scoped evidence, never a confirmation certificate. There is
// deliberately no `verified`/`ready` constructor until a trusted policy exists.
export type IngestionEvidence = {
  observed: number;
  quarantined: number; // subset of legacy skipped, not an extra attempted item
  accepted: number; // explicit lifecycle eligibility, not legacy inserted
  completeness: 'unknown' | 'partial' | 'complete';
  scope: 'requested-window' | 'provider-pagination' | 'delivery';
  confirmation: 'unknown' | 'withheld';
};

export type IngestionSourceEvidence = {
  source: string;
  batchAt: Date | string;
  evidence: IngestionEvidence | null;
};

/** Reject malformed/untrusted persisted evidence rather than inferring success. */
export function parseIngestionEvidence(value: unknown): IngestionEvidence | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const counter = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (!counter(v.observed) || !counter(v.quarantined) || !counter(v.accepted)
    || v.quarantined + v.accepted !== v.observed
    || typeof v.completeness !== 'string' || !['unknown', 'partial', 'complete'].includes(v.completeness)
    || typeof v.scope !== 'string' || !['requested-window', 'provider-pagination', 'delivery'].includes(v.scope)
    || typeof v.confirmation !== 'string' || !['unknown', 'withheld'].includes(v.confirmation)) return null;
  return {
    observed: v.observed, quarantined: v.quarantined, accepted: v.accepted,
    completeness: v.completeness as IngestionEvidence['completeness'],
    scope: v.scope as IngestionEvidence['scope'],
    confirmation: v.confirmation as IngestionEvidence['confirmation']
  };
}

export type IngestionHealthStatus = 'healthy' | 'stale' | 'empty' | 'unready';

export type RawIngestionHealth = {
  chain: Chain;
  lastEventAt: Date | string | null;
  lastBatchAt: Date | string | null;
  lastSuccessAt: Date | string | null;
  inserted24h: number | string;
  skipped24h: number | string;
  failed24h: number | string;
  evidenceTotals?: { observed: number; quarantined: number; accepted: number } | null;
  sourceEvidence?: IngestionSourceEvidence[];
};

export type IngestionHealthSnapshot = {
  chain: Chain;
  status: IngestionHealthStatus;
  lastEventAt: string | null;
  lastBatchAt: string | null;
  lastSuccessAt: string | null;
  lagSeconds: number | null;
  batchLagSeconds: number | null;
  staleAfterSeconds: number;
  targetLagSeconds: number;
  inserted24h: number;
  skipped24h: number;
  failed24h: number;
  insertRatio: number | null;
  eventFreshness: 'fresh' | 'stale' | 'empty';
  readiness: 'unknown' | 'blocked';
  completeness: IngestionEvidence['completeness'];
  confirmation: IngestionEvidence['confirmation'];
  observed24h: number | null;
  quarantined24h: number | null;
  accepted24h: number | null;
  sourceEvidence: IngestionSourceEvidence[];
};

function parseDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function secondsSince(value: Date | null, now: Date): number | null {
  if (!value) return null;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 1000));
}

function normalizeCount(value: number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

export function buildIngestionHealthSnapshots(
  rows: RawIngestionHealth[],
  now = new Date()
): IngestionHealthSnapshot[] {
  const byChain = new Map(rows.map((row) => [row.chain, row]));

  return INGESTION_CHAINS.map((chain) => {
    const row = byChain.get(chain);
    const lastEventAt = parseDate(row?.lastEventAt ?? null);
    const lastBatchAt = parseDate(row?.lastBatchAt ?? null);
    const lastSuccessAt = parseDate(row?.lastSuccessAt ?? null);
    const inserted24h = normalizeCount(row?.inserted24h ?? 0);
    const skipped24h = normalizeCount(row?.skipped24h ?? 0);
    const failed24h = normalizeCount(row?.failed24h ?? 0);
    const lagSeconds = secondsSince(lastEventAt, now);
    const policy = INGESTION_HEALTH_POLICY[chain];
    const attempted = inserted24h + skipped24h;
    const eventFreshness = lagSeconds === null ? 'empty'
      : lagSeconds > policy.staleAfterSeconds ? 'stale' : 'fresh';
    const sourceEvidence = (row?.sourceEvidence ?? []).map((item) => ({
      ...item, evidence: parseIngestionEvidence(item.evidence)
    }));
    const known = sourceEvidence.flatMap((item) => item.evidence ? [item.evidence] : []);
    const completeness: IngestionEvidence['completeness'] = known.some((item) => item.completeness === 'partial')
      ? 'partial'
      : sourceEvidence.length > 0 && known.length === sourceEvidence.length
        && known.every((item) => item.completeness === 'complete')
        && sourceEvidence.every((item) => {
          const lag = secondsSince(parseDate(item.batchAt), now);
          return lag !== null && lag <= policy.staleAfterSeconds;
        }) ? 'complete' : 'unknown';
    const confirmation = known.some((item) => item.confirmation === 'withheld') ? 'withheld' : 'unknown';
    const readiness = confirmation === 'withheld' || completeness === 'partial' || failed24h > 0
      || known.some((item) => item.quarantined > 0) ? 'blocked' : 'unknown';
    const totals = row?.evidenceTotals;
    const validTotals = totals && parseIngestionEvidence({ ...totals,
      completeness: 'unknown', scope: 'delivery', confirmation: 'unknown'
    });

    return {
      chain,
      status: eventFreshness === 'fresh' ? 'unready' : eventFreshness,
      eventFreshness,
      readiness,
      completeness,
      confirmation,
      observed24h: validTotals ? validTotals.observed : null,
      quarantined24h: validTotals ? validTotals.quarantined : null,
      accepted24h: validTotals ? validTotals.accepted : null,
      sourceEvidence,
      lastEventAt: lastEventAt?.toISOString() ?? null,
      lastBatchAt: lastBatchAt?.toISOString() ?? null,
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
      lagSeconds,
      batchLagSeconds: secondsSince(lastBatchAt, now),
      staleAfterSeconds: policy.staleAfterSeconds,
      targetLagSeconds: policy.targetLagSeconds,
      inserted24h,
      skipped24h,
      failed24h,
      insertRatio: attempted > 0 ? inserted24h / attempted : null
    };
  });
}
