BEGIN;
SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='500ms';
DO $$BEGIN
 IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM analytics_meta.identity WHERE store_kind='logical_public_core' AND schema_version=1) OR EXISTS(SELECT FROM pg_namespace WHERE nspname='analytics_feed_meta') THEN RAISE EXCEPTION 'Fresh dedicated admission migration required'; END IF;
END$$;
SET LOCAL ROLE analytics_owner;
CREATE SCHEMA analytics_feed_meta AUTHORIZATION analytics_owner;
CREATE TABLE analytics_feed_meta.signal(singleton boolean PRIMARY KEY CHECK(singleton),generation uuid NOT NULL,system_identifier text NOT NULL,timeline integer NOT NULL,sampled_at timestamptz NOT NULL,tip_height bigint NOT NULL,tip_hash text NOT NULL,before_lsn pg_lsn NOT NULL);
REVOKE ALL ON SCHEMA analytics_feed_meta FROM PUBLIC;
REVOKE ALL ON analytics_feed_meta.signal FROM PUBLIC;
CREATE TABLE analytics_meta.admission_control(singleton boolean PRIMARY KEY CHECK(singleton),baseline_verified boolean NOT NULL DEFAULT false,expected_timeline integer NOT NULL,baseline_through bigint,baseline_at timestamptz);
INSERT INTO analytics_meta.admission_control(singleton,expected_timeline) VALUES(true,2);
CREATE INDEX ask_flows_block_idx ON public.shielded_flows(block_height,txid);
CREATE TABLE analytics_meta.dirty_heights(height bigint PRIMARY KEY,changed_at timestamptz NOT NULL);
CREATE FUNCTION analytics_meta.track_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$DECLARE h bigint; prior bigint;BEGIN
 IF TG_OP='TRUNCATE' THEN UPDATE analytics_meta.sync_state SET state='quarantined',verified_at=NULL; UPDATE analytics_meta.admission_control SET baseline_verified=false; RETURN NULL; END IF;
 IF TG_TABLE_NAME='blocks' THEN IF TG_OP<>'DELETE' THEN h:=NEW.height; END IF; IF TG_OP<>'INSERT' THEN prior:=OLD.height; END IF;
 ELSE IF TG_OP<>'DELETE' THEN h:=NEW.block_height; END IF; IF TG_OP<>'INSERT' THEN prior:=OLD.block_height; END IF; END IF;
 IF h IS NOT NULL THEN INSERT INTO analytics_meta.dirty_heights VALUES(h,clock_timestamp()) ON CONFLICT(height) DO UPDATE SET changed_at=EXCLUDED.changed_at; END IF;
 IF prior IS NOT NULL AND prior IS DISTINCT FROM h THEN INSERT INTO analytics_meta.dirty_heights VALUES(prior,clock_timestamp()) ON CONFLICT(height) DO UPDATE SET changed_at=EXCLUDED.changed_at; END IF;
 IF h IS NOT NULL THEN INSERT INTO analytics_meta.dirty_heights VALUES(h+1,clock_timestamp()) ON CONFLICT(height) DO UPDATE SET changed_at=EXCLUDED.changed_at; END IF;
 IF prior IS NOT NULL AND prior IS DISTINCT FROM h THEN INSERT INTO analytics_meta.dirty_heights VALUES(prior+1,clock_timestamp()) ON CONFLICT(height) DO UPDATE SET changed_at=EXCLUDED.changed_at; END IF;
 RETURN NULL;
