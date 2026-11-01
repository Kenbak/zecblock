\set ON_ERROR_STOP on
-- Reverses swaps-source-v1.sql only. Run before the destination rollback.
-- cross_chain_swaps returns to its original nine columns in one transaction.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename='crosschain_venue_actions')
 OR NOT EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename='cross_chain_swaps' AND 'source_amount'=ANY(attnames))
 THEN RAISE EXCEPTION 'Published swap detail required'; END IF;
END$$;
ALTER PUBLICATION ask_public_core_v1 DROP TABLE public.crosschain_venue_actions,public.cross_chain_swaps;
ALTER PUBLICATION ask_public_core_v1 ADD TABLE public.cross_chain_swaps(id,status,source_chain,source_token,source_amount_usd,dest_chain,dest_token,dest_amount_usd,swap_created_at);
REVOKE SELECT(source_amount,dest_amount) ON public.cross_chain_swaps FROM ask_core_replicator;
REVOKE SELECT(venue,id,action_type,status,swap_created_at,source_chain,source_token,dest_chain,dest_token,zec_amount_zat,source_amount_usd,dest_amount_usd) ON public.crosschain_venue_actions FROM ask_core_replicator;
COMMIT;
