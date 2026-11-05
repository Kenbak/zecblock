\set ON_ERROR_STOP on
SET statement_timeout='30s'; SET lock_timeout='500ms';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1)
 OR NOT EXISTS(SELECT FROM analytics_public.coverage WHERE ready AND authority='logical_public_core' AND network='mainnet')
 THEN RAISE EXCEPTION 'Admitted dedicated analytics destination required'; END IF;
END$$;
ANALYZE public.blocks;
ANALYZE public.transactions;
ANALYZE public.shielded_flows;
RESET statement_timeout; RESET lock_timeout;
