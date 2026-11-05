-- Reviewed additive migration on primary. Existing v1 role/schema are required.
-- No writer/monitoring roles, arbitrary tables, secrets or operational columns.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ask_analytics_owner' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls)
 OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ask_analytics_reader' AND NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit AND rolconnlimit BETWEEN 1 AND 2)
 THEN RAISE EXCEPTION 'Existing restricted Ask roles required'; END IF;
END $$;
GRANT SELECT (height,hash,timestamp,transaction_count,size,total_fees,miner_address) ON public.blocks TO ask_analytics_owner;
GRANT SELECT (txid,block_height,block_hash,is_coinbase,has_sapling,has_orchard,has_ironwood,has_sprout,size,fee,orchard_actions,ironwood_actions) ON public.transactions TO ask_analytics_owner;
GRANT SELECT (txid,block_height,block_time,flow_type,pool,amount_zat) ON public.shielded_flows TO ask_analytics_owner;
GRANT SELECT (status,direction,source_chain,source_token,source_amount_usd,dest_chain,dest_token,dest_amount_usd,swap_created_at) ON public.cross_chain_swaps TO ask_analytics_owner;
SET LOCAL ROLE ask_analytics_owner;
CREATE VIEW ask_public.daily_v2 WITH (security_barrier=true) AS SELECT date,
 shielded_count::numeric+transparent_count::numeric AS transactions,shielded_count AS shielded_transactions,transparent_count AS transparent_transactions,
 orchard_pool_size AS orchard,ironwood_pool_size AS ironwood,sapling_pool_size AS sapling,sprout_pool_size AS sprout FROM public.privacy_trends_daily;
CREATE VIEW ask_public.blocks_v2 WITH (security_barrier=true) AS SELECT height,hash,timestamp,miner_address AS miner,transaction_count AS transactions,size AS bytes,total_fees AS fees FROM public.blocks;
CREATE VIEW ask_public.transactions_v2 WITH (security_barrier=true) AS SELECT t.txid,b.height,b.timestamp,b.miner_address AS miner,
 t.has_sapling OR t.has_orchard OR t.has_ironwood OR t.has_sprout AS shielded,t.has_sapling AS sapling,t.has_orchard AS orchard,t.has_ironwood AS ironwood,t.size AS bytes,t.fee AS fees,t.orchard_actions,t.ironwood_actions
 FROM public.transactions t JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash WHERE t.is_coinbase=false;
CREATE VIEW ask_public.flows_v2 WITH (security_barrier=true) AS SELECT f.txid,b.height,f.block_time AS timestamp,f.flow_type AS direction,f.pool,f.amount_zat AS amount
 FROM public.shielded_flows f JOIN public.transactions t ON t.txid=f.txid AND t.block_height=f.block_height
 JOIN public.blocks b ON b.height=t.block_height AND b.hash=t.block_hash AND b.timestamp=f.block_time
 WHERE f.flow_type IN ('shield','deshield') AND f.amount_zat>=0 AND t.is_coinbase=false;
CREATE VIEW ask_public.swaps_v2 WITH (security_barrier=true) AS SELECT swap_created_at AS timestamp,
 CASE WHEN lower(dest_chain)='zec' THEN 'inflow' ELSE 'outflow' END AS direction,
 CASE WHEN lower(dest_chain)='zec' THEN source_chain ELSE dest_chain END AS chain,
 CASE WHEN lower(dest_chain)='zec' THEN source_token ELSE dest_token END AS token,
 NULLIF(CASE WHEN lower(dest_chain)='zec' THEN source_amount_usd ELSE dest_amount_usd END,0) AS usd
 FROM public.cross_chain_swaps WHERE status='SUCCESS' AND (lower(source_chain)='zec')<>(lower(dest_chain)='zec');
RESET ROLE;
REVOKE ALL ON ask_public.daily_v2,ask_public.blocks_v2,ask_public.transactions_v2,ask_public.flows_v2,ask_public.swaps_v2 FROM PUBLIC;
GRANT SELECT ON ask_public.daily_v2,ask_public.blocks_v2,ask_public.transactions_v2,ask_public.flows_v2,ask_public.swaps_v2 TO ask_analytics_reader;
COMMIT;
