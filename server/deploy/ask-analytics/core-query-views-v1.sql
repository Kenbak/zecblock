BEGIN; SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='3s';
DO $$BEGIN IF current_database()<>'ask_analytics' OR pg_is_in_recovery() OR NOT EXISTS(SELECT FROM analytics_meta.admission_control WHERE singleton) THEN RAISE EXCEPTION 'Dedicated admission store required'; END IF; END$$;
SET LOCAL ROLE ask_public_view_owner;
CREATE OR REPLACE VIEW analytics_public.blocks_query WITH(security_barrier=true) AS SELECT b.height,b.hash,b.timestamp,b.miner_address AS miner,b.transaction_count AS transactions,b.size AS bytes,b.total_fees AS fees FROM public.blocks b CROSS JOIN analytics_public.coverage c WHERE c.ready AND b.height BETWEEN c.covered_from AND c.covered_through;
-- Admission verifies canonical transaction/flow identity atomically. Avoid
-- redundant joins over the entire chain, which spill even for small windows.
-- The optional miner join is removable by PostgreSQL when miner is not used.
CREATE OR REPLACE VIEW analytics_public.transactions_query WITH(security_barrier=true) AS SELECT t.txid,t.block_height AS height,t.block_time AS timestamp,b.miner_address AS miner,(t.has_sapling OR t.has_orchard OR t.has_ironwood OR t.has_sprout) AS shielded,t.has_orchard AS orchard,t.has_ironwood AS ironwood,t.has_sapling AS sapling,t.size AS bytes,t.fee AS fees FROM public.transactions t CROSS JOIN analytics_public.coverage c LEFT JOIN public.blocks b ON b.height=t.block_height WHERE c.ready AND t.block_height BETWEEN c.covered_from AND c.covered_through AND t.is_coinbase=false;
CREATE OR REPLACE VIEW analytics_public.flows_query WITH(security_barrier=true) AS SELECT f.txid,f.block_height AS height,f.block_time AS timestamp,f.flow_type AS direction,f.pool,f.amount_zat AS amount FROM public.shielded_flows f CROSS JOIN analytics_public.coverage c WHERE c.ready AND f.block_height BETWEEN c.covered_from AND c.covered_through;
RESET ROLE; COMMIT;
