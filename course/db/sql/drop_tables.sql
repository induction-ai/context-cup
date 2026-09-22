DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename NOT LIKE 'pg_%'
  )
  LOOP
    EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
  END LOOP;
END $$;
