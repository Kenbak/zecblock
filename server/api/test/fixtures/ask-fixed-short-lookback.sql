WITH
daily_counts AS (SELECT
  date,
  shielded_transactions,
  transactions
FROM analytics_public.activity_daily_query AS activity_daily
WHERE
  date >= '2026-09-01'::date
  AND date < '2026-10-01'::date),
  with_baseline AS (SELECT
    date,
    shielded_transactions,
    transactions,
    pg_catalog.avg(shielded_transactions) OVER (
      ORDER BY date
      ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS preceding_average,
    pg_catalog.count(*) OVER (
      ORDER BY date
      ROWS BETWEEN 30 PRECEDING AND 1 PRECEDING
    ) AS preceding_observations
  FROM daily_counts),
  ranked_results AS (SELECT
    date,
    shielded_transactions,
    transactions,
    preceding_average,
    ((shielded_transactions - preceding_average) * 100.0) / (NULLIF (preceding_average, 0)) AS percentage_above_baseline,
    (shielded_transactions * 100.0) / (NULLIF (transactions, 0)) AS shielded_share
  FROM with_baseline
  WHERE
    preceding_observations = 30
  ORDER BY
    percentage_above_baseline DESC NULLS LAST
  LIMIT 10)
SELECT
  date,
  shielded_transactions,
  pg_catalog.round(preceding_average, 2) AS preceding_30_day_average,
  pg_catalog.round(percentage_above_baseline, 2) AS percentage_above_baseline,
  pg_catalog.round(shielded_share, 2) AS shielded_share_of_all_transactions
FROM ranked_results
ORDER BY
  percentage_above_baseline DESC NULLS LAST
