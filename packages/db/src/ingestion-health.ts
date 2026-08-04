import { randomUUID } from 'node:crypto';
import {
  INGESTION_CHAINS,
  type Chain,
  type RawIngestionHealth
} from '@swat/shared';
import { query } from './client.js';
import { withTransaction } from './transaction.js';

export type RecordIngestionBatchInput = {
  chain: Chain;
  source: string;
  batchAt?: Date;
  lastEventAt?: Date | null;
  inserted?: number;
  skipped?: number;
  failed?: number;
  errorMessage?: string | null;
};

export type IngestionAlertTarget = 'healthy' | 'stale';

function normalizeCounter(value: number | undefined, field: string): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return normalized;
}

export async function recordIngestionBatch(input: RecordIngestionBatchInput) {
  if (!INGESTION_CHAINS.includes(input.chain)) {
    throw new Error(`Unsupported ingestion chain: ${input.chain}`);
  }
  if (!input.source || input.source.length > 100) {
    throw new Error('Ingestion source must contain 1-100 characters');
  }

  const inserted = normalizeCounter(input.inserted, 'inserted');
  const skipped = normalizeCounter(input.skipped, 'skipped');
  const failed = normalizeCounter(input.failed, 'failed');
  const batchAt = input.batchAt ?? new Date();
  const lastEventAt = input.lastEventAt ?? null;
  const errorMessage = input.errorMessage?.slice(0, 2000) ?? null;

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO ingestion_health_batches (
         chain, source, batch_at, last_event_at,
         inserted_count, skipped_count, failed_count, error_message
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.chain,
        input.source,
        batchAt,
        lastEventAt,
        inserted,
        skipped,
        failed,
        errorMessage
      ]
    );
    await client.query(
      `INSERT INTO ingestion_health (
         chain, last_event_at, last_batch_at, last_success_at,
         inserted_total, skipped_total, failed_total, updated_at
       )
       VALUES (
         $1,
         $2::timestamptz,
         $3::timestamptz,
         CASE WHEN $6::int = 0 THEN $3::timestamptz ELSE NULL::timestamptz END,
         $4, $5, $6, NOW()
       )
       ON CONFLICT (chain) DO UPDATE SET
         last_event_at = CASE
           WHEN EXCLUDED.last_event_at IS NULL THEN ingestion_health.last_event_at
           WHEN ingestion_health.last_event_at IS NULL THEN EXCLUDED.last_event_at
           ELSE GREATEST(ingestion_health.last_event_at, EXCLUDED.last_event_at)
         END,
         last_batch_at = GREATEST(
           COALESCE(ingestion_health.last_batch_at, EXCLUDED.last_batch_at),
           EXCLUDED.last_batch_at
         ),
         last_success_at = CASE
           WHEN $6::int > 0 THEN ingestion_health.last_success_at
           WHEN ingestion_health.last_success_at IS NULL THEN EXCLUDED.last_batch_at
           ELSE GREATEST(ingestion_health.last_success_at, EXCLUDED.last_batch_at)
         END,
         inserted_total = ingestion_health.inserted_total + EXCLUDED.inserted_total,
         skipped_total = ingestion_health.skipped_total + EXCLUDED.skipped_total,
         failed_total = ingestion_health.failed_total + EXCLUDED.failed_total,
         updated_at = NOW()`,
      [
        input.chain,
        lastEventAt,
        batchAt,
        inserted,
        skipped,
        failed
      ]
    );
  });
}

export async function getIngestionHealth24h(): Promise<RawIngestionHealth[]> {
  const rows = await query<{
    chain: Chain;
    last_event_at: Date | null;
    last_batch_at: Date | null;
    last_success_at: Date | null;
    inserted_24h: string;
    skipped_24h: string;
    failed_24h: string;
  }>(`
    SELECT
      h.chain,
      h.last_event_at,
      h.last_batch_at,
      h.last_success_at,
      COALESCE(SUM(b.inserted_count), 0)::text AS inserted_24h,
      COALESCE(SUM(b.skipped_count), 0)::text AS skipped_24h,
      COALESCE(SUM(b.failed_count), 0)::text AS failed_24h
    FROM ingestion_health h
    LEFT JOIN ingestion_health_batches b
      ON b.chain = h.chain
     AND b.batch_at >= NOW() - INTERVAL '24 hours'
    GROUP BY h.chain, h.last_event_at, h.last_batch_at, h.last_success_at
    ORDER BY CASE h.chain
      WHEN 'solana' THEN 1
      WHEN 'polygon' THEN 2
      ELSE 3
    END
  `);

  return rows.map((row) => ({
    chain: row.chain,
    lastEventAt: row.last_event_at,
    lastBatchAt: row.last_batch_at,
    lastSuccessAt: row.last_success_at,
    inserted24h: row.inserted_24h,
    skipped24h: row.skipped_24h,
    failed24h: row.failed_24h
  }));
}

export async function reserveIngestionHealthAlert(
  chain: Chain,
  target: IngestionAlertTarget
): Promise<string | null> {
  const reservation = randomUUID();

  if (target === 'healthy') {
    const recovered = await query<{ alert_reservation: string }>(
      `UPDATE ingestion_health
          SET alert_reservation = $2,
              alert_reserved_status = 'healthy',
              alert_reserved_at = NOW(),
              updated_at = NOW()
        WHERE chain = $1
          AND alert_status = 'stale'
          AND (
            alert_reservation IS NULL
            OR alert_reserved_at < NOW() - INTERVAL '5 minutes'
          )
        RETURNING alert_reservation`,
      [chain, reservation]
    );
    if (recovered[0]) return recovered[0].alert_reservation;

    await query(
      `UPDATE ingestion_health
          SET alert_status = 'healthy', updated_at = NOW()
        WHERE chain = $1
          AND alert_status = 'unknown'
          AND alert_reservation IS NULL`,
      [chain]
    );
    return null;
  }

  const alerted = await query<{ alert_reservation: string }>(
    `UPDATE ingestion_health
        SET alert_reservation = $2,
            alert_reserved_status = 'stale',
            alert_reserved_at = NOW(),
            updated_at = NOW()
      WHERE chain = $1
        AND alert_status <> 'stale'
        AND (
          alert_reservation IS NULL
          OR alert_reserved_at < NOW() - INTERVAL '5 minutes'
        )
      RETURNING alert_reservation`,
    [chain, reservation]
  );
  return alerted[0]?.alert_reservation ?? null;
}

export async function completeIngestionHealthAlert(
  chain: Chain,
  reservation: string,
  target: IngestionAlertTarget
): Promise<boolean> {
  const rows = await query(
    `UPDATE ingestion_health
        SET alert_status = $3,
            alert_reservation = NULL,
            alert_reserved_status = NULL,
            alert_reserved_at = NULL,
            alerted_at = CASE WHEN $3 = 'stale' THEN NOW() ELSE alerted_at END,
            recovered_at = CASE WHEN $3 = 'healthy' THEN NOW() ELSE recovered_at END,
            updated_at = NOW()
      WHERE chain = $1
        AND alert_reservation = $2
        AND alert_reserved_status = $3
      RETURNING chain`,
    [chain, reservation, target]
  );
  return rows.length > 0;
}

export async function releaseIngestionHealthAlert(
  chain: Chain,
  reservation: string
): Promise<void> {
  await query(
    `UPDATE ingestion_health
        SET alert_reservation = NULL,
            alert_reserved_status = NULL,
            alert_reserved_at = NULL,
            updated_at = NOW()
      WHERE chain = $1
        AND alert_reservation = $2`,
    [chain, reservation]
  );
}
