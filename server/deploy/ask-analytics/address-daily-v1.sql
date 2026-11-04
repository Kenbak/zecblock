\set ON_ERROR_STOP on
-- Additive dedicated-store migration: maintained transparent address activity per
-- completed UTC day. Requires catalogue-destination-v1.sql. Reader grants change
-- only by adding address_daily_query. Rollback: address-daily-v1-rollback.sql.
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';SET LOCAL timezone='UTC';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR to_regclass('analytics_meta.dataset_state') IS NULL OR to_regclass('public.address_transactions') IS NULL
 OR to_regclass('analytics_meta.address_daily') IS NOT NULL OR EXISTS(SELECT FROM analytics_meta.dataset_state WHERE dataset='address_daily')
 THEN RAISE EXCEPTION 'Existing extended catalogue without address_daily required';END IF;
END$$;
SET LOCAL ROLE analytics_owner;
-- Counts are exact integers for one completed UTC date. Addresses are
-- transparent address strings, never people. incidences is one address/transaction
-- row of address_activity, including coinbase; input/output flags are not disjoint.
CREATE TABLE analytics_meta.address_daily(date date PRIMARY KEY,active_addresses bigint NOT NULL,sending_addresses bigint NOT NULL,receiving_addresses bigint NOT NULL,new_addresses bigint NOT NULL,incidences bigint NOT NULL,input_incidences bigint NOT NULL,output_incidences bigint NOT NULL);
-- Separate from summary_dirty_days: the address backfill cannot hide activity_daily/flow_daily.
CREATE TABLE analytics_meta.address_daily_dirty_days(date date PRIMARY KEY,revision bigint NOT NULL DEFAULT 0);
INSERT INTO analytics_meta.address_daily_dirty_days(date) SELECT DISTINCT (to_timestamp(timestamp) AT TIME ZONE 'UTC')::date FROM public.blocks WHERE timestamp IS NOT NULL;
INSERT INTO analytics_meta.dataset_state(dataset) VALUES('address_daily');
CREATE FUNCTION analytics_meta.track_address_day() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$DECLARE epoch bigint;prior bigint;BEGIN
 IF TG_OP='TRUNCATE' THEN UPDATE analytics_meta.dataset_state SET ready=false,verified_at=NULL WHERE dataset='address_daily';INSERT INTO analytics_meta.address_daily_dirty_days(date) SELECT date FROM (SELECT (pg_catalog.to_timestamp(timestamp) AT TIME ZONE 'UTC')::date AS date FROM public.blocks WHERE timestamp IS NOT NULL UNION SELECT date FROM analytics_meta.address_daily) affected ON CONFLICT(date) DO UPDATE SET revision=analytics_meta.address_daily_dirty_days.revision+1;RETURN NULL;END IF;
 IF TG_TABLE_NAME='blocks' THEN IF TG_OP<>'DELETE' THEN epoch:=NEW.timestamp;END IF;IF TG_OP<>'INSERT' THEN prior:=OLD.timestamp;END IF;
 ELSE IF TG_OP<>'DELETE' THEN epoch:=NEW.block_time;END IF;IF TG_OP<>'INSERT' THEN prior:=OLD.block_time;END IF;END IF;
 IF epoch IS NOT NULL THEN INSERT INTO analytics_meta.address_daily_dirty_days(date) VALUES((pg_catalog.to_timestamp(epoch) AT TIME ZONE 'UTC')::date) ON CONFLICT(date) DO UPDATE SET revision=analytics_meta.address_daily_dirty_days.revision+1;END IF;
 IF prior IS NOT NULL AND prior IS DISTINCT FROM epoch THEN INSERT INTO analytics_meta.address_daily_dirty_days(date) VALUES((pg_catalog.to_timestamp(prior) AT TIME ZONE 'UTC')::date) ON CONFLICT(date) DO UPDATE SET revision=analytics_meta.address_daily_dirty_days.revision+1;END IF;
 RETURN NULL;END$$;
REVOKE ALL ON FUNCTION analytics_meta.track_address_day() FROM PUBLIC;
-- Canonical membership follows blocks/transactions; incidences follow address_transactions.
CREATE TRIGGER ask_address_day AFTER INSERT OR UPDATE OR DELETE ON public.blocks FOR EACH ROW EXECUTE FUNCTION analytics_meta.track_address_day();
CREATE TRIGGER ask_address_day AFTER INSERT OR UPDATE OR DELETE ON public.transactions FOR EACH ROW EXECUTE FUNCTION analytics_meta.track_address_day();
CREATE TRIGGER ask_address_day AFTER INSERT OR UPDATE OR DELETE ON public.address_transactions FOR EACH ROW EXECUTE FUNCTION analytics_meta.track_address_day();
CREATE TRIGGER ask_address_truncate AFTER TRUNCATE ON public.blocks FOR EACH STATEMENT EXECUTE FUNCTION analytics_meta.track_address_day();
CREATE TRIGGER ask_address_truncate AFTER TRUNCATE ON public.transactions FOR EACH STATEMENT EXECUTE FUNCTION analytics_meta.track_address_day();
CREATE TRIGGER ask_address_truncate AFTER TRUNCATE ON public.address_transactions FOR EACH STATEMENT EXECUTE FUNCTION analytics_meta.track_address_day();
ALTER TABLE public.blocks ENABLE ALWAYS TRIGGER ask_address_day;ALTER TABLE public.transactions ENABLE ALWAYS TRIGGER ask_address_day;ALTER TABLE public.address_transactions ENABLE ALWAYS TRIGGER ask_address_day;
ALTER TABLE public.blocks ENABLE ALWAYS TRIGGER ask_address_truncate;ALTER TABLE public.transactions ENABLE ALWAYS TRIGGER ask_address_truncate;ALTER TABLE public.address_transactions ENABLE ALWAYS TRIGGER ask_address_truncate;
RESET ROLE;
GRANT SELECT ON analytics_meta.address_daily,analytics_meta.address_daily_dirty_days TO ask_public_view_owner;
SET LOCAL ROLE ask_public_view_owner;
-- Same columns and rules as catalogue-destination-v1.sql, plus the address dirty set.
CREATE OR REPLACE VIEW analytics_public.dataset_coverage WITH(security_barrier=true) AS
 SELECT d.dataset,(c.ready AND d.ready AND d.verified_at<=statement_timestamp()
 AND CASE WHEN d.dataset IN('activity_daily','flow_daily') THEN NOT EXISTS(SELECT FROM analytics_meta.summary_dirty_days WHERE date<CURRENT_DATE) WHEN d.dataset='address_daily' THEN NOT EXISTS(SELECT FROM analytics_meta.address_daily_dirty_days WHERE date<CURRENT_DATE) ELSE d.verified_at>statement_timestamp()-interval '120 seconds' END) AS ready,d.generation,d.verified_at,d.source_through FROM analytics_meta.dataset_state d CROSS JOIN analytics_public.coverage c;
CREATE VIEW analytics_public.address_daily_query WITH(security_barrier=true) AS SELECT d.* FROM analytics_meta.address_daily d CROSS JOIN analytics_public.dataset_coverage c WHERE c.dataset='address_daily' AND c.ready AND d.date<CURRENT_DATE;
RESET ROLE;
REVOKE ALL ON analytics_meta.address_daily,analytics_meta.address_daily_dirty_days FROM PUBLIC;
GRANT SELECT ON analytics_public.address_daily_query TO ask_public_reader;
COMMIT;
