'use strict';

// Maya/THORChain whale posts: venue naming, identity-based overlap dedupe
// across venues, and a venue-specific future-only activation watermark.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const p = require('../bot/lib/editorial-policy');
const data = require('../bot/lib/editorial-data');
const { preparePublication } = require('../bot/lib/editorial-source');
const { run, VENUE_SWAPS_ACTIVATION_KEY } = require('../bot/jobs/editorial');

const log = { info() {}, warn() {}, error() {} };
const now = new Date('2026-11-04T10:00:00Z');
const tx = c => c.repeat(64);

function venueRow(overrides = {}) {
  return {
    id: `maya-swap-${tx('d')}`, venue: 'maya', source_chain: 'btc', dest_chain: 'zec', direction: 'inflow',
    source_amount_usd: '412345.67', sample_count: '1900', greater_count: '3', equal_count: '0',
    canonical_identity: 'zec-abc', partial_return: false, swap_created_at: '2026-11-04T09:40:00Z',
    zec_legs: [{ side: 'out', txid: tx('e'), address: 't1x', amountZat: '100000000000' }],
    ...overrides,
  };
}
const nearRow = (overrides = {}) => ({ id: 77, source_chain: 'eth', dest_chain: 'zec', source_amount_usd: 300000,
  sample_count: 25000, greater_count: 10, equal_count: 0, zec_txid: tx('e'), swap_created_at: '2026-11-04T09:45:00Z', ...overrides });

