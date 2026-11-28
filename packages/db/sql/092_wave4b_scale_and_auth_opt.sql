-- 092_wave4b_scale_and_auth_opt.sql
--
-- Wave 4b scale & retention optimization:
--   * Active execution grant lookup index on user_execution_grants (user_id, expires_at)
--   * Retention cleanup index on price_snapshots (snapshot_at)
--   * Bounded batch purge helpers owned by swat_migrator (revoked from runtime/auth roles)
--
-- Leaves all 087-pinned auth tables (users, user_sessions, user_auth_wallets,
-- auth_wallet_proofs, audit_log) and public.swat_auth_* functions untouched.
-- Transactional DDL owned by swat_migrator / migration runner (no BEGIN/COMMIT/CONCURRENTLY).

CREATE INDEX IF NOT EXISTS idx_user_execution_grants_active
  ON public.user_execution_grants (user_id, expires_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_price_snapshots_cleanup
  ON public.price_snapshots (snapshot_at);

-- Bounded batch cleanup for expired/revoked sessions (defaults: 7d grace, 5000 rows/call).
CREATE OR REPLACE FUNCTION public.swat_purge_expired_sessions(max_rows integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  deleted_count integer;
  clamped_rows integer;
BEGIN
  clamped_rows := GREATEST(1, LEAST(COALESCE(max_rows, 5000), 50000));
  WITH doomed AS (
    SELECT id
      FROM public.user_sessions
     WHERE (revoked_at IS NOT NULL AND revoked_at < pg_catalog.now() - interval '7 days')
        OR (expires_at < pg_catalog.now() - interval '7 days')
     ORDER BY expires_at ASC
     LIMIT clamped_rows
  ),
  removed AS (
    DELETE FROM public.user_sessions s
    USING doomed d
    WHERE s.id = d.id
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO deleted_count FROM removed;

  RETURN COALESCE(deleted_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.swat_purge_expired_sessions(integer) FROM PUBLIC, swat_app, swat_auth_service;

-- Bounded batch cleanup for stale mark-to-market price snapshots (defaults: keep 30 days, 5000 rows/call).
CREATE OR REPLACE FUNCTION public.swat_purge_stale_price_snapshots(keep_days integer DEFAULT 30, max_rows integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  deleted_count integer;
  clamped_days integer;
  clamped_rows integer;
BEGIN
  clamped_days := GREATEST(1, COALESCE(keep_days, 30));
  clamped_rows := GREATEST(1, LEAST(COALESCE(max_rows, 5000), 50000));
  WITH doomed AS (
    SELECT ctid
      FROM public.price_snapshots
     WHERE snapshot_at < pg_catalog.now() - pg_catalog.make_interval(days => clamped_days)
     ORDER BY snapshot_at ASC
     LIMIT clamped_rows
  ),
  removed AS (
    DELETE FROM public.price_snapshots p
    USING doomed d
    WHERE p.ctid = d.ctid
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO deleted_count FROM removed;

  RETURN COALESCE(deleted_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.swat_purge_stale_price_snapshots(integer, integer) FROM PUBLIC, swat_app, swat_auth_service;
