\set ON_ERROR_STOP on
-- Reverses address-daily-v1.sql only. Deploy code without address_daily first.
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper) OR to_regclass('analytics_meta.address_daily') IS NULL THEN RAISE EXCEPTION 'Dedicated store with address_daily required';END IF;END$$;
DROP VIEW analytics_public.address_daily_query;
SET LOCAL ROLE ask_public_view_owner;
CREATE OR REPLACE VIEW analytics_public.dataset_coverage WITH(security_barrier=true) AS
 SELECT d.dataset,(c.ready AND d.ready AND d.verified_at<=statement_timestamp()
 AND CASE WHEN d.dataset IN('activity_daily','flow_daily') THEN NOT EXISTS(SELECT FROM analytics_meta.summary_dirty_days WHERE date<CURRENT_DATE) ELSE d.verified_at>statement_timestamp()-interval '120 seconds' END) AS ready,d.generation,d.verified_at,d.source_through FROM analytics_meta.dataset_state d CROSS JOIN analytics_public.coverage c;
RESET ROLE;
DROP TRIGGER ask_address_day ON public.blocks;DROP TRIGGER ask_address_day ON public.transactions;DROP TRIGGER ask_address_day ON public.address_transactions;
DROP TRIGGER ask_address_truncate ON public.blocks;DROP TRIGGER ask_address_truncate ON public.transactions;DROP TRIGGER ask_address_truncate ON public.address_transactions;
DROP FUNCTION analytics_meta.track_address_day();
DELETE FROM analytics_meta.dataset_state WHERE dataset='address_daily';
DROP TABLE analytics_meta.address_daily,analytics_meta.address_daily_dirty_days;
COMMIT;
