\set ON_ERROR_STOP on
-- Mainnet publisher: adds the ZEC-side amounts of NEAR Intents swaps and the
-- Maya/THORChain venue actions to the reviewed feed, reviewed columns only. Real
-- production metadata change; owner approval only. Apply swaps-v1.sql on the
-- analytics store FIRST. Deposit addresses, memos, senders, recipients, every tx
-- hash, matching state and provider payloads stay private. No source rows,
-- writers or API change. Rollback: swaps-source-v1-rollback.sql.
-- PostgreSQL has no per-table column-list ALTER: cross_chain_swaps is dropped and
-- re-added in this one transaction, so the subscriber never sees it unpublished
-- and REFRESH does not re-copy it. Rows already copied keep NULL amounts until
-- the swaps.md backfill.
BEGIN;
SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='5s';
DO $$BEGIN
 IF current_database()<>'zcash_explorer_mainnet' OR pg_is_in_recovery()
 OR NOT EXISTS(SELECT FROM pg_publication WHERE pubname='ask_public_core_v1' AND NOT puballtables)
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='ask_core_replicator' AND rolreplication AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole)
 OR to_regclass('public.crosschain_venue_actions') IS NULL
 OR (SELECT attnames FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename='cross_chain_swaps')
    IS DISTINCT FROM ARRAY['id','status','source_chain','source_token','source_amount_usd','dest_chain','dest_token','dest_amount_usd','swap_created_at']::name[]
 OR EXISTS(SELECT FROM pg_publication_tables WHERE pubname='ask_public_core_v1' AND schemaname='public' AND tablename='crosschain_venue_actions')
 THEN RAISE EXCEPTION 'Existing reviewed mainnet source feed with the original swap columns required'; END IF;
END$$;
GRANT SELECT(source_amount,dest_amount) ON public.cross_chain_swaps TO ask_core_replicator;
GRANT SELECT(venue,id,action_type,status,swap_created_at,source_chain,source_token,dest_chain,dest_token,zec_amount_zat,source_amount_usd,dest_amount_usd) ON public.crosschain_venue_actions TO ask_core_replicator;
ALTER PUBLICATION ask_public_core_v1 DROP TABLE public.cross_chain_swaps;
ALTER PUBLICATION ask_public_core_v1 ADD TABLE
 public.cross_chain_swaps(id,status,source_chain,source_token,source_amount_usd,dest_chain,dest_token,dest_amount_usd,swap_created_at,source_amount,dest_amount),
 public.crosschain_venue_actions(venue,id,action_type,status,swap_created_at,source_chain,source_token,dest_chain,dest_token,zec_amount_zat,source_amount_usd,dest_amount_usd);
COMMIT;
