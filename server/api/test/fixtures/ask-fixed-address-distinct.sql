WITH
bounded_activity AS (SELECT
  address,
  txid,
  "timestamp"
FROM analytics_public.address_activity_query AS address_activity
WHERE
  "timestamp" >= CAST(EXTRACT(EPOCH FROM '2026-09-01 00:00:00+00'::timestamptz) AS bigint)
  AND "timestamp" < CAST(EXTRACT(EPOCH FROM '2026-10-01 00:00:00+00'::timestamptz) AS bigint)),
daily_counts AS (SELECT
  pg_catalog.to_char(pg_catalog.to_timestamp("timestamp"), 'YYYY-MM-DD') AS utc_date,
  pg_catalog.count(DISTINCT address) AS distinct_active_transparent_addresses,
  pg_catalog.count(*) AS address_transaction_incidences
FROM bounded_activity
GROUP BY
  pg_catalog.to_char(pg_catalog.to_timestamp("timestamp"), 'YYYY-MM-DD'))
SELECT
  utc_date,
  distinct_active_transparent_addresses,
  address_transaction_incidences,
  pg_catalog.max(address_transaction_incidences) OVER () AS most_daily_incidences
FROM daily_counts
ORDER BY
  utc_date
