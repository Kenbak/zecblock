'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('pgsql-parser');
const { compileResearchSQL } = require('../../v1/lib/ask-research-sql');
const { stockSumDiagnostics } = require('../../v1/lib/ask-research-stock-sum');
const { draftDiagnostics } = require('../../v1/lib/ask-research-plan-quality');

// The checks run on compiled SQL, where daily becomes analytics_public.daily_query.
async function issues(sql) {
  const compiled = await compileResearchSQL({ version: 3, sql, limit: 100 }, { extended: true });
  return stockSumDiagnostics(await parse(compiled.request.sql));
}

test('summing a daily pool balance across days is flagged', async () => {
  // The agent comparison's "is sapling dying" draft.
  const [issue] = await issues("SELECT CASE WHEN date >= DATE '2026-09-30' THEN 'latest' ELSE 'previous' END AS period, sum(sapling) AS sapling_transactions FROM daily WHERE date >= DATE '2026-08-31' AND date < DATE '2026-10-30' GROUP BY 1");
  assert.match(issue, /daily\.sapling is an end-of-day pool balance/);
  assert.equal((await issues("SELECT sum(orchard + ironwood) FROM daily WHERE date >= DATE '2026-10-01'")).length, 2, 'one finding per pool');
  assert.equal((await issues("WITH d AS (SELECT date, ironwood FROM daily WHERE date >= DATE '2026-10-01') SELECT sum(ironwood) FROM d")).length, 1);
});

test('balances read correctly are not flagged', async () => {
  for (const sql of [
    "SELECT date, orchard FROM daily WHERE date >= DATE '2026-09-30' ORDER BY date",
    "SELECT max(orchard), min(orchard), avg(orchard) FROM daily WHERE date >= DATE '2026-01-01'",
    "SELECT date, sum(orchard) FROM daily WHERE date >= DATE '2026-10-01' GROUP BY date",
    "SELECT orchard + ironwood + sapling + sprout AS shielded FROM daily ORDER BY date DESC LIMIT 1",
    "SELECT sum(shielded_transactions) FROM daily WHERE date >= DATE '2026-10-01'",
    "SELECT sum(balance) FROM addresses",
    "SELECT count(*) FILTER (WHERE sapling) FROM transactions WHERE timestamp >= 1790000000",
    "SELECT date, orchard - lag(orchard) OVER (ORDER BY date) AS change FROM daily WHERE date >= DATE '2026-10-01'",
  ]) assert.deepEqual(await issues(sql), [], sql);
});

test('the finding reaches draft review, so the agent sees it and repairs', async () => {
  const compiled = await compileResearchSQL({ version: 3, sql: "SELECT sum(sapling) AS total FROM daily WHERE date >= DATE '2026-09-30'", limit: 100 }, { extended: true });
  assert.ok((await draftDiagnostics(compiled.request.sql, { extended: true, question: 'is sapling dying?' })).some(issue => /end-of-day pool balance/.test(issue)));
});
