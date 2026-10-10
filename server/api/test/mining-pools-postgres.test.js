const assert = require('node:assert/strict');
const test = require('node:test');
const { Client } = require('pg');
const { filteredBlocks, parseBlockFilters } = require('../lib/mining-software');
const { getPoolName, getPoolTag, getPoolTagSql } = require('../mining-pools');

test('PostgreSQL pool filters agree with attribution, counts and pagination', {
  skip: !process.env.MINING_TEST_DATABASE_URL,
}, async t => {
  const db = new Client({ connectionString: process.env.MINING_TEST_DATABASE_URL });
  await db.connect();
  t.after(() => db.end());
  // Session-local fixtures only: never modify the connected database's tables.
  await db.query(`
    CREATE TEMP TABLE block_software_state(version int, ready boolean);
    INSERT INTO block_software_state VALUES(1,true);
    CREATE TEMP TABLE blocks(height bigint PRIMARY KEY, hash text, timestamp bigint,
      transaction_count int, size int, difficulty numeric, miner_address text,
      coinbase_hex text, total_fees bigint);
    CREATE TEMP TABLE block_software(height bigint, timestamp bigint, software text);
  `);
  const mine = 't1Yw8NGbPDs7fgpxzJ8gzCgurAQ8GFQBkk2';
  const via = 't1MKn34KBa8Xh4g8qU8psibBXvURafphVn7';
  const funding = 't3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow';
  const hex = text => Buffer.from(text).toString('hex');
  const tag = '14f09fa6933a204d79736f6c6f706f6f6c2e636f6d';
  const sluicey = hex('Get Sluicey Yall sluicey.xyz');
  const fixtures = [
    [3431985, mine, '04f09fa693'],
    [3479731, mine, tag],
    [3479732, null, tag],
    [3479733, 'unknown', tag],
    [3479734, via, tag],
    [3479735, null, sluicey],
    [3479736, 'unknown', hex('solopool.org')],
    [3479737, null, `0${tag}0`],
    [3479738, null, `${tag}zz`],
    [3479739, funding, tag],
    [3479740, funding, null],
    [3479741, mine, sluicey],
    [3479742, null, tag.toUpperCase()],
    [3479743, null, sluicey + tag],
    [3512788, 't1Y2tYgDJnH4m1uQPDXxvXQSh1Jbun3AP22', hex('mined by KuPool')],
    [3512789, null, hex('mined by KuPool')],
    [3511796, 't1MqmXugaf5VSQvAVBhshK28S2kW762kNNH', hex('/molepool.com/')],
    [3511797, null, hex('/molepool.com/')],
    [3512636, null, hex('zecminingpool.com')],
    [3512289, 't1cQA9Rxn31tqHcgZzydrpDjgsQGmjpBgpB', '04f09f8cb8'],
    [3512346, 't1Na7ykQ6vE4CbxBPuUDUQx5n6aEWXu1VQq', ''],
    [3405273, 't1egMFNkP7EfkK25y8s4GeiMkEGnqcMnTb1', ''],
    [4484946, 'tmTwLU5Y855hfBZ25ZaWuTvcrqjrCMFAZR9', hex('Foundry Zcash Pool #PrivacyMatters')],
  ];
  for (const [height, address, coinbase] of fixtures) {
    await db.query(`INSERT INTO blocks VALUES($1::bigint,$1::bigint::text,1789134641,1,100,1,$2,$3,0)`, [height,address,coinbase]);
    await db.query(`INSERT INTO block_software VALUES($1,1789134641,'zebra')`, [height]);
    const { rows } = await db.query(`SELECT ${getPoolTagSql('coinbase_hex')} AS tag FROM blocks WHERE height=$1`, [height]);
    assert.equal(rows[0].tag, getPoolTag(coinbase));
  }
  for (const pool of ['MySoloPool', 'Sluicey Pool', 'ViaBTC', 'KuPool', 'Molepool', 'Mining Dutch', 'ZEC Mining Pool', 'Binance Pool', 'Foundry USA', 'unattributed']) {
    const expected = fixtures.filter(([,address,coinbase]) =>
      (getPoolName(address, coinbase) || 'unattributed') === pool).map(([height]) => height);
    for (const order of ['oldest', 'newest']) {
      const wanted = expected.toSorted((a,b) => order === 'oldest' ? a-b : b-a);
      const seen = [];
      let cursor = null;
      do {
        const result = await filteredBlocks(db, parseBlockFilters({pool, order}), {limit:2,cursor,direction:'next'});
        assert.equal(result.pagination.total, wanted.length, `${pool}: total`);
        seen.push(...result.blocks.map(b => Number(b.height)));
        cursor = result.pagination.hasNext ? result.pagination.nextCursor : null;
        assert.ok(seen.length <= wanted.length, 'pagination advances without duplicates');
      } while (cursor !== null);
      assert.deepEqual(seen, wanted, `${pool}: ${order}`);
    }
  }
  const bounded = await filteredBlocks(db, parseBlockFilters({pool:'MySoloPool',min_height:'3431985',max_height:'3479731'}), {limit:10,cursor:null,direction:'next'});
  assert.deepEqual(bounded.blocks.map(b => Number(b.height)), [3479731,3431985]);
});