test('venue swaps name their venue, keep a venue-scoped dedup key and approximate USD wording', () => {
  const maya = p.swapStory(venueRow());
  assert.equal(maya.key, `cross_chain:maya:maya-swap-${tx('d')}`);
  assert.match(maya.content, /^🟨 ≈\$412,346 just crossed from Bitcoin into ZEC via Maya\./);
  assert.match(maya.content, /One of the largest 0\.22% of Maya ZEC swaps we've indexed in 30 days\./);
  assert.ok(maya.content.endsWith(`/tx/${tx('e')}`));
  assert.equal(maya.evidence.venue, 'maya');
  assert.deepEqual(maya.evidence.zecTxids, [tx('e')]);
  assert.equal(maya.evidence.card.kicker, 'Cross-chain · Maya');
  // The amount stays an exact provider decimal string in evidence.
  assert.equal(maya.evidence.source_amount_usd, '412345.67');
  const reply = preparePublication(maya).sourceReply.content;
  assert.match(reply, /first-stream-interval price, not settlement value/);
  assert.match(reply, /Venues are not summed/);

  const thor = p.swapStory(venueRow({ id: `thorchain-swap-${tx('f')}`, venue: 'thorchain', source_chain: 'zec', dest_chain: 'eth',
    direction: 'outflow', greater_count: '0', zec_legs: [{ side: 'in', txid: tx('1'), address: 't1y', amountZat: '1' },
      { side: 'out', txid: tx('2'), address: 't1z', amountZat: '1' }] }));
  assert.equal(thor.key, `cross_chain:thorchain:thorchain-swap-${tx('f')}`);
  assert.match(thor.content, /via THORChain\.\n\nThe largest THORChain ZEC swap we've indexed in 30 days\./);
  // The outflow links its native ZEC input; every native leg is retained for overlap checks.
  assert.ok(thor.content.endsWith(`/tx/${tx('1')}`));
  assert.deepEqual(thor.evidence.zecTxids, [tx('1'), tx('2')]);

  const near = p.swapStory(nearRow());
  assert.equal(near.key, 'cross_chain:77');
  assert.match(near.content, /via NEAR Intents\./);
  assert.doesNotMatch(near.content, /≈/);
});

test('swap size floor is per venue: THORChain from $25K, NEAR and Maya from $50K', () => {
  assert.deepEqual({ ...p.MIN_SWAP_USD }, { near: 50000, maya: 50000, thorchain: 25000 });
  const thor = usd => p.swapStory(venueRow({ id: `thorchain-swap-${tx('f')}`, venue: 'thorchain', source_amount_usd: usd }));
  assert.match(thor('30151.20').content, /^🟨 ≈\$30,151 just crossed from Bitcoin into ZEC via THORChain\./);
  assert.ok(thor('25000'), 'the floor itself qualifies');
  assert.equal(thor('24999.99'), null);
  assert.equal(p.swapStory(venueRow({ source_amount_usd: '30151.20' })), null, 'Maya keeps $50K');
  assert.equal(p.swapStory(nearRow({ source_amount_usd: 30151 })), null, 'NEAR keeps $50K');
  assert.equal(p.swapStory(venueRow({ venue: 'unknown', source_amount_usd: '900000' })), null);
  // The floor never overrides rarity: a $30K THORChain swap outside its venue's top 1% is not posted.
  assert.equal(p.swapStory(venueRow({ venue: 'thorchain', source_amount_usd: '30000', greater_count: '20' })), null);
});

test('venue swaps without a resolvable native-ZEC identity, with partial returns or wrong direction are never posted', () => {
  assert.equal(p.swapStory(venueRow({ canonical_identity: null })), null, 'unresolved overlap identity');
  assert.equal(p.swapStory(venueRow({ zec_legs: [{ side: 'out', txid: null, address: 't1x' }] })), null, 'missing ZEC hash');
  assert.equal(p.swapStory(venueRow({ zec_legs: [] })), null, 'no native legs');
  assert.equal(p.swapStory(venueRow({ partial_return: true })), null, 'partial source refund');
  assert.equal(p.swapStory(venueRow({ partial_return: undefined })), null, 'unknown refund state');
  assert.equal(p.swapStory(venueRow({ direction: 'internal' })), null, 'internal action');
  assert.equal(p.swapStory(venueRow({ direction: 'outflow' })), null, 'direction contradicts route');
  assert.equal(p.swapStory(venueRow({ venue: 'osmosis' })), null, 'unknown venue');
  assert.equal(p.swapStory(venueRow({ source_amount_usd: '49999.99' })), null, 'below threshold');
  assert.equal(p.swapStory(venueRow({ sample_count: '99' })), null, 'thin baseline');
  assert.equal(p.swapStory(venueRow({ greater_count: '40' })), null, 'outside the 1% tail');
});

test('one economic swap is posted once across NEAR, Maya and THORChain', () => {
  const maya = p.swapStory(venueRow());
  const near = p.swapStory(nearRow());
  // Already posted through NEAR Intents: the same native ZEC payout via Maya is held.
  const history = [{ post_type: 'swap', dedup_key: near.key, status: 'posted', created_at: '2026-11-03T09:00:00Z',
    metadata: { ...near.evidence, slot: 'am' } }];
  let result = p.select([maya], history, now);
  assert.deepEqual(result.skipped, [{ key: maya.key, reason: 'swap-overlap-already-posted' }]);
  // Uncertain deliveries count too; failed or withdrawn rows do not.
  result = p.select([maya], [{ ...history[0], status: 'uncertain' }], now);
  assert.equal(result.skipped[0].reason, 'swap-overlap-already-posted');
  result = p.select([maya], [{ ...history[0], status: 'withdrawn' }], now);
  assert.equal(result.selected.length, 1);
  // Legacy NEAR rows only carry zec_txid; they still block a matching venue post.
  const legacy = [{ post_type: 'swap', dedup_key: 'cross_chain:5', status: 'posted', created_at: '2026-11-03T09:00:00Z',
    metadata: { zec_txid: tx('e') } }];
  assert.equal(p.select([maya], legacy, now).skipped[0].reason, 'swap-overlap-already-posted');

  // Same run: one is selected, the other is an overlap rather than a second post.
  const thor = p.swapStory(venueRow({ id: `thorchain-swap-${tx('9')}`, venue: 'thorchain', source_amount_usd: '900000' }));
  result = p.select([maya, thor], [], now);
  assert.equal(result.selected.length, 1);
  assert.deepEqual(result.skipped.map(s => s.reason), ['swap-overlap-already-posted']);

  // Distinct native transactions are distinct swaps (only the normal slot pacing applies).
  const other = p.swapStory(venueRow({ id: `maya-swap-${tx('8')}`, zec_legs: [{ side: 'out', txid: tx('7'), address: 't1q' }] }));
  result = p.select([other], history, now);
  assert.notEqual(result.skipped[0]?.reason, 'swap-overlap-already-posted');
});

function orchestrator({ venueActivation, live }) {
  const writes = [];
  const lock = { query: async () => ({ rows: [{ acquired: true }] }), release() {} };
  const pool = { connect: async () => lock, query: async (sql, args) => {
    writes.push([sql, args]);
    if (sql.startsWith('SELECT metadata')) {
      const at = args[0] === VENUE_SWAPS_ACTIVATION_KEY ? venueActivation : '2026-09-20T00:00:00Z';
      return { rows: at ? [{ metadata: { activatedAt: at } }] : [] };
    }
    return { rows: [] };
  } };
  const collectors = { assertMainnetFresh: async () => {}, liveCandidates: async () => ({ candidates: live, decisions: [] }) };
  return { pool, writes, collectors };
}

test('venue swaps are future-only from their own activation; NEAR keeps the original watermark', async () => {
  const before = p.swapStory(venueRow({ swap_created_at: '2026-11-04T09:30:00Z' }));
  const after = p.swapStory(venueRow({ id: `maya-swap-${tx('a')}`, swap_created_at: '2026-11-04T09:50:00Z',
    zec_legs: [{ side: 'out', txid: tx('b'), address: 't1b' }] }));
  const near = p.swapStory(nearRow({ swap_created_at: '2026-11-04T09:30:00Z', zec_txid: tx('c') }));
  const h = orchestrator({ venueActivation: '2026-11-04T09:45:00Z', live: [before, after, near] });
  const result = await run(h.pool, { dryRun: true }, { now, collectors: h.collectors, logger: log });
  assert.equal(result.venueSwapsActivatedAt, '2026-11-04T09:45:00Z');
  assert.deepEqual(result.decisions.filter(d => d.reason === 'before-activation').map(d => d.key), [before.key]);
  assert.ok(result.selected.some(s => s.key === after.key || s.key === near.key));
  assert.ok(!result.selected.some(s => s.key === before.key));

  // First deployment: a preview never writes the watermark and treats "now" as activation,
  // so swaps that already happened are never backfill-posted.
  const first = orchestrator({ venueActivation: null, live: [before, after] });
  const preview = await run(first.pool, { dryRun: true }, { now, collectors: first.collectors, logger: log });
  assert.equal(preview.venueSwapsActivatedAt, now.toISOString());
  assert.equal(preview.selected.length, 0);
  assert.ok(!first.writes.some(([sql]) => sql.startsWith('INSERT')));

  // A live first run records its own durable venue watermark.
  const live = orchestrator({ venueActivation: null, live: [] });
  await assert.rejects(run(live.pool, { post: async () => ({ id: '1' }) }, { now, collectors: live.collectors, logger: log }),
    /watermark unavailable/);
  assert.ok(live.writes.some(([sql, args]) => sql.startsWith('INSERT') && args[0] === VENUE_SWAPS_ACTIVATION_KEY
    && JSON.parse(args[1]).activatedAt === now.toISOString()));
});

test('venue SQL: fresh complete index, settled-in-window selection and per-venue baseline',
  { skip: process.env.ACTIVITY_TEST_POSTGRES !== '1' && !process.env.TEST_ACTIVITY_DATABASE_URL }, async () => {
    const { Pool } = require('pg');
    const connection = process.env.TEST_ACTIVITY_DATABASE_URL;
    const admin = new Pool(connection ? { connectionString: connection } : { host: '/tmp', database: 'postgres' });
    const name = `bot_venue_test_${process.pid}_${Date.now()}`;
    let db;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      const url = connection ? new URL(connection) : null; if (url) url.pathname = `/${name}`;
      db = new Pool({ ...url ? { connectionString: url.toString() } : { host: '/tmp', database: name }, max: 2 });
      assert.deepEqual((await data.venueSwapCandidates(db, now)).decisions, [{ key: 'crosschain-venues', reason: 'venue-index-unavailable' }]);
      // Tables only: the trailing CONCURRENTLY indexes must run outside a transaction block.
      const schema = fs.readFileSync(require.resolve('../scripts/create-crosschain-venues.sql'), 'utf8');
      await db.query(schema.slice(0, schema.indexOf('COMMIT;') + 'COMMIT;'.length));
      const insert = (venue, id, { status = 'SUCCESS', usd, created, observed = created, direction = 'inflow', source = 'btc',
        dest = 'zec', identity = 'zec-x', legs, outputs = [] }) => db.query(`INSERT INTO crosschain_venue_actions
        (venue,id,action_type,status,swap_created_at,created_at_ns,source_chain,source_asset,dest_chain,dest_asset,
         source_amount,dest_amount,zec_amount_zat,source_amount_usd,canonical_identity,payload,status_observed_at)
        VALUES ($1,$2,'swap',$3,$4,0,$5,'BTC.BTC',$6,'ZEC.ZEC','1.5','100.25','10025000000',$7,$8,$9::jsonb,$10)`,
      [venue, id, status, created, source, dest, usd, identity, JSON.stringify({ direction, outputs,
        zecLegs: legs || [{ side: direction === 'inflow' ? 'out' : 'in', txid: tx(id.slice(-1)), address: 't1' }] }), observed]);
      // 300 baseline swaps over the prior 30 days, all below the candidates.
      for (let i = 0; i < 300; i++) {
        await insert('maya', `maya-swap-base${String(i).padStart(3, '0')}`, { usd: 1000 + i,
          created: new Date(now - (i + 2) * 2 * 3600000).toISOString() });
      }
      await insert('maya', 'maya-swap-whale-a', { usd: '612345.678901234', created: '2026-11-04T09:30:00Z' });
      // Settled within the hour after a long stream: still selected by first SUCCESS observation.
      await insert('maya', 'maya-swap-stream-b', { usd: '75000', created: '2026-11-03T14:00:00Z', observed: '2026-11-04T09:55:00Z' });
      // Backfilled history: SUCCESS first observed now, but created days ago. Never a live candidate.
      await insert('maya', 'maya-swap-old-c', { usd: '900000', created: '2026-11-01T09:00:00Z', observed: '2026-11-04T09:58:00Z' });
      await insert('maya', 'maya-swap-pending-d', { status: 'PROCESSING', usd: '900000', created: '2026-11-04T09:50:00Z' });
      await insert('maya', 'maya-swap-internal-e', { usd: '900000', created: '2026-11-04T09:50:00Z', direction: 'internal', source: 'zec' });
      await insert('maya', 'maya-swap-partial-f', { usd: '800000', created: '2026-11-04T09:50:00Z',
        outputs: [{ affiliate: false, coins: [{ asset: 'BTC.BTC', amount: '0.1' }] }] });
      await insert('maya', 'maya-swap-noid-g', { usd: '700000', created: '2026-11-04T09:50:00Z', identity: null });
      await insert('thorchain', 'thorchain-swap-whale-h', { usd: '900000', created: '2026-11-04T09:30:00Z' });
      await db.query(`INSERT INTO crosschain_venue_sync(venue,mode,completed_at,as_of,last_checked_at) VALUES
        ('maya','backfill','2026-10-29T10:00:00Z','2026-10-29T10:00:00Z','2026-10-29T10:00:00Z'),
        ('maya','sync','2026-11-04T09:56:00Z','2026-11-04T09:56:00Z','2026-11-04T09:56:00Z'),
        ('thorchain','backfill',NULL,'2026-11-04T09:56:00Z','2026-11-04T09:56:00Z')`);

      let result = await data.venueSwapCandidates(db, now);
      assert.deepEqual(result.candidates.map(c => c.key), ['cross_chain:maya:maya-swap-whale-a', 'cross_chain:maya:maya-swap-stream-b']);
      const whale = result.candidates[0];
      assert.equal(whale.evidence.source_amount_usd, '612345.678901234');
      assert.equal(whale.evidence.zec_amount_zat, '10025000000');
      assert.equal(Number(whale.evidence.sample_count), 302); // 300 + the backfilled and streaming swaps
      assert.match(whale.content, /via Maya/);
      assert.ok(result.decisions.some(d => d.key === 'cross_chain:maya:maya-swap-partial-f'));
      assert.ok(result.decisions.some(d => d.key === 'cross_chain:maya:maya-swap-noid-g'));
      assert.ok(!JSON.stringify(result).includes('old-c') && !JSON.stringify(result).includes('pending-d')
        && !JSON.stringify(result).includes('internal-e'));
      // An incomplete THORChain traversal is not a 30-day baseline.
      assert.deepEqual(result.decisions.find(d => d.key === 'crosschain:thorchain'), { key: 'crosschain:thorchain', reason: 'venue-baseline-incomplete' });

      // With a complete baseline, THORChain's lower floor applies in SQL; Maya keeps $50K.
      for (let i = 0; i < 250; i++) {
        await insert('thorchain', `thorchain-swap-base${String(i).padStart(3, '0')}`, { usd: 500 + i,
          created: new Date(now - (i + 2) * 2 * 3600000).toISOString() });
      }
      await insert('thorchain', 'thorchain-swap-mid-i', { usd: '30151.2', created: '2026-11-04T09:35:00Z',
        legs: [{ side: 'out', txid: tx('9'), address: 't1' }] });
      await insert('thorchain', 'thorchain-swap-small-j', { usd: '24999.99', created: '2026-11-04T09:36:00Z' });
      await insert('maya', 'maya-swap-mid-k', { usd: '30151.2', created: '2026-11-04T09:37:00Z' });
      await db.query(`UPDATE crosschain_venue_sync SET completed_at='2026-10-29T10:00:00Z', last_checked_at='2026-11-04T09:56:00Z'
        WHERE venue='thorchain'`);
      result = await data.venueSwapCandidates(db, now);
      const keys = result.candidates.map(c => c.key);
      assert.ok(keys.includes('cross_chain:thorchain:thorchain-swap-mid-i'), keys.join());
      assert.match(result.candidates.find(c => c.key.endsWith('mid-i')).content, /≈\$30,151 just crossed from Bitcoin into ZEC via THORChain/);
      assert.ok(!JSON.stringify(result).includes('small-j') && !JSON.stringify(result).includes('mid-k'));

      // Stale venue sync publishes nothing for that venue.
      await db.query(`UPDATE crosschain_venue_sync SET last_checked_at='2026-11-04T09:30:00Z' WHERE venue='maya'`);
      result = await data.venueSwapCandidates(db, now);
      assert.deepEqual(result.candidates.filter(c => c.evidence.venue === 'maya'), []);
      assert.ok(result.decisions.some(d => d.key === 'crosschain:maya' && d.reason === 'venue-sync-unavailable-or-stale'));
    } finally {
      if (db) await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end();
    }
  });
