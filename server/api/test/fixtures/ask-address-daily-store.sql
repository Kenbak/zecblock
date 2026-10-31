-- Disposable stand-in for the dedicated store prerequisites of address-daily-v1.sql.
-- Never a production migration. :days/:rows/:pool are replaced by the opt-in test.
CREATE ROLE analytics_owner NOLOGIN;
CREATE ROLE ask_public_view_owner NOLOGIN;
CREATE ROLE ask_public_reader LOGIN NOINHERIT;
CREATE SCHEMA analytics_meta AUTHORIZATION analytics_owner;
CREATE SCHEMA analytics_public AUTHORIZATION ask_public_view_owner;
GRANT USAGE ON SCHEMA analytics_meta TO ask_public_view_owner;
GRANT USAGE ON SCHEMA analytics_public TO ask_public_reader;
GRANT CREATE ON SCHEMA public TO analytics_owner;
SET ROLE analytics_owner;
CREATE TABLE analytics_meta.identity(store_kind text,schema_version int);
INSERT INTO analytics_meta.identity VALUES('logical_public_core',1);
CREATE TABLE analytics_meta.sync_state(applied_lsn pg_lsn);
INSERT INTO analytics_meta.sync_state VALUES('0/16B3748');
CREATE TABLE analytics_meta.core_state(ready boolean,covered_from bigint,covered_through bigint);
CREATE TABLE public.blocks(height integer PRIMARY KEY,hash text,timestamp bigint);
CREATE TABLE public.transactions(txid text,block_height integer,block_hash text,block_time bigint,is_coinbase boolean,PRIMARY KEY(txid,block_height));
CREATE INDEX ON public.transactions(block_height);
CREATE TABLE public.address_transactions(address text,txid text,block_height integer,tx_index integer,block_time bigint,is_input boolean,is_output boolean,value_in bigint,value_out bigint,PRIMARY KEY(address,block_height,tx_index,txid));
CREATE INDEX ask_address_activity_time_idx ON public.address_transactions(block_time,address);
CREATE INDEX ask_address_activity_tx_idx ON public.address_transactions(txid,block_height);
CREATE TABLE analytics_meta.dataset_state(dataset text PRIMARY KEY,ready boolean NOT NULL DEFAULT false,generation text NOT NULL DEFAULT 'uninitialized',verified_at timestamptz,source_through timestamptz);
INSERT INTO analytics_meta.dataset_state(dataset,ready,verified_at) VALUES('address_activity',true,clock_timestamp()),('activity_daily',true,clock_timestamp()),('flow_daily',true,clock_timestamp());
CREATE TABLE analytics_meta.summary_dirty_days(date date PRIMARY KEY,revision bigint NOT NULL DEFAULT 0);
RESET ROLE;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics_meta TO ask_public_view_owner;
GRANT SELECT ON public.blocks,public.transactions,public.address_transactions TO ask_public_view_owner;
SET ROLE ask_public_view_owner;
CREATE VIEW analytics_public.coverage AS SELECT ready,covered_from,covered_through FROM analytics_meta.core_state;
CREATE VIEW analytics_public.dataset_coverage WITH(security_barrier=true) AS
 SELECT d.dataset,(c.ready AND d.ready AND d.verified_at<=statement_timestamp()
 AND CASE WHEN d.dataset IN('activity_daily','flow_daily') THEN NOT EXISTS(SELECT FROM analytics_meta.summary_dirty_days WHERE date<CURRENT_DATE) ELSE d.verified_at>statement_timestamp()-interval '120 seconds' END) AS ready,d.generation,d.verified_at,d.source_through FROM analytics_meta.dataset_state d CROSS JOIN analytics_public.coverage c;
CREATE VIEW analytics_public.address_activity_query WITH(security_barrier=true) AS SELECT a.address,a.txid,a.block_height AS height,a.block_time AS timestamp,a.tx_index,a.is_input,a.is_output,a.value_out AS received,a.value_in AS sent FROM public.address_transactions a CROSS JOIN LATERAL (SELECT 1 FROM public.transactions t JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash WHERE t.txid=a.txid AND t.block_height=a.block_height AND t.block_time=a.block_time OFFSET 0) canonical CROSS JOIN analytics_public.dataset_coverage c CROSS JOIN analytics_public.coverage core WHERE c.dataset='address_activity' AND c.ready AND core.ready AND a.block_height BETWEEN core.covered_from AND core.covered_through;
RESET ROLE;
SET ROLE analytics_owner;
INSERT INTO analytics_meta.core_state VALUES(true,0,10000000);
INSERT INTO public.blocks SELECT h,'hash_'||h,1785542400+(h-1)*75 FROM generate_series(1,:days*1152) h;
INSERT INTO public.transactions SELECT 'tx_'||h||'_'||k,h,'hash_'||h,1785542400+(h-1)*75,k=0 FROM generate_series(1,:days*1152) h CROSS JOIN generate_series(0,4) k;
-- Address pool with a heavy head: about one in ten rows goes to 50 busy addresses.
INSERT INTO public.address_transactions
 SELECT DISTINCT ON (address,h,k,txid) address,txid,h,k,t,io%3<>1,io%3<>0,1000,2000 FROM (
  SELECT 'addr_'||CASE WHEN random()<0.1 THEN (random()*50)::int ELSE (random()*:pool)::int END AS address,'tx_'||h||'_'||k AS txid,h,k,1785542400+(h-1)*75 AS t,(random()*3)::int AS io
  FROM generate_series(1,:days*1152) h CROSS JOIN generate_series(0,4) k CROSS JOIN generate_series(1,:rows) r) x;
-- Orphans: a stale-hash transaction whose rows must be excluded. late_new appears
-- first in the orphan (day 5) and canonically on day 10, so it is new on day 10.
INSERT INTO public.transactions VALUES('tx_orphan',5000,'stale_hash',1785542400+4999*75,false);
INSERT INTO public.address_transactions VALUES('orphan_only','tx_orphan',5000,9,1785542400+4999*75,true,true,1,1),('late_new','tx_orphan',5000,9,1785542400+4999*75,false,true,1,1),('late_new','tx_100',11000,0,1785542400+10999*75,false,true,1,1);
INSERT INTO public.transactions VALUES('tx_100',11000,'hash_11000',1785542400+10999*75,false);
RESET ROLE;
ANALYZE;
