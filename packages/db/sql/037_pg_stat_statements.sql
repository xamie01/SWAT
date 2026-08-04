-- 037_pg_stat_statements.sql
-- Query-level visibility, so a slow query can be found before per-user volume
-- multiplies it.
--
-- The extension needs the library preloaded at server start
-- (`shared_preload_libraries=pg_stat_statements`, set in docker-compose.yml).
-- A database without it — a managed instance that has not enabled the library,
-- or the ephemeral CI Postgres — would otherwise fail this migration and every
-- one after it, so the CREATE is wrapped and downgraded to a notice. Losing
-- observability must not block a schema change.
--
-- Idempotent: CREATE EXTENSION IF NOT EXISTS.

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE
      'pg_stat_statements unavailable (%); set shared_preload_libraries and re-run.',
      SQLERRM;
END $$;
