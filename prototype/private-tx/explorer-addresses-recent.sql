BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '20min';
SET LOCAL max_parallel_workers_per_gather = 0;
-- Address activity in canonical blocks after the base tip (:a .. :b), found
-- through the transactions of those blocks, ordered by address.
COPY (
  SELECT at.address, at.txid, at.block_height, at.tx_index, at.block_time, at.value_in, at.value_out
    FROM transactions t
    JOIN blocks b ON b.height = t.block_height AND b.hash = t.block_hash
    JOIN address_transactions at ON at.txid = t.txid
   WHERE t.block_height BETWEEN :a AND :b
   ORDER BY at.address, at.block_height, at.tx_index, at.txid
) TO STDOUT;
COMMIT;
