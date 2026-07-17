-- DENIX phase 1: conservative rollback.
--
-- This migration is fully additive and the current restaurant-1 backend ignores
-- the new columns, indexes and session table. The safest application rollback is
-- therefore to deploy the previous application version and leave these objects in
-- place. This script intentionally performs no DROP, DELETE, TRUNCATE or data update.

BEGIN;

DO $$
BEGIN
  RAISE NOTICE 'No destructive schema rollback is required for phase 1.';
  RAISE NOTICE 'Deploy the previous application version; additive database objects remain compatible.';
END
$$;

COMMIT;

-- Review-only inventory of phase-1 objects that remain after application rollback.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'deliveries' AND column_name IN ('restaurante_id', 'created_at', 'updated_at'))
    OR
    (table_name = 'restaurantes' AND column_name IN (
      'activo',
      'webhook_token',
      'woo_webhook_secret',
      'shipday_webhook_secret',
      'created_at',
      'updated_at'
    ))
    OR table_name = 'user_sessions'
  )
ORDER BY table_name, ordinal_position;
