'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parse } = require('pgsql-parser');
const { poolQuestionDiagnostics, futureWindowDiagnostics, columnDiagnostics } = require('../../v1/lib/ask-research-question-scope');
const { compileResearchSQL } = require('../../v1/lib/ask-research-sql');
const labels = require('../../../../lib/ask/address-labels.json');

const now = new Date('2026-10-29T12:00:00Z');

test('an Orchard question answered from all shielded activity is sent back', async () => {
  const tree = await parse("SELECT sum(shielded_transactions)::numeric / sum(transactions) AS orchard_share FROM activity_daily WHERE date >= DATE '2026-10-01'");
  assert.equal(poolQuestionDiagnostics(tree, 'What share of transactions used Orchard last week?').length, 1);
  const good = await parse("SELECT count(*) FILTER (WHERE orchard)::numeric / count(*) AS share FROM transactions WHERE timestamp >= 1");
  assert.deepEqual(poolQuestionDiagnostics(good, 'What share of transactions used Orchard last week?'), []);
  assert.deepEqual(poolQuestionDiagnostics(tree, 'What share of transactions were shielded?'), []);
});

test('"last N days" cannot end after today, but current periods may', async () => {
  const tree = await parse("SELECT count(*) FROM transactions WHERE timestamp >= EXTRACT(EPOCH FROM DATE '2026-10-22')::bigint AND timestamp < EXTRACT(EPOCH FROM DATE '2026-10-30')::bigint");
  assert.equal(futureWindowDiagnostics(tree, 'Transactions in the last 7 days', now).length, 1);
  assert.deepEqual(futureWindowDiagnostics(tree, 'Transactions this month so far', now), []);
  const bounded = await parse("SELECT count(*) FROM transactions WHERE timestamp < EXTRACT(EPOCH FROM DATE '2026-10-29')::bigint");
  assert.deepEqual(futureWindowDiagnostics(bounded, 'Transactions in the last 7 days', now), []);
});

test('labels is an inlined reviewed table that keeps its name in canonical SQL', async () => {
  const sql = "SELECT sum(a.balance) AS gemini FROM addresses a JOIN labels l ON l.address = a.address WHERE l.label ILIKE 'Gemini%'";
  const compiled = await compileResearchSQL({ version: 3, sql }, { extended: true });
  assert.deepEqual(compiled.datasets, ['addresses', 'labels']);
  assert.match(compiled.request.sql, /JOIN labels AS l/);
  assert.doesNotMatch(compiled.request.sql, /VALUES/);
  assert.match(compiled.text, /\( VALUES/);
  for (const label of labels.labels) assert.ok(compiled.text.includes(label.address));
  const again = await compileResearchSQL({ version: 3, sql: compiled.request.sql }, { extended: true });
  assert.equal(again.fingerprint, compiled.fingerprint);
  assert.equal(again.text, compiled.text);
});

test('labels is reserved and only available with the extended catalogue', async () => {
  await assert.rejects(compileResearchSQL({ version: 3, sql: 'SELECT * FROM labels' }), /not admitted/);
  await assert.rejects(compileResearchSQL({ version: 3, sql: 'WITH labels AS (SELECT 1) SELECT * FROM blocks' }, { extended: true }), /Invalid CTE name/);
  await assert.rejects(compileResearchSQL({ version: 3, sql: 'SELECT * FROM labels AS l(a, b, c, d)' }, { extended: true }), /Invalid alias/);
  const scoped = await compileResearchSQL({ version: 3, sql: 'WITH x AS (SELECT height FROM blocks) SELECT * FROM x' }, { extended: true });
  assert.deepEqual(scoped.datasets, ['blocks']);
});

test('columns no catalogue source provides are sent back before execution', async () => {
  const [issue] = columnDiagnostics(await parse("SELECT count(*) FILTER (WHERE orchard) FROM activity_daily WHERE date >= DATE '2026-10-22'"));
  assert.match(issue, /Column orchard does not exist in activity_daily/);
  assert.match(issue, /FILTER \(WHERE orchard\) on transactions/);
  assert.equal(columnDiagnostics(await parse('SELECT t.bogus FROM transactions t')).length, 1);
  for (const sql of [
    'SELECT count(*) FILTER (WHERE t.orchard) AS o, b.height FROM transactions t JOIN blocks b ON b.height = t.height GROUP BY b.height ORDER BY o',
    'WITH x AS (SELECT orchard FROM transactions) SELECT orchard FROM x',
    'SELECT a.balance, l.label FROM addresses a LEFT JOIN labels l ON l.address = a.address WHERE l.address IS NULL',
    'SELECT date, (SELECT count(*) FROM transactions t WHERE t.timestamp >= extract(epoch FROM d.date)) FROM daily d',
    "SELECT to_char(to_timestamp(timestamp), 'YYYY-MM') AS month, count(*) FROM transactions GROUP BY month ORDER BY month",
  ]) assert.deepEqual(columnDiagnostics(await parse(sql)), [], sql);
});
