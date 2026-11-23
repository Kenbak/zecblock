-- networks: mainnet, testnet
-- Durable identity for recorded migrations. `migrations.js apply` and
-- `migrations.js record` store the recorded file's name and the SHA-256 of its
-- bytes; `check` fails when a file's number is recorded for another name or
-- content, so a reused number can no longer be skipped silently (026, 2026-11-23).
-- Rows recorded before this file keep NULL identity and are trusted by number
-- only (versions below 047). Additive and safe to re-run.
-- If the API user cannot alter schema_migrations, run this file with
-- `sudo -u postgres psql -v ON_ERROR_STOP=1 -f`, then
-- `migrations.js record --network <name> --version 47`.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE public.schema_migrations
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS file_sha256 text;
COMMENT ON COLUMN public.schema_migrations.file_name IS
  'Base name of the recorded migration file; NULL for rows recorded before 047';
COMMENT ON COLUMN public.schema_migrations.file_sha256 IS
  'Lowercase hex SHA-256 of the recorded file bytes; NULL for rows recorded before 047';
COMMIT;
