\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='500ms';SET LOCAL statement_timeout='30s';SET LOCAL timezone='UTC';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper)
 OR EXISTS(SELECT FROM pg_class WHERE oid IN(to_regclass('analytics_meta.dataset_state'),to_regclass('public.privacy_trends_daily'),to_regclass('public.address_transactions'),to_regclass('public.cross_chain_swaps'),to_regclass('public.addresses')))
 THEN RAISE EXCEPTION 'Fresh additive dedicated catalogue migration required';END IF;
END$$;
SET LOCAL ROLE analytics_owner;
CREATE TABLE public.privacy_trends_daily(id integer PRIMARY KEY,date date,shielded_count bigint,transparent_count bigint,orchard_pool_size bigint,ironwood_pool_size bigint,sapling_pool_size bigint,sprout_pool_size bigint);
CREATE INDEX ask_daily_date_idx ON public.privacy_trends_daily(date);
CREATE TABLE public.cross_chain_swaps(id integer PRIMARY KEY,status text,source_chain text,source_token text,source_amount_usd numeric,dest_chain text,dest_token text,dest_amount_usd numeric,swap_created_at timestamptz);
CREATE INDEX ask_swaps_time_idx ON public.cross_chain_swaps(swap_created_at);
CREATE TABLE public.addresses(address text PRIMARY KEY,balance bigint,total_received bigint,total_sent bigint,tx_count integer,first_seen bigint,last_seen bigint,address_type text);
CREATE INDEX ask_addresses_last_seen_idx ON public.addresses(last_seen,address);
CREATE TABLE public.address_transactions(address text,txid text,block_height integer,tx_index integer,block_time bigint,is_input boolean,is_output boolean,value_in bigint,value_out bigint,PRIMARY KEY(address,block_height,tx_index,txid));
CREATE INDEX ask_address_activity_time_idx ON public.address_transactions(block_time,address);
CREATE INDEX ask_address_activity_tx_idx ON public.address_transactions(txid,block_height);
CREATE TABLE analytics_meta.dataset_state(dataset text PRIMARY KEY,ready boolean NOT NULL DEFAULT false,generation text NOT NULL DEFAULT 'uninitialized',verified_at timestamptz,source_through timestamptz);
INSERT INTO analytics_meta.dataset_state(dataset) VALUES('daily'),('swaps'),('addresses'),('address_activity'),('activity_daily'),('flow_daily');
CREATE TABLE analytics_meta.summary_dirty_days(date date PRIMARY KEY,revision bigint NOT NULL DEFAULT 0);
INSERT INTO analytics_meta.summary_dirty_days(date) SELECT DISTINCT (to_timestamp(timestamp) AT TIME ZONE 'UTC')::date FROM public.blocks WHERE timestamp IS NOT NULL;
CREATE TABLE analytics_meta.activity_daily(date date PRIMARY KEY,blocks bigint,transactions bigint,shielded_transactions bigint,transparent_transactions bigint,unclassified_transactions bigint,bytes numeric,fees numeric,missing_fees bigint,missing_bytes bigint);
CREATE TABLE analytics_meta.flow_daily(date date,pool text,direction text,records bigint,amount numeric,missing_amounts bigint,PRIMARY KEY(date,pool,direction));
CREATE FUNCTION analytics_meta.track_summary_day() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$DECLARE epoch bigint;prior bigint;BEGIN
 IF TG_OP='TRUNCATE' THEN UPDATE analytics_meta.dataset_state SET ready=false,verified_at=NULL WHERE dataset IN('activity_daily','flow_daily');INSERT INTO analytics_meta.summary_dirty_days(date) SELECT date FROM (SELECT (pg_catalog.to_timestamp(timestamp) AT TIME ZONE 'UTC')::date AS date FROM public.blocks WHERE timestamp IS NOT NULL UNION SELECT date FROM analytics_meta.activity_daily UNION SELECT date FROM analytics_meta.flow_daily) affected ON CONFLICT(date) DO UPDATE SET revision=analytics_meta.summary_dirty_days.revision+1;RETURN NULL;END IF;
 IF TG_TABLE_NAME='blocks' THEN IF TG_OP<>'DELETE' THEN epoch:=NEW.timestamp;END IF;IF TG_OP<>'INSERT' THEN prior:=OLD.timestamp;END IF;
 ELSE IF TG_OP<>'DELETE' THEN epoch:=NEW.block_time;END IF;IF TG_OP<>'INSERT' THEN prior:=OLD.block_time;END IF;END IF;
 IF epoch IS NOT NULL THEN INSERT INTO analytics_meta.summary_dirty_days(date) VALUES((pg_catalog.to_timestamp(epoch) AT TIME ZONE 'UTC')::date) ON CONFLICT(date) DO UPDATE SET revision=analytics_meta.summary_dirty_days.revision+1;END IF;
 IF prior IS NOT NULL AND prior IS DISTINCT FROM epoch THEN INSERT INTO analytics_meta.summary_dirty_days(date) VALUES((pg_catalog.to_timestamp(prior) AT TIME ZONE 'UTC')::date) ON CONFLICT(date) DO UPDATE SET revision=analytics_meta.summary_dirty_days.revision+1;END IF;
 RETURN NULL;END$$;
