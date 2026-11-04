'use strict';
// Draft-quality regressions only. No database, provider or network is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const { draftDiagnostics, compileResearchDraft } = require('../../v1/lib/ask-research-plan-quality');
const { compileResearchSQL } = require('../../v1/lib/ask-research-sql');

const options = { extended: true };
const question = 'Compare monthly shielded transaction counts during 2025 and explain the largest absolute month-to-month change.';
const monthly = "monthly AS (SELECT date_trunc('month',date::timestamp)::date AS month,sum(shielded_transactions) AS shielded_transactions FROM activity_daily WHERE date>=DATE '2025-01-01' AND date<DATE '2026-01-01' GROUP BY 1)";
const changes = 'monthly_changes AS (SELECT month,shielded_transactions,shielded_transactions-lag(shielded_transactions) OVER(ORDER BY month) AS month_change FROM monthly)';
const ranked = (rank = 'row_number', order = 'abs(month_change) DESC', source = 'monthly_changes', filter = '') => `ranked_changes AS (SELECT month,shielded_transactions,month_change,${rank}() OVER(ORDER BY ${order}) AS change_rank FROM ${source} ${filter})`;
const query = (ranking = ranked(), extra = '') => `WITH ${monthly},${changes}${extra ? ',' + extra : ''},${ranking} SELECT month,shielded_transactions,CASE WHEN change_rank=1 THEN month_change END AS largest_change FROM ranked_changes ORDER BY month`;
const broken = query();
const fixed = query(ranked('row_number', 'abs(month_change) DESC NULLS LAST'));
const signal = /NULLS LAST/;

for (const rank of ['row_number', 'rank', 'dense_rank']) {
  test('diagnoses implicit DESC null ordering of lag-derived changes with ' + rank, async () => {
    const sql = query(ranked(rank));
    assert.match((await draftDiagnostics(sql, options)).join('\n'), signal);
    const compiled = await compileResearchSQL({ version: 3, sql, limit: 100 }, options);
    assert.match((await draftDiagnostics(compiled.request.sql, options)).join('\n'), signal, 'canonical qualified SQL retains the same proven lineage');
  });
}

for (const [name, sql] of [
  ['derived source and numeric cast', 'SELECT d.height,row_number() OVER(ORDER BY abs(d.delta)::numeric DESC) AS change_rank FROM (SELECT height,fees-lag(fees) OVER(ORDER BY height) AS delta FROM blocks) d'],
  ['aliased CTE projection', 'WITH changes AS (SELECT height,fees-lag(fees) OVER(ORDER BY height) AS delta FROM blocks), renamed AS (SELECT height,delta AS renamed_delta FROM changes) SELECT height,row_number() OVER(ORDER BY abs(renamed_delta) DESC) AS change_rank FROM renamed'],
  ['CTE column-alias list over an unnamed expression', 'WITH changes(h,d) AS (SELECT height,fees-lag(fees) OVER(ORDER BY height) FROM blocks) SELECT rank() OVER(ORDER BY abs(d) DESC) FROM changes'],
  ['lead boundary', 'WITH changes AS (SELECT height,lead(fees) OVER(ORDER BY height)-fees AS delta FROM blocks) SELECT height,dense_rank() OVER(ORDER BY abs(delta) DESC) AS change_rank FROM changes'],
]) {
  test('follows simple nullable ranking lineage through ' + name, async () => {
    assert.match((await draftDiagnostics(sql, options)).join('\n'), signal);
  });
}

