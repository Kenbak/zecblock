'use strict';

const { addDays } = require('../../lib/transaction-activity');
const { ACTIVITY_SQL } = require('../../api/lib/pool-activity');

const DAY_MS = 86400000;
const ACTIVATION_HEIGHT = 3428143;
const ACTIVATION_DATE = '2026-07-28';

// Reuse the chart's exact canonical, non-coinbase and pool-classification SQL.
// This reader adds historical coverage, freshness and activation requirements.
function safeInteger(value, label) {
  if (value === null || value === undefined || value === '') throw new Error(`Unavailable ${label}`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid ${label}`);
  return result;
}

async function readPoolActivity(pool, now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid pool activity time');
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const { rows: [network] } = await client.query('SELECT current_database() AS name');
    if (network?.name !== 'zcash_explorer_mainnet') throw new Error('Pool activity milestones are mainnet-only');
    const { rows: [sourceTip] } = await client.query('SELECT height, hash, timestamp FROM blocks ORDER BY height DESC LIMIT 1');
    if (!sourceTip) throw new Error('Pool activity tip unavailable or stale');
    const tip = { height: safeInteger(sourceTip.height, 'tip height'), hash: sourceTip.hash,
      timestamp: safeInteger(sourceTip.timestamp, 'tip timestamp') };
    const age = now.getTime() / 1000 - tip.timestamp;
    if (typeof tip.hash !== 'string' || !tip.hash || age > 1800 || age < -7200) {
      throw new Error('Pool activity tip unavailable or stale');
    }
    const { rows: [sourceActivation] } = await client.query(
      'SELECT height, hash, timestamp FROM blocks WHERE height=$1', [ACTIVATION_HEIGHT]);
    if (!sourceActivation) throw new Error('Ironwood activation block unavailable');
    const timestamp = safeInteger(sourceActivation.timestamp, 'activation timestamp');
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    if (safeInteger(sourceActivation.height, 'activation height') !== ACTIVATION_HEIGHT
      || date !== ACTIVATION_DATE || tip.height < ACTIVATION_HEIGHT) {
      throw new Error('Ironwood activation block does not match verified mainnet activation');
    }
    const activation = { height: ACTIVATION_HEIGHT, timestamp, date };
    const historyStart = addDays(date, -365);
    const end = now.toISOString().slice(0, 10);
    const startEpoch = Date.parse(`${historyStart}T00:00:00Z`) / 1000;
    const endEpoch = Date.parse(`${end}T00:00:00Z`) / 1000;
    if (end <= date || tip.timestamp < endEpoch) throw new Error('No completed post-activation pool activity window');
    const { rows } = await client.query(ACTIVITY_SQL, [startEpoch, endEpoch, historyStart, end]);
    const expectedDays = (endEpoch - startEpoch) * 1000 / DAY_MS;
    if (rows.length !== expectedDays) throw new Error('Incomplete pool activity date coverage');
    const days = rows.map((row, index) => {
      if (row.date !== addDays(historyStart, index) || row.complete !== true) {
        throw new Error(`Incomplete canonical pool activity for ${row.date || historyStart}`);
      }
      const totalTransactions = safeInteger(row.total_transactions, `transaction count for ${row.date}`);
      const orchard = safeInteger(row.orchard, `Orchard count for ${row.date}`);
      const ironwood = safeInteger(row.ironwood, `Ironwood count for ${row.date}`);
      if (orchard > totalTransactions || ironwood > totalTransactions) throw new Error(`Invalid pool totals for ${row.date}`);
      return { date: row.date, totalTransactions, orchard, ironwood, complete: true };
    });
    await client.query('COMMIT');
    return { days, activation, tip, capturedAt: now.toISOString(), historyStart };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

module.exports = { readPoolActivity };