END$$;
REVOKE ALL ON FUNCTION analytics_meta.track_change() FROM PUBLIC;
CREATE TRIGGER ask_track_change AFTER INSERT OR UPDATE OR DELETE ON public.blocks FOR EACH ROW EXECUTE FUNCTION analytics_meta.track_change();
CREATE TRIGGER ask_track_truncate AFTER TRUNCATE ON public.blocks FOR EACH STATEMENT EXECUTE FUNCTION analytics_meta.track_change();
ALTER TABLE public.blocks ENABLE ALWAYS TRIGGER ask_track_change; ALTER TABLE public.blocks ENABLE ALWAYS TRIGGER ask_track_truncate;
CREATE TRIGGER ask_track_change AFTER INSERT OR UPDATE OR DELETE ON public.transactions FOR EACH ROW EXECUTE FUNCTION analytics_meta.track_change();
CREATE TRIGGER ask_track_truncate AFTER TRUNCATE ON public.transactions FOR EACH STATEMENT EXECUTE FUNCTION analytics_meta.track_change();
ALTER TABLE public.transactions ENABLE ALWAYS TRIGGER ask_track_change; ALTER TABLE public.transactions ENABLE ALWAYS TRIGGER ask_track_truncate;
CREATE TRIGGER ask_track_change AFTER INSERT OR UPDATE OR DELETE ON public.shielded_flows FOR EACH ROW EXECUTE FUNCTION analytics_meta.track_change();
CREATE TRIGGER ask_track_truncate AFTER TRUNCATE ON public.shielded_flows FOR EACH STATEMENT EXECUTE FUNCTION analytics_meta.track_change();
ALTER TABLE public.shielded_flows ENABLE ALWAYS TRIGGER ask_track_change; ALTER TABLE public.shielded_flows ENABLE ALWAYS TRIGGER ask_track_truncate;
CREATE FUNCTION analytics_meta.is_admitted() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
SELECT coalesce((SELECT c.baseline_verified AND s.state='ready' AND m.generation=s.source_id AND m.system_identifier=s.source_system_identifier AND m.timeline=c.expected_timeline AND m.tip_height>=s.covered_through AND m.sampled_at<=statement_timestamp() AND m.sampled_at>statement_timestamp()-interval '120 seconds' AND NOT EXISTS(SELECT FROM analytics_meta.dirty_heights d WHERE d.height<=s.covered_through) FROM analytics_meta.sync_state s JOIN analytics_meta.admission_control c USING(singleton) JOIN analytics_feed_meta.signal m USING(singleton)),false)
$$;
REVOKE ALL ON FUNCTION analytics_meta.is_admitted() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_meta.is_admitted() TO ask_public_view_owner, ask_public_reader;
RESET ROLE;
SET LOCAL ROLE ask_public_view_owner;
CREATE OR REPLACE VIEW analytics_public.coverage WITH(security_barrier=true) AS
 WITH candidate AS(SELECT state,covered_from,covered_through,tip_hash,verified_at,flow_completeness,
 (state='ready' AND verified_at<=statement_timestamp() AND verified_at>statement_timestamp()-interval '120 seconds' AND analytics_meta.is_admitted() AND EXISTS(SELECT FROM public.blocks b WHERE b.height=covered_through AND b.hash=tip_hash)) AS is_ready FROM analytics_meta.sync_state)
 SELECT 1 AS schema_version,'mainnet'::text AS network,'logical_public_core'::text AS authority,CASE WHEN state='ready' AND NOT is_ready THEN 'stale' ELSE state END AS state,is_ready AS ready,covered_from,covered_through,tip_hash,verified_at,flow_completeness FROM candidate;
CREATE OR REPLACE VIEW analytics_public.blocks_query WITH(security_barrier=true) AS SELECT b.height,b.hash,b.timestamp,b.miner_address AS miner,b.transaction_count AS transactions,b.size AS bytes,b.total_fees AS fees FROM public.blocks b CROSS JOIN analytics_public.coverage c WHERE c.ready AND b.height BETWEEN c.covered_from AND c.covered_through;
-- Admission verifies canonical transaction/flow identity atomically. Avoid
-- redundant joins over the entire chain, which spill even for small windows.
-- The optional miner join is removable by PostgreSQL when miner is not used.
CREATE OR REPLACE VIEW analytics_public.transactions_query WITH(security_barrier=true) AS SELECT t.txid,t.block_height AS height,t.block_time AS timestamp,b.miner_address AS miner,(t.has_sapling OR t.has_orchard OR t.has_ironwood OR t.has_sprout) AS shielded,t.has_orchard AS orchard,t.has_ironwood AS ironwood,t.has_sapling AS sapling,t.size AS bytes,t.fee AS fees FROM public.transactions t CROSS JOIN analytics_public.coverage c LEFT JOIN public.blocks b ON b.height=t.block_height WHERE c.ready AND t.block_height BETWEEN c.covered_from AND c.covered_through AND t.is_coinbase=false;
CREATE OR REPLACE VIEW analytics_public.flows_query WITH(security_barrier=true) AS SELECT f.txid,f.block_height AS height,f.block_time AS timestamp,f.flow_type AS direction,f.pool,f.amount_zat AS amount FROM public.shielded_flows f CROSS JOIN analytics_public.coverage c WHERE c.ready AND f.block_height BETWEEN c.covered_from AND c.covered_through;
RESET ROLE;
REVOKE ALL ON ALL TABLES IN SCHEMA analytics_feed_meta,analytics_meta FROM PUBLIC;
GRANT SELECT ON analytics_public.blocks_query,analytics_public.transactions_query,analytics_public.flows_query TO ask_public_reader;
COMMIT;
