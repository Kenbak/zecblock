-- Dedicated PG16 analytics destination only. No source/publication/subscription changes.
-- One-time additive migration: collisions and non-empty stores abort atomically.
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '15s';
SET LOCAL search_path = pg_catalog;
DO $$
BEGIN
 IF current_database() <> 'ask_analytics' OR pg_is_in_recovery()
    OR current_setting('server_version_num')::integer NOT BETWEEN 160000 AND 169999 THEN
  RAISE EXCEPTION 'Expected dedicated ask_analytics PostgreSQL 16 destination';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
  RAISE EXCEPTION 'Operator superuser required for one-time destination provisioning';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_roles r JOIN pg_database d ON d.datdba=r.oid
    WHERE d.datname=current_database() AND r.rolname='analytics_owner' AND NOT r.rolcanlogin
    AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
    AND NOT r.rolreplication AND NOT r.rolbypassrls) THEN
  RAISE EXCEPTION 'Expected existing unprivileged NOLOGIN database owner';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='analytics_owner')) THEN
  RAISE EXCEPTION 'Destination owner must not inherit other roles';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('analytics_meta','analytics_public'))
    OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('ask_public_view_owner','ask_public_reader'))
    OR EXISTS (SELECT 1 FROM pg_subscription) OR EXISTS (SELECT 1 FROM pg_replication_slots) THEN
  RAISE EXCEPTION 'Destination must be empty and reserved roles/schemas unused';
 END IF;
END $$;
REVOKE ALL ON DATABASE ask_analytics FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE ROLE ask_public_view_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ask_public_reader NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8;
GRANT CONNECT ON DATABASE ask_analytics TO ask_public_reader;
ALTER ROLE ask_public_reader SET default_transaction_read_only = on;
ALTER ROLE ask_public_reader SET statement_timeout = '3s';
ALTER ROLE ask_public_reader SET lock_timeout = '500ms';
ALTER ROLE ask_public_reader SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE ask_public_reader SET work_mem = '1MB';
ALTER ROLE ask_public_reader SET temp_file_limit = '16MB';
ALTER ROLE ask_public_reader SET max_parallel_workers_per_gather = 0;
ALTER ROLE ask_public_reader SET jit = off;
ALTER ROLE ask_public_reader SET search_path = pg_catalog;
CREATE SCHEMA analytics_meta AUTHORIZATION analytics_owner;
CREATE SCHEMA analytics_public AUTHORIZATION ask_public_view_owner;
REVOKE ALL ON SCHEMA analytics_meta,analytics_public FROM PUBLIC;
SET LOCAL ROLE analytics_owner;
-- Match the reviewed source names/types and default replica identities exactly.
-- No foreign-key cascades or extra data checks: native apply order/history must
-- not depend on the stricter local snapshot fixture's schema.
CREATE TABLE public.blocks (
 height bigint PRIMARY KEY, hash text, previous_block_hash text, timestamp bigint,
 transaction_count integer, size integer, total_fees bigint, miner_address text
);
CREATE TABLE public.transactions (
 txid text PRIMARY KEY, block_height bigint, block_hash text, block_time bigint,
 is_coinbase boolean, fee bigint, size integer, has_sapling boolean,
 has_orchard boolean, has_ironwood boolean, has_sprout boolean,
 value_balance_orchard bigint, value_balance_ironwood bigint
);
CREATE TABLE public.shielded_flows (
 id integer PRIMARY KEY, txid text, block_height integer, block_time integer,
 flow_type text, pool text, amount_zat bigint, UNIQUE(txid,flow_type)
);
CREATE INDEX ask_blocks_time_idx ON public.blocks(timestamp,height);
CREATE INDEX ask_transactions_block_idx ON public.transactions(block_height,txid);
CREATE INDEX ask_transactions_time_idx ON public.transactions(block_time,txid);
CREATE INDEX ask_flows_time_direction_idx ON public.shielded_flows(block_time,flow_type);
CREATE TABLE analytics_meta.identity (
 singleton boolean PRIMARY KEY CHECK(singleton),
 schema_version integer NOT NULL CHECK(schema_version=1),
 network text NOT NULL CHECK(network='mainnet'),
 store_kind text NOT NULL CHECK(store_kind='logical_public_core')
);
INSERT INTO analytics_meta.identity VALUES(true,1,'mainnet','logical_public_core');
CREATE TABLE analytics_meta.sync_state (
 singleton boolean PRIMARY KEY CHECK(singleton),
 state text NOT NULL CHECK(state IN ('uninitialized','copying','reconciling','ready','stale','quarantined')),
 source_id uuid, source_system_identifier text, applied_lsn pg_lsn,
 covered_from bigint, covered_through bigint, tip_hash text, verified_at timestamptz,
 flow_completeness text NOT NULL DEFAULT 'unverified' CHECK(flow_completeness IN ('unverified','verified')),
 CHECK(state <> 'ready' OR (source_id IS NOT NULL AND source_system_identifier IS NOT NULL
   AND length(source_system_identifier)>0 AND applied_lsn IS NOT NULL
   AND covered_from IS NOT NULL AND covered_from>=0 AND covered_through IS NOT NULL AND covered_through>=covered_from
   AND tip_hash IS NOT NULL AND tip_hash ~ '^[0-9a-f]{64}$' AND verified_at IS NOT NULL))
);
INSERT INTO analytics_meta.sync_state(singleton,state) VALUES(true,'uninitialized');
RESET ROLE;
GRANT USAGE ON SCHEMA public,analytics_meta TO ask_public_view_owner;
GRANT SELECT(height,hash,previous_block_hash,timestamp,transaction_count,size,total_fees,miner_address) ON public.blocks TO ask_public_view_owner;
GRANT SELECT(txid,block_height,block_hash,block_time,is_coinbase,fee,size,has_sapling,has_orchard,has_ironwood,has_sprout,value_balance_orchard,value_balance_ironwood) ON public.transactions TO ask_public_view_owner;
GRANT SELECT(txid,block_height,block_time,flow_type,pool,amount_zat) ON public.shielded_flows TO ask_public_view_owner;
GRANT SELECT(state,covered_from,covered_through,tip_hash,verified_at,flow_completeness) ON analytics_meta.sync_state TO ask_public_view_owner;
SET LOCAL ROLE ask_public_view_owner;
-- Admin-controlled schema state is not the reconciliation/admission service.
-- The service must validate all-ready/applied checkpoint/canonical coverage in
-- one trusted transaction. Received LSN or latest height alone is insufficient.
CREATE VIEW analytics_public.coverage WITH(security_barrier=true) AS
 WITH candidate AS (
  SELECT state,covered_from,covered_through,tip_hash,verified_at,flow_completeness,
   (state='ready' AND verified_at<=statement_timestamp()
    AND verified_at>statement_timestamp()-interval '120 seconds'
    AND EXISTS (SELECT 1 FROM public.blocks b WHERE b.height=covered_through AND b.hash=tip_hash)) AS is_ready
  FROM analytics_meta.sync_state
 )
 SELECT 1 AS schema_version, 'mainnet'::text AS network, 'logical_public_core'::text AS authority,
  CASE WHEN state='ready' AND NOT is_ready THEN 'stale' ELSE state END AS state,
  is_ready AS ready,covered_from,covered_through,tip_hash,verified_at,flow_completeness
 FROM candidate;
