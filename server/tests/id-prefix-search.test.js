const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIdQuery, nextHexPrefix, prefixSearchSql, searchIdPrefix } = require('../api/lib/id-prefix-search');

test('shortened id queries accept bare prefixes and the displayed prefix...suffix form', () => {
  assert.deepEqual(parseIdQuery('5B34C8B44D'), { prefix: '5b34c8b44d', suffix: null });
  assert.deepEqual(parseIdQuery(' 5b34c8b44d...ec9e77 '), { prefix: '5b34c8b44d', suffix: 'ec9e77' });
  assert.deepEqual(parseIdQuery('5b34c8b44d…ec9e77'), { prefix: '5b34c8b44d', suffix: 'ec9e77' });
  assert.deepEqual(parseIdQuery('5b34c8..ec9e'), { prefix: '5b34c8', suffix: 'ec9e' });
  for (const invalid of ['', '5b34c8b', 'a'.repeat(64), 'a'.repeat(65), 'zz34c8b44d', '5b34c...ec9e77', '5b34c8b44d...ec9', `${'a'.repeat(40)}...${'b'.repeat(30)}`, null, 42, 'a'.repeat(200)]) {
    assert.equal(parseIdQuery(invalid), null, String(invalid));
  }
});

test('the exclusive upper bound follows hexadecimal order with carry', () => {
  assert.equal(nextHexPrefix('abc'), 'abd');
  assert.equal(nextHexPrefix('ab9'), 'aba');
  assert.equal(nextHexPrefix('abf'), 'ac');
  assert.equal(nextHexPrefix('0fff'), '1');
  assert.equal(nextHexPrefix('ffff'), null);
});

test('generated SQL is parameterized and bounded', () => {
  const { sql, params } = prefixSearchSql('transactions', 'txid', ['block_height'], { prefix: 'ffffffff', suffix: 'ab12' }, 5);
  assert.doesNotMatch(sql, /ffff|ab12/, 'values are never interpolated');
  assert.match(sql, /txid >= \$1 AND left\(txid, \$2\) = \$1 AND right\(txid, \$3\) = \$4 ORDER BY txid LIMIT \$5$/);
  assert.doesNotMatch(sql, /, \d+\)/, 'no input-derived numbers in the SQL text');
  assert.deepEqual(params, ['ffffffff', 8, 4, 'ab12', 6]);
});

test('results are capped and report truncation', async () => {
  const query = async (sql) => ({
    rows: sql.includes('FROM transactions')
      ? Array.from({ length: 6 }, (_, i) => ({ txid: `aaaaaaaa${i}`, block_height: '10' }))
      : [{ hash: 'aaaaaaaab', height: '7' }],
  });
  const result = await searchIdPrefix(query, { prefix: 'aaaaaaaa', suffix: null });
  assert.equal(result.transactions.length, 5);
  assert.deepEqual(result.transactions[0], { txid: 'aaaaaaaa0', blockHeight: 10 });
  assert.deepEqual(result.blocks, [{ hash: 'aaaaaaaab', height: 7 }]);
  assert.equal(result.truncated, true);
});

test('PostgreSQL prefix ranges are exact under the database collation', {
  skip: !process.env.PREFIX_TEST_DATABASE_URL,
}, async (t) => {
  const { Client } = require('pg');
  const db = new Client({ connectionString: process.env.PREFIX_TEST_DATABASE_URL });
  await db.connect();
  t.after(() => db.end());
  await db.query(`
    CREATE TEMP TABLE transactions(txid text PRIMARY KEY, block_height bigint NOT NULL);
    CREATE TEMP TABLE blocks(height bigint PRIMARY KEY, hash text UNIQUE NOT NULL);
    INSERT INTO transactions SELECT md5(i::text) || md5((i * 7)::text), i FROM generate_series(1, 20000) i;
    INSERT INTO blocks SELECT i, md5((i * 3)::text) || md5(i::text) FROM generate_series(1, 2000) i;
    ANALYZE transactions; ANALYZE blocks;
  `);
  const query = db.query.bind(db);
  const { rows: sample } = await db.query('SELECT txid FROM transactions ORDER BY block_height LIMIT 300');
  for (const { txid } of sample) {
    for (const length of [8, 9, 12]) {
      const prefix = txid.slice(0, length);
      const expected = (await db.query('SELECT txid FROM transactions WHERE starts_with(txid, $1) ORDER BY txid COLLATE "C" LIMIT 5', [prefix])).rows.map(r => r.txid);
      const result = await searchIdPrefix(query, { prefix, suffix: null });
      assert.deepEqual(result.transactions.map(r => r.txid).sort(), expected.sort(), prefix);
    }
    const shortened = await searchIdPrefix(query, parseIdQuery(`${txid.slice(0, 10)}...${txid.slice(-6)}`));
    assert.deepEqual(shortened.transactions.map(r => r.txid), [txid]);
  }
  for (const prefix of ['ffffffff', '9fffffff', '00000000']) {
    const expected = (await db.query('SELECT count(*)::int AS n FROM transactions WHERE starts_with(txid, $1)', [prefix])).rows[0].n;
    assert.equal((await searchIdPrefix(query, { prefix, suffix: null })).transactions.length, Math.min(expected, 5), prefix);
  }
  const plan = prefixSearchSql('transactions', 'txid', ['block_height'], { prefix: sample[0].txid.slice(0, 8), suffix: null });
  const explain = (await db.query(`EXPLAIN ${plan.sql}`, plan.params)).rows.map(r => r['QUERY PLAN']).join('\n');
  assert.match(explain, /Index/, 'the prefix range must use the identifier index');
});
