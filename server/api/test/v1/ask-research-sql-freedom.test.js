'use strict';
// Compiler-only freedom/safety regressions. No database, provider or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileResearchSQL } = require('../../v1/lib/ask-research-sql');

const request = sql => ({ version: 3, sql, limit: 10 });
const supported = [
  {
    name: 'INTERSECT with independently bounded branches',
    sql: 'SELECT height FROM blocks WHERE height BETWEEN 1 AND 5 INTERSECT SELECT height FROM transactions WHERE height BETWEEN 1 AND 5',
    datasets: ['blocks', 'transactions'], features: [], syntax: /\bINTERSECT\b/,
  },
  {
    name: 'EXCEPT with independently bounded branches',
    sql: 'SELECT height FROM blocks WHERE height BETWEEN 1 AND 5 EXCEPT SELECT height FROM transactions WHERE height BETWEEN 1 AND 5',
    datasets: ['blocks', 'transactions'], features: [], syntax: /\bEXCEPT\b/,
  },
  {
    name: 'GROUPING SETS including the grand total',
    sql: 'SELECT height,miner,count(*) FROM blocks WHERE height BETWEEN 1 AND 5 GROUP BY GROUPING SETS ((height),(miner),())',
    datasets: ['blocks'], features: ['group'], syntax: /\bGROUPING SETS\b/,
  },
  {
    name: 'ROLLUP with grouping identifiers',
    sql: 'SELECT height,miner,count(*),grouping(height,miner) FROM blocks WHERE height BETWEEN 1 AND 5 GROUP BY ROLLUP(height,miner)',
    datasets: ['blocks'], features: ['group'], syntax: /\bROLLUP\b/,
  },
  {
    name: 'CUBE subtotals',
    sql: 'SELECT height,miner,count(*) FROM blocks WHERE height BETWEEN 1 AND 5 GROUP BY CUBE(height,miner)',
    datasets: ['blocks'], features: ['group'], syntax: /\bCUBE\b/,
  },
  {
    name: 'multiple nonrecursive CTEs with a join and window',
    sql: 'WITH candidates AS (SELECT height,fees FROM blocks WHERE height BETWEEN 1 AND 5), totals AS (SELECT height,count(*) AS n FROM transactions WHERE height BETWEEN 1 AND 5 GROUP BY height) SELECT b.height,b.fees,t.n,lag(b.fees) OVER(ORDER BY b.height) AS previous FROM candidates b LEFT JOIN totals t ON t.height=b.height',
    datasets: ['blocks', 'transactions'], features: ['cte', 'group', 'join', 'window'], syntax: /\bLEFT JOIN\b/,
  },
  {
    name: 'correlated scalar, ALL and EXISTS inside a CTE join',
    sql: 'WITH candidates AS (SELECT height FROM blocks WHERE height BETWEEN 1 AND 5), totals AS (SELECT height,count(*) AS n FROM transactions WHERE height BETWEEN 1 AND 5 GROUP BY height) SELECT b.height,t.n,(SELECT max(f.amount) FROM flows f WHERE f.height=b.height) AS max_amount FROM candidates b LEFT JOIN totals t ON t.height=b.height WHERE b.height >= ALL(SELECT t2.height FROM transactions t2 WHERE t2.height BETWEEN 1 AND 5) AND EXISTS(SELECT txid FROM flows f WHERE f.height=b.height)',
    datasets: ['blocks', 'flows', 'transactions'], features: ['cte', 'group', 'join'], syntax: /\bALL\s*\(/,
  },
];

for (const { name, sql, datasets, features, syntax } of supported) {
  test('preserves supported relational SQL: ' + name, async () => {
    const compiled = await compileResearchSQL(request(sql));
    assert.deepEqual(compiled.datasets, datasets);
    assert.deepEqual(compiled.features, features);
    assert.deepEqual(compiled.values, [11]);
    assert.match(compiled.request.sql, syntax);
    assert.match(compiled.text, /^SELECT \* FROM \(/);
    assert.deepEqual(await compileResearchSQL(compiled.request), compiled);
  });
}

const forbidden = [
  {
    name: 'unqualified regex ANY in an INTERSECT branch',
    sql: 'SELECT height FROM blocks INTERSECT SELECT height FROM transactions WHERE txid ~ ANY(SELECT hash FROM blocks)',
    reason: /Operator is not allowed/,
  },
  {
    name: 'ARRAY through EXISTS in an EXCEPT branch',
    sql: 'SELECT height FROM blocks EXCEPT SELECT height FROM transactions WHERE EXISTS(SELECT height FROM flows WHERE coalesce(ARRAY(SELECT height FROM blocks),NULL) IS NOT NULL)',
    reason: /Unsupported subquery/,
  },
  {
    name: 'qualified ANY in GROUPING SETS HAVING',
    sql: 'SELECT height,count(*) FROM blocks GROUP BY GROUPING SETS ((height),()) HAVING max(hash) OPERATOR(pg_catalog.=) ANY(SELECT txid FROM transactions)',
    reason: /Operator is not allowed/,
  },
  {
    name: 'scalar ARRAY under an allowed wrapper beside ROLLUP',
    sql: 'SELECT height,(SELECT coalesce(ARRAY(SELECT height FROM transactions),NULL)) AS heights,count(*) FROM blocks GROUP BY ROLLUP(height)',
    reason: /Unsupported subquery/,
  },
  {
    name: 'forbidden ALL operator through EXISTS beside CUBE',
    sql: 'SELECT height,count(*) FROM blocks WHERE EXISTS(SELECT height FROM transactions WHERE height ^ ALL(SELECT height FROM flows)) GROUP BY CUBE(height)',
    reason: /Operator is not allowed/,
  },
  {
    name: 'ARRAY in a scalar subquery inside multiple CTEs and a window join',
    sql: 'WITH candidates AS (SELECT height FROM blocks), totals AS (SELECT height,(SELECT coalesce(ARRAY(SELECT height FROM flows),NULL)) AS heights FROM transactions) SELECT b.height,row_number() OVER(ORDER BY b.height) AS position FROM candidates b JOIN totals t ON t.height=b.height',
    reason: /Unsupported subquery/,
  },
  {
    name: 'private relation through a scalar subquery inside a CTE window join',
    sql: 'WITH candidates AS (SELECT height FROM blocks), totals AS (SELECT height,(SELECT subconninfo FROM pg_subscription LIMIT 1) AS private_value FROM transactions) SELECT b.height,row_number() OVER(ORDER BY b.height) AS position FROM candidates b JOIN totals t ON t.height=b.height',
    reason: /Dataset pg_subscription is not admitted/,
  },
];

for (const { name, sql, reason } of forbidden) {
  test('rejects forbidden nested construct: ' + name, async () => {
    for (const decorate of [value => value, value => '/* untrusted comment */ ' + value, value => value.replace(/SELECT/g, 'SeLeCt')]) {
      await assert.rejects(compileResearchSQL(request(decorate(sql))), reason);
    }
  });
}

for (const [name, sql] of [
  ['INTERSECT branch', 'SELECT height FROM blocks INTERSECT SELECT height FROM transactions WHERE EXISTS(SELECT height FROM flows WHERE)'],
  ['GROUPING SETS HAVING', 'SELECT height,count(*) FROM blocks GROUP BY GROUPING SETS ((height),()) HAVING count(*) > ALL(SELECT height FROM transactions WHERE)'],
  ['CTE before a window join', 'WITH candidates AS (SELECT height FROM blocks WHERE height IN(SELECT height FROM transactions WHERE)), totals AS (SELECT height FROM flows) SELECT b.height,row_number() OVER(ORDER BY b.height) FROM candidates b JOIN totals t ON t.height=b.height'],
]) {
  test('rejects malformed subquery inside ' + name, async () => {
    await assert.rejects(compileResearchSQL(request(sql)));
  });
}
