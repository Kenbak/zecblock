-- Reviewed correction for an already provisioned v2 view. No source-row changes.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
SET LOCAL ROLE ask_analytics_owner;
CREATE OR REPLACE VIEW ask_public.swaps_v2 WITH (security_barrier=true) AS SELECT swap_created_at AS timestamp,
 CASE WHEN lower(dest_chain)='zec' THEN 'inflow' ELSE 'outflow' END AS direction,
 CASE WHEN lower(dest_chain)='zec' THEN source_chain ELSE dest_chain END AS chain,
 CASE WHEN lower(dest_chain)='zec' THEN source_token ELSE dest_token END AS token,
 NULLIF(CASE WHEN lower(dest_chain)='zec' THEN source_amount_usd ELSE dest_amount_usd END,0) AS usd
 FROM public.cross_chain_swaps WHERE status='SUCCESS' AND (lower(source_chain)='zec')<>(lower(dest_chain)='zec');
RESET ROLE;
COMMIT;
