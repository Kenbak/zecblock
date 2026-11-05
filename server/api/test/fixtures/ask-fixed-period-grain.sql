SELECT
  date,
  transactions AS total_non_coinbase_transactions,
  shielded_transactions,
  transparent_transactions,
  unclassified_transactions,
  pg_catalog.round((100.0 * shielded_transactions) / (NULLIF (transactions, 0)), 2) AS shielded_pct_of_all_transactions
FROM analytics_public.activity_daily_query AS activity_daily
WHERE
  date >= '2026-09-01'::date
  AND date < '2026-10-01'::date
ORDER BY
  date
