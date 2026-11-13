BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '20min';
SET LOCAL max_parallel_workers_per_gather = 0;
COPY (
  SELECT t.txid, t.block_height, t.tx_index, t.block_hash, t.block_time, t.size, t.version, t.locktime,
         t.expiry_height, t.fee, t.total_input, t.total_output, t.value_balance, t.value_balance_sapling,
         t.value_balance_orchard, t.value_balance_ironwood, t.is_coinbase, t.has_sapling, t.has_orchard,
         t.has_ironwood, t.has_sprout, t.orchard_actions, t.ironwood_actions, t.sapling_spend_count,
         t.sapling_output_count, t.vin_count, t.vout_count, t.orchard_anchor,
         (SELECT string_agg(i.vout_index || chr(31) || coalesce(i.prev_txid, '') || chr(31) || coalesce(i.prev_vout::text, '')
                 || chr(31) || coalesce(i.address, '') || chr(31) || coalesce(i.value::text, '') || chr(31) || coalesce(i.coinbase, ''),
                 chr(30) ORDER BY i.vout_index)
            FROM transaction_inputs i WHERE i.txid = t.txid),
         (SELECT string_agg(o.vout_index || chr(31) || coalesce(o.value::text, '') || chr(31) || coalesce(o.address, '')
                 || chr(31) || CASE WHEN o.spent THEN '1' ELSE '0' END, chr(30) ORDER BY o.vout_index)
            FROM transaction_outputs o WHERE o.txid = t.txid)
    FROM transactions t
    JOIN blocks b ON b.height = t.block_height AND b.hash = t.block_hash
   WHERE t.block_height BETWEEN :a AND :b
   ORDER BY t.block_height, t.tx_index
) TO STDOUT;
COMMIT;
