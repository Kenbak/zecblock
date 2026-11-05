'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parse } = require('pgsql-parser');
const { poolLabelDiagnostics } = require('../../v1/lib/ask-research-pool-labels');
const { draftDiagnostics } = require('../../v1/lib/ask-research-plan-quality');
const { compileResearchSQL } = require('../../v1/lib/ask-research-sql');

// The AI-drafted SQL observed on protected staging for "How has the share of
// transactions using Orchard changed month by month?": all shielded counts
// relabelled as Orchard.
const staged = `WITH monthly_counts AS (SELECT date_trunc('month', date::timestamp) AS month, sum(shielded_transactions) AS shielded_transactions, sum(transactions) AS transactions FROM activity_daily WHERE date >= '2026-04-01'::date AND date < '2026-10-01'::date GROUP BY date_trunc('month', date::timestamp)) SELECT month, shielded_transactions AS orchard_transactions, transactions AS all_transactions, round((100.0 * shielded_transactions) / (NULLIF (transactions, 0)), 2) AS orchard_share_percent FROM monthly_counts ORDER BY month`;
const issues = async sql => poolLabelDiagnostics(await parse(sql));

test('a pool-named column computed from other data is flagged with a repair hint', async () => {
  const found = await issues(staged);
  assert.equal(found.length, 2);
  assert.match(found[0], /orchard_transactions is labelled orchard/);
  assert.match(found[0], /count\(\*\) FILTER \(WHERE orchard\)/);
  assert.match(found[1], /orchard_share_percent/);
  assert.equal((await issues('SELECT sum(amount) AS ironwood_inflow FROM flows')).length, 1);
});

test('pool-named columns backed by that pool pass', async () => {
  for (const sql of [
    "SELECT date_trunc('month', to_timestamp(timestamp)) AS month, count(*) FILTER (WHERE orchard) AS orchard_txs, round(100.0*count(*) FILTER (WHERE orchard)/count(*),2) AS orchard_share_pct FROM transactions GROUP BY 1",
    'SELECT date, orchard::numeric/100000000 AS orchard_zec FROM daily',
    "SELECT sum(amount) AS orchard_shielded FROM flows WHERE pool = 'orchard' AND direction = 'shield'",
    "SELECT sum(amount) FILTER (WHERE pool = 'ironwood') AS ironwood_zec FROM flows",
    'WITH o AS (SELECT count(*) AS n FROM transactions WHERE orchard) SELECT n AS orchard_count FROM o',
    'WITH m AS (SELECT count(*) FILTER (WHERE orchard) AS orchard_n, count(*) AS total FROM transactions) SELECT orchard_n AS orchard_transactions, round(100.0*orchard_n/total,2) AS orchard_share FROM m',
    'SELECT count(*) AS transactions FROM transactions',
  ]) assert.deepEqual(await issues(sql), [], sql);
});

test('the draft quality gate sends the staged Orchard relabel back for repair', async () => {
  const compiled = await compileResearchSQL({ version: 3, sql: staged, limit: 100 }, { extended: true });
  const found = await draftDiagnostics(compiled.request.sql, { extended: true, question: 'How has the share of transactions using Orchard changed month by month over the last 6 months?' });
  assert.ok(found.some(issue => /labelled orchard/.test(issue)));
});