REVOKE ALL ON FUNCTION analytics_meta.track_summary_day() FROM PUBLIC;
CREATE TRIGGER ask_summary_day AFTER INSERT OR UPDATE OR DELETE ON public.blocks FOR EACH ROW EXECUTE FUNCTION analytics_meta.track_summary_day();
CREATE TRIGGER ask_summary_day AFTER INSERT OR UPDATE OR DELETE ON public.transactions FOR EACH ROW EXECUTE FUNCTION analytics_meta.track_summary_day();
CREATE TRIGGER ask_summary_day AFTER INSERT OR UPDATE OR DELETE ON public.shielded_flows FOR EACH ROW EXECUTE FUNCTION analytics_meta.track_summary_day();
CREATE TRIGGER ask_summary_truncate AFTER TRUNCATE ON public.blocks FOR EACH STATEMENT EXECUTE FUNCTION analytics_meta.track_summary_day();
CREATE TRIGGER ask_summary_truncate AFTER TRUNCATE ON public.transactions FOR EACH STATEMENT EXECUTE FUNCTION analytics_meta.track_summary_day();
CREATE TRIGGER ask_summary_truncate AFTER TRUNCATE ON public.shielded_flows FOR EACH STATEMENT EXECUTE FUNCTION analytics_meta.track_summary_day();
ALTER TABLE public.blocks ENABLE ALWAYS TRIGGER ask_summary_day;ALTER TABLE public.transactions ENABLE ALWAYS TRIGGER ask_summary_day;ALTER TABLE public.shielded_flows ENABLE ALWAYS TRIGGER ask_summary_day;
ALTER TABLE public.blocks ENABLE ALWAYS TRIGGER ask_summary_truncate;ALTER TABLE public.transactions ENABLE ALWAYS TRIGGER ask_summary_truncate;ALTER TABLE public.shielded_flows ENABLE ALWAYS TRIGGER ask_summary_truncate;
RESET ROLE;
GRANT SELECT ON public.privacy_trends_daily,public.cross_chain_swaps,public.addresses,public.address_transactions,analytics_meta.dataset_state,analytics_meta.summary_dirty_days,analytics_meta.activity_daily,analytics_meta.flow_daily TO ask_public_view_owner;
SET LOCAL ROLE ask_public_view_owner;
CREATE VIEW analytics_public.dataset_coverage WITH(security_barrier=true) AS
 SELECT d.dataset,(c.ready AND d.ready AND d.verified_at<=statement_timestamp()
 AND CASE WHEN d.dataset IN('activity_daily','flow_daily') THEN NOT EXISTS(SELECT FROM analytics_meta.summary_dirty_days WHERE date<CURRENT_DATE) ELSE d.verified_at>statement_timestamp()-interval '120 seconds' END) AS ready,d.generation,d.verified_at,d.source_through FROM analytics_meta.dataset_state d CROSS JOIN analytics_public.coverage c;
