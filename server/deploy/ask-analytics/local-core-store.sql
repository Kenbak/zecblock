-- Disposable LOCAL fixture database only. This is not a production migration.
-- Fixed roles abort on collision; no existing roles/databases are altered.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='500ms';
DO $$ BEGIN
 IF current_database() !~ '^ask_store_fixture_[0-9]+$' OR inet_server_addr() IS NOT NULL
 THEN RAISE EXCEPTION 'Disposable local store database required'; END IF;
END $$;
CREATE ROLE ask_store_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ask_store_writer LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1;
CREATE ROLE ask_store_reader LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
DO $$ BEGIN
 EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC',current_database());
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO ask_store_writer,ask_store_reader',current_database());
END $$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER ROLE ask_store_reader SET default_transaction_read_only=on;
ALTER ROLE ask_store_reader SET statement_timeout='3s';
ALTER ROLE ask_store_reader SET idle_in_transaction_session_timeout='5s';
ALTER ROLE ask_store_reader SET lock_timeout='500ms';
ALTER ROLE ask_store_reader SET work_mem='1MB';
ALTER ROLE ask_store_reader SET temp_file_limit='16MB';
ALTER ROLE ask_store_reader SET search_path=pg_catalog;
CREATE SCHEMA analytics_meta AUTHORIZATION ask_store_owner;
CREATE SCHEMA analytics_public AUTHORIZATION ask_store_owner;
REVOKE ALL ON SCHEMA analytics_meta,analytics_public FROM PUBLIC;
SET LOCAL ROLE ask_store_owner;
CREATE TABLE analytics_meta.identity (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 schema_version integer NOT NULL CHECK(schema_version=1),
 network text NOT NULL CHECK(network='mainnet'),
 store_kind text NOT NULL CHECK(store_kind='local_core_fixture')
);
INSERT INTO analytics_meta.identity VALUES(true,1,'mainnet','local_core_fixture');
CREATE TABLE analytics_meta.sync_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 source_id uuid,
 source_revision numeric(78,0),
 covered_from bigint,
 covered_through bigint,
 tip_hash text,
 source_observed_at timestamptz,
 published_at timestamptz,
 digest text,
 CHECK((generation=0 AND source_id IS NULL AND source_revision IS NULL AND covered_from IS NULL
        AND covered_through IS NULL AND tip_hash IS NULL AND source_observed_at IS NULL AND published_at IS NULL AND digest IS NULL)
    OR (generation>0 AND source_id IS NOT NULL AND source_revision IS NOT NULL AND source_revision>0 AND covered_from IS NOT NULL AND covered_from>=0 AND covered_through IS NOT NULL AND covered_through>=covered_from
        AND tip_hash IS NOT NULL AND tip_hash ~ '^[0-9a-f]{64}$' AND source_observed_at IS NOT NULL AND published_at IS NOT NULL AND digest IS NOT NULL AND digest ~ '^[0-9a-f]{64}$'))
);
INSERT INTO analytics_meta.sync_state(singleton) VALUES(true);
CREATE TABLE analytics_public.blocks (
 height bigint PRIMARY KEY CHECK(height>=0),
 hash text NOT NULL CHECK(hash ~ '^[0-9a-f]{64}$'),
 previous_hash text NOT NULL CHECK(previous_hash ~ '^[0-9a-f]{64}$'),
 timestamp bigint NOT NULL CHECK(timestamp>=0),
 transaction_count integer NOT NULL CHECK(transaction_count>0),
 size bigint CHECK(size>=0),
 total_fees numeric(78,0) CHECK(total_fees>=0),
 miner_address text,
 UNIQUE(hash),
 UNIQUE(height,hash,timestamp)
);
CREATE INDEX blocks_timestamp_idx ON analytics_public.blocks(timestamp,height);
CREATE TABLE analytics_public.transactions (
 txid text PRIMARY KEY CHECK(txid ~ '^[0-9a-f]{64}$'),
 block_height bigint NOT NULL,
 block_hash text NOT NULL,
 block_time bigint NOT NULL CHECK(block_time>=0),
 is_coinbase boolean NOT NULL,
 fee numeric(78,0) CHECK(fee>=0),
 size bigint CHECK(size>=0),
 has_sapling boolean NOT NULL,
 has_orchard boolean NOT NULL,
 has_ironwood boolean NOT NULL,
 has_sprout boolean NOT NULL,
 value_balance_orchard numeric(78,0),
 value_balance_ironwood numeric(78,0),
 UNIQUE(txid,block_height,block_time),
 FOREIGN KEY(block_height,block_hash,block_time) REFERENCES analytics_public.blocks(height,hash,timestamp) ON DELETE CASCADE
);
CREATE INDEX transactions_block_idx ON analytics_public.transactions(block_height,txid);
CREATE TABLE analytics_public.flows (
 txid text NOT NULL,
 block_height bigint NOT NULL,
 block_time bigint NOT NULL CHECK(block_time>=0),
 flow_type text NOT NULL CHECK(flow_type IN ('shield','deshield')),
 pool text,
 amount_zat numeric(78,0) NOT NULL CHECK(amount_zat>=0),
 PRIMARY KEY(txid,flow_type),
 FOREIGN KEY(txid,block_height,block_time) REFERENCES analytics_public.transactions(txid,block_height,block_time) ON DELETE CASCADE
);
CREATE INDEX flows_time_direction_idx ON analytics_public.flows(block_time,flow_type);
CREATE VIEW analytics_public.coverage WITH(security_barrier=true) AS
 SELECT 1 AS schema_version,'mainnet'::text AS network,'fixture_only'::text AS authority,
 generation,covered_from,covered_through,tip_hash,source_observed_at,published_at,
 'historical_backfill_unverified'::text AS flow_completeness
 FROM analytics_meta.sync_state WHERE generation>0;
RESET ROLE;
REVOKE ALL ON ALL TABLES IN SCHEMA analytics_meta,analytics_public FROM PUBLIC;
GRANT USAGE ON SCHEMA analytics_meta,analytics_public TO ask_store_writer;
GRANT SELECT ON analytics_meta.identity,analytics_meta.sync_state TO ask_store_writer;
GRANT UPDATE ON analytics_meta.sync_state TO ask_store_writer;
GRANT SELECT,INSERT,DELETE ON analytics_public.blocks,analytics_public.transactions,analytics_public.flows TO ask_store_writer;
GRANT USAGE ON SCHEMA analytics_public TO ask_store_reader;
GRANT SELECT ON analytics_public.blocks,analytics_public.transactions,analytics_public.flows,analytics_public.coverage TO ask_store_reader;
COMMIT;
-- Neither role has membership in owner; writer cannot create/drop/truncate/grant.
-- Reader grants are tested after switching OFF its read-only session default.
-- No raw SQL endpoint is exposed. Public release still requires a separately
-- audited worker, allowed functions/ASTs and network/resource/spend controls.