CREATE VIEW analytics_public.blocks WITH(security_barrier=true) AS
 SELECT b.height,b.hash,b.previous_block_hash,b.timestamp,b.transaction_count,b.size,b.total_fees,b.miner_address
 FROM public.blocks b CROSS JOIN analytics_public.coverage c
 WHERE c.ready AND b.height BETWEEN c.covered_from AND c.covered_through;
CREATE VIEW analytics_public.transactions WITH(security_barrier=true) AS
 SELECT t.txid,t.block_height,t.block_hash,t.block_time,t.is_coinbase,t.fee,t.size,
  t.has_sapling,t.has_orchard,t.has_ironwood,t.has_sprout,t.value_balance_orchard,t.value_balance_ironwood
 FROM public.transactions t JOIN analytics_public.blocks b
  ON b.height=t.block_height AND b.hash=t.block_hash AND b.timestamp=t.block_time;
CREATE VIEW analytics_public.flows WITH(security_barrier=true) AS
 SELECT f.txid,f.block_height,f.block_time,f.flow_type,f.pool,f.amount_zat
 FROM public.shielded_flows f JOIN analytics_public.transactions t
  ON t.txid=f.txid AND t.block_height=f.block_height AND t.block_time=f.block_time;
RESET ROLE;
REVOKE ALL ON ALL TABLES IN SCHEMA public,analytics_meta,analytics_public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE analytics_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ask_public_view_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA analytics_public TO ask_public_reader;
GRANT SELECT ON analytics_public.blocks,analytics_public.transactions,analytics_public.flows,analytics_public.coverage TO ask_public_reader;
COMMIT;
-- Reader intentionally stays NOLOGIN; no password/HBA/worker change is made.
-- Role defaults are user-changeable, not immutable query/resource enforcement.
-- SQL parser/function controls, isolated worker, quotas and trusted admission
-- remain required before enabling a login or any public SQL/AI interface.