CREATE VIEW analytics_public.daily_query WITH(security_barrier=true) AS SELECT d.date,d.shielded_count::numeric+d.transparent_count::numeric AS transactions,d.shielded_count AS shielded_transactions,d.transparent_count AS transparent_transactions,d.orchard_pool_size AS orchard,d.ironwood_pool_size AS ironwood,d.sapling_pool_size AS sapling,d.sprout_pool_size AS sprout FROM public.privacy_trends_daily d CROSS JOIN analytics_public.dataset_coverage c WHERE c.dataset='daily' AND c.ready AND d.date<CURRENT_DATE;
CREATE VIEW analytics_public.swaps_query WITH(security_barrier=true) AS SELECT s.swap_created_at AS timestamp,CASE WHEN lower(s.dest_chain)='zec' THEN 'inflow' ELSE 'outflow' END AS direction,CASE WHEN lower(s.dest_chain)='zec' THEN s.source_chain ELSE s.dest_chain END AS chain,CASE WHEN lower(s.dest_chain)='zec' THEN s.source_token ELSE s.dest_token END AS token,NULLIF(CASE WHEN lower(s.dest_chain)='zec' THEN s.source_amount_usd ELSE s.dest_amount_usd END,0) AS usd FROM public.cross_chain_swaps s CROSS JOIN analytics_public.dataset_coverage c WHERE c.dataset='swaps' AND c.ready AND s.status='SUCCESS' AND (lower(s.source_chain)='zec')<>(lower(s.dest_chain)='zec');
CREATE VIEW analytics_public.addresses_query WITH(security_barrier=true) AS SELECT a.address,a.balance,a.total_received AS received,a.total_sent AS sent,a.tx_count AS transactions,a.first_seen,a.last_seen FROM public.addresses a CROSS JOIN analytics_public.dataset_coverage c WHERE c.dataset='addresses' AND c.ready AND a.address_type='transparent';
CREATE VIEW analytics_public.address_activity_query WITH(security_barrier=true) AS SELECT a.address,a.txid,a.block_height AS height,a.block_time AS timestamp,a.tx_index,a.is_input,a.is_output,a.value_out AS received,a.value_in AS sent FROM public.address_transactions a CROSS JOIN LATERAL (SELECT 1 FROM public.transactions t JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash WHERE t.txid=a.txid AND t.block_height=a.block_height AND t.block_time=a.block_time OFFSET 0) canonical CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core WHERE c.dataset='address_activity' AND c.ready AND core.ready AND a.block_height BETWEEN core.covered_from AND core.covered_through;
CREATE VIEW analytics_public.activity_daily_query WITH(security_barrier=true) AS SELECT d.* FROM analytics_meta.activity_daily d CROSS JOIN analytics_public.dataset_coverage c WHERE c.dataset='activity_daily' AND c.ready AND d.date<CURRENT_DATE;
CREATE VIEW analytics_public.flow_daily_query WITH(security_barrier=true) AS SELECT d.* FROM analytics_meta.flow_daily d CROSS JOIN analytics_public.dataset_coverage c WHERE c.dataset='flow_daily' AND c.ready AND d.date<CURRENT_DATE;
RESET ROLE;
REVOKE ALL ON public.privacy_trends_daily,public.cross_chain_swaps,public.addresses,public.address_transactions,analytics_meta.dataset_state,analytics_meta.summary_dirty_days,analytics_meta.activity_daily,analytics_meta.flow_daily FROM PUBLIC;
GRANT SELECT ON analytics_public.dataset_coverage,analytics_public.daily_query,analytics_public.swaps_query,analytics_public.addresses_query,analytics_public.address_activity_query,analytics_public.activity_daily_query,analytics_public.flow_daily_query TO ask_public_reader;
COMMIT;
