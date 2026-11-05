\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication WHERE pubname='ask_public_core_v1' AND NOT puballtables)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ask_core_replicator' AND rolreplication AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole)
 THEN RAISE EXCEPTION 'Existing reviewed mainnet source feed required'; END IF;
END$$;
GRANT SELECT(id,date,shielded_count,transparent_count,orchard_pool_size,ironwood_pool_size,sapling_pool_size,sprout_pool_size) ON public.privacy_trends_daily TO ask_core_replicator;
GRANT SELECT(id,status,source_chain,source_token,source_amount_usd,dest_chain,dest_token,dest_amount_usd,swap_created_at) ON public.cross_chain_swaps TO ask_core_replicator;
GRANT SELECT(address,balance,total_received,total_sent,tx_count,first_seen,last_seen,address_type) ON public.addresses TO ask_core_replicator;
GRANT SELECT(address,txid,block_height,tx_index,block_time,is_input,is_output,value_in,value_out) ON public.address_transactions TO ask_core_replicator;
ALTER PUBLICATION ask_public_core_v1 ADD TABLE
 public.privacy_trends_daily(id,date,shielded_count,transparent_count,orchard_pool_size,ironwood_pool_size,sapling_pool_size,sprout_pool_size),
 public.cross_chain_swaps(id,status,source_chain,source_token,source_amount_usd,dest_chain,dest_token,dest_amount_usd,swap_created_at),
 public.addresses(address,balance,total_received,total_sent,tx_count,first_seen,last_seen,address_type) WHERE (address LIKE 't1%' OR address LIKE 't3%'),
 public.address_transactions(address,txid,block_height,tx_index,block_time,is_input,is_output,value_in,value_out) WHERE (address LIKE 't1%' OR address LIKE 't3%');
COMMIT;
