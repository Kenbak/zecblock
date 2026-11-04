SELECT set_config('ask_feed.system_identifier', :'source_system_identifier',false);
SELECT set_config('ask_feed.timeline', :'source_timeline',false);
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='10s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery() OR (SELECT system_identifier::text FROM pg_control_system())<>current_setting('ask_feed.system_identifier') OR (SELECT timeline_id FROM pg_control_checkpoint())<>current_setting('ask_feed.timeline')::integer THEN RAISE EXCEPTION 'Pinned primary required'; END IF;
 IF EXISTS(SELECT FROM pg_namespace WHERE nspname='analytics_feed_meta') THEN RAISE EXCEPTION 'Signal schema already exists'; END IF;
END$$;
CREATE SCHEMA analytics_feed_meta AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA analytics_feed_meta FROM PUBLIC;
CREATE TABLE analytics_feed_meta.signal(singleton boolean PRIMARY KEY CHECK(singleton),generation uuid NOT NULL,system_identifier text NOT NULL,timeline integer NOT NULL,sampled_at timestamptz NOT NULL,tip_height bigint NOT NULL,tip_hash text NOT NULL,before_lsn pg_lsn NOT NULL);
INSERT INTO analytics_feed_meta.signal SELECT true,:'source_id'::uuid,current_setting('ask_feed.system_identifier'),current_setting('ask_feed.timeline')::integer,'epoch',height,hash,pg_current_wal_lsn() FROM public.blocks ORDER BY height DESC LIMIT 1;
REVOKE ALL ON analytics_feed_meta.signal FROM PUBLIC;
GRANT USAGE ON SCHEMA analytics_feed_meta TO ask_core_replicator;
GRANT SELECT ON analytics_feed_meta.signal TO ask_core_replicator;
ALTER PUBLICATION ask_public_core_v1 ADD TABLE analytics_feed_meta.signal;
COMMIT;
