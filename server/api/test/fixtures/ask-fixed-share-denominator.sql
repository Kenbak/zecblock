WITH
dated_activity AS (SELECT
  date,
  shielded_transactions,
  transparent_transactions
FROM analytics_public.activity_daily_query AS activity_daily
WHERE
  date >= '2026-08-02'::date
  AND date < '2026-10-01'::date),
  rolling_baselines AS (SELECT
    date,
    shielded_transactions,
    transparent_transactions,
    pg_catalog.count(*) OVER (
      ORDER BY date
      ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS prior_observations,
    pg_catalog.avg(shielded_transactions) OVER (
      ORDER BY date
      ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS preceding_average
  FROM dated_activity),
september_results AS (SELECT
  date,
  shielded_transactions,
  transparent_transactions,
  preceding_average,
  pg_catalog.round(((shielded_transactions - preceding_average) * 100.0) / (NULLIF (preceding_average, 0)), 2) AS percent_above_baseline,
  pg_catalog.round((shielded_transactions * 100.0) / (NULLIF (shielded_transactions + transparent_transactions, 0)), 2) AS shielded_share_percent
FROM rolling_baselines
WHERE
  date >= '2026-09-01'::date
  AND date < '2026-10-01'::date
  AND prior_observations = 30)
SELECT
  date,
  shielded_transactions AS shielded_count,
  pg_catalog.round(preceding_average, 2) AS preceding_30_day_average,
  percent_above_baseline,
  shielded_share_percent
FROM september_results
ORDER BY
  percent_above_baseline DESC NULLS LAST,
  date
LIMIT 10
