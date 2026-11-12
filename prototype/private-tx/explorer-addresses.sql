BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60min';
SET LOCAL max_parallel_workers_per_gather = 0;
-- Transparent address history up to the base tip, for addresses in
-- [:lo, :hi) under the database collation, ordered by address (primary key
-- order) so the encoder sees each address's rows together.
COPY (
  SELECT address, txid, block_height, tx_index, block_time, value_in, value_out
    FROM address_transactions
   WHERE address >= :lo AND address < :hi AND block_height BETWEEN :a AND :b
   ORDER BY address, block_height, tx_index, txid
) TO STDOUT;
COMMIT;