for (const [name, sql] of [
  ['explicit NULLS LAST', fixed],
  ['explicit NULLS FIRST', query(ranked('row_number', 'abs(month_change) DESC NULLS FIRST'))],
  ['ascending order', query(ranked('row_number', 'abs(month_change) ASC'))],
  ['default ascending direction', query(ranked('row_number', 'abs(month_change)'))],
  ['same-level matching null exclusion', query(ranked('row_number', 'abs(month_change) DESC', 'monthly_changes', 'WHERE month_change IS NOT NULL'))],
  ['upstream matching null exclusion', query(ranked('row_number', 'abs(month_change) DESC', 'known_changes'), 'known_changes AS (SELECT month,shielded_transactions,month_change FROM monthly_changes WHERE month_change IS NOT NULL)')],
  ['non-null default for lag boundary', 'WITH changes AS (SELECT height,height-lag(height,1,0) OVER(ORDER BY height) AS delta FROM blocks) SELECT row_number() OVER(ORDER BY abs(delta) DESC) AS change_rank FROM changes'],
  ['zero lag offset', 'WITH changes AS (SELECT height,height-lag(height,0) OVER(ORDER BY height) AS delta FROM blocks) SELECT row_number() OVER(ORDER BY abs(delta) DESC) AS change_rank FROM changes'],
  ['unresolved dynamic lag offset', 'WITH changes AS (SELECT height,fees-lag(fees,height) OVER(ORDER BY height) AS delta FROM blocks) SELECT row_number() OVER(ORDER BY abs(delta) DESC) AS change_rank FROM changes'],
  ['nullable secondary sort only', query(ranked('row_number', 'month DESC,abs(month_change) DESC'))],
  ['count-based nonnullable ranking', 'WITH counts AS (SELECT height,count(*) AS transactions FROM transactions GROUP BY height) SELECT height,row_number() OVER(ORDER BY transactions DESC) AS count_rank FROM counts'],
  ['unresolved direct column', 'SELECT height,row_number() OVER(ORDER BY fees DESC) AS fee_rank FROM blocks'],
  ['unresolved join lineage', 'WITH changes AS (SELECT height,fees-lag(fees) OVER(ORDER BY height) AS delta FROM blocks) SELECT a.height,row_number() OVER(ORDER BY a.delta DESC) AS change_rank FROM changes a JOIN blocks b ON b.height=a.height'],
  ['unresolved set-operation lineage', 'WITH changes AS (SELECT height,fees-lag(fees) OVER(ORDER BY height) AS delta FROM blocks UNION ALL SELECT height,fees AS delta FROM transactions) SELECT height,row_number() OVER(ORDER BY delta DESC) AS change_rank FROM changes'],
]) {
  test('preserves intentional or unresolved ranking: ' + name, async () => {
    assert.deepEqual(await draftDiagnostics(sql, options), []);
    await compileResearchSQL({ version: 3, sql, limit: 100 }, options);
  });
}

test('a different null filter does not establish that the ranking input excludes nullable changes', async () => {
  assert.match((await draftDiagnostics(query(ranked('row_number', 'abs(month_change) DESC', 'monthly_changes', 'WHERE shielded_transactions IS NOT NULL')), options)).join('\n'), signal);
  assert.match((await draftDiagnostics(query(ranked('row_number', 'abs(month_change) DESC', 'monthly_changes', 'WHERE month_change IS NOT NULL OR shielded_transactions>0')), options)).join('\n'), signal);
});

test('the diagnosed draft remains valid direct SQL and gets at most one model repair', async () => {
  await compileResearchSQL({ version: 3, sql: broken, limit: 100 }, options);
  let calls = 0;
  const repaired = await compileResearchDraft(broken, { question }, async (input, task) => {
    calls++;
    assert.equal(task.name, 'research_sql');
    assert.equal(input.sql, broken);
    assert.equal(input.question, question);
    assert.match(input.diagnostics.join('\n'), signal);
    return { sql: fixed };
  }, options);
  assert.equal(calls, 1);
  assert.match(repaired.sql, /NULLS LAST/);
  assert.match(repaired.sql, /2025-01-01/);
  assert.match(repaired.sql, /2026-01-01/);
  calls = 0;
  await assert.rejects(compileResearchDraft(broken, { question }, async () => { calls++; return { sql: broken }; }, options), error => error.askKind === 'answer');
  assert.equal(calls, 1);
  await compileResearchDraft(fixed, { question }, () => assert.fail('An intentional ranking must not spend on a repair'), options);
});
