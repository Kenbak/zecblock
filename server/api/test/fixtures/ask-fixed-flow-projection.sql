WITH
september_flows AS (SELECT
  pool,
  direction,
  amount
FROM analytics_public.flow_daily_query AS flow_daily
WHERE
  date >= '2026-09-01'::date
  AND date < '2026-10-01'::date),
  totals AS (SELECT
    pool,
    direction,
    pg_catalog.sum(records) AS boundary_records,
    pg_catalog.sum(missing_amounts) AS missing_amounts,
    CASE
      WHEN pg_catalog.sum(missing_amounts) > 0 THEN NULL
      ELSE pg_catalog.sum(amount)
    END AS total_zatoshis
  FROM september_flows
  GROUP BY
    pool,
    direction),
  ranked_results AS (SELECT
    pool,
    direction,
    boundary_records,
    missing_amounts,
    total_zatoshis,
    pg_catalog.row_number() OVER (ORDER BY boundary_records DESC NULLS LAST) AS record_rank
  FROM totals)
SELECT
  pool,
  direction,
  boundary_records,
  missing_amounts,
  total_zatoshis / 100000000.0 AS total_zec,
  CASE
    WHEN record_rank = 1 THEN true
    ELSE false
  END AS most_boundary_records
FROM ranked_results
ORDER BY
  boundary_records DESC NULLS LAST,
  pool,
  direction
