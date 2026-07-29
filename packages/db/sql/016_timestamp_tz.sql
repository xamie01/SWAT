-- Standardize UTC timestamp storage without shifting columns already converted.

DO $$
DECLARE
  target RECORD;
  current_type TEXT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('wallets', 'first_seen'),
      ('wallets', 'last_active'),
      ('wallets', 'created_at'),
      ('wallets', 'updated_at'),
      ('tokens', 'first_seen'),
      ('tokens', 'launch_timestamp'),
      ('tokens', 'created_at'),
      ('transactions', 'timestamp'),
      ('transactions', 'created_at'),
      ('wallet_clusters', 'first_seen'),
      ('wallet_clusters', 'last_active'),
      ('wallet_clusters', 'created_at'),
      ('wallet_clusters', 'updated_at'),
      ('cluster_memberships', 'joined_at'),
      ('wallet_relationships', 'created_at'),
      ('wallet_relationships', 'updated_at'),
      ('signals', 'executed_at'),
      ('signals', 'created_at'),
      ('signals', 'expires_at'),
      ('signals', 'alerted_at'),
      ('trades', 'executed_at'),
      ('trades', 'confirmed_at'),
      ('config', 'updated_at'),
      ('discovery_log', 'ran_at'),
      ('polymarket_markets', 'end_date'),
      ('polymarket_markets', 'created_at'),
      ('polymarket_markets', 'updated_at')
    ) AS expected(relation_name, column_name)
  LOOP
    SELECT data_type
      INTO current_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = target.relation_name
       AND column_name = target.column_name;

    IF current_type IS NULL THEN
      RAISE EXCEPTION 'Expected timestamp column %.% is missing',
        target.relation_name, target.column_name;
    ELSIF current_type = 'timestamp without time zone' THEN
      EXECUTE format(
        'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
        target.relation_name,
        target.column_name,
        target.column_name
      );
    ELSIF current_type != 'timestamp with time zone' THEN
      RAISE EXCEPTION 'Expected timestamp column %.% has unsupported type %',
        target.relation_name, target.column_name, current_type;
    END IF;
  END LOOP;
END $$;
