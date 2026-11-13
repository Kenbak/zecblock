BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30min';
SET LOCAL max_parallel_workers_per_gather = 0;
-- One line per canonical block with a summary of each transaction, in block
-- order: fields joined with \x1f, transactions with \x1e (see parse_block_line).
COPY (
  SELECT b.height, b.hash, b.previous_block_hash, b.timestamp, b.version, b.merkle_root, b.final_sapling_root,
         b.final_orchard_root, b.final_ironwood_root, b.bits, b.nonce, b.difficulty, b.size, b.transaction_count,
         b.total_fees, b.miner_address,
         (SELECT string_agg(concat_ws(chr(31), t.txid,
                   CASE WHEN t.is_coinbase THEN 't' ELSE 'f' END, CASE WHEN t.has_sapling THEN 't' ELSE 'f' END,
                   CASE WHEN t.has_orchard THEN 't' ELSE 'f' END, CASE WHEN t.has_ironwood THEN 't' ELSE 'f' END,
                   CASE WHEN t.has_sprout THEN 't' ELSE 'f' END,
                   coalesce(t.fee::text, ''), coalesce(t.total_output::text, ''), coalesce(t.vin_count::text, ''),
                   coalesce(t.vout_count::text, ''), coalesce(t.sapling_spend_count::text, ''), coalesce(t.sapling_output_count::text, ''),
                   coalesce(t.orchard_actions::text, ''), coalesce(t.ironwood_actions::text, ''),
                   coalesce(t.value_balance_sapling::text, ''), coalesce(t.value_balance_orchard::text, ''),
                   coalesce(t.value_balance_ironwood::text, ''),
                   coalesce((SELECT i.address FROM transaction_inputs i WHERE i.txid = t.txid AND i.address IS NOT NULL ORDER BY i.vout_index LIMIT 1), ''),
                   coalesce((SELECT o.address FROM transaction_outputs o WHERE o.txid = t.txid AND o.address IS NOT NULL ORDER BY o.vout_index LIMIT 1), '')),
                 chr(30) ORDER BY t.tx_index)
            FROM transactions t WHERE t.block_height = b.height AND t.block_hash = b.hash)
    FROM blocks b
   WHERE b.height BETWEEN :a AND :b
   ORDER BY b.height
) TO STDOUT;
COMMIT;
