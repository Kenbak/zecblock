-- Trusted fixed operator metadata writer. No blockchain-row mutation.
BEGIN;
SET LOCAL statement_timeout='3s'; SET LOCAL lock_timeout='200ms'; SET LOCAL search_path=pg_catalog;
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM analytics_feed_meta.signal WHERE singleton AND system_identifier=(SELECT system_identifier::text FROM pg_control_system()) AND timeline=(SELECT timeline_id FROM pg_control_checkpoint())) OR NOT EXISTS(SELECT FROM pg_replication_slots WHERE slot_name='ask_public_core_v1' AND slot_type='logical' AND wal_status='reserved') THEN RAISE EXCEPTION 'Source identity or slot continuity failed'; END IF;
END$$;
UPDATE analytics_feed_meta.signal s SET sampled_at=statement_timestamp(),tip_height=b.height,tip_hash=b.hash,before_lsn=pg_current_wal_lsn() FROM (SELECT height,hash FROM public.blocks ORDER BY height DESC LIMIT 1) b WHERE s.singleton;
COMMIT;
