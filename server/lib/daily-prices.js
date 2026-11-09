'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const DAY = 86400000;
const LOCK = 839304;
const dateOf = time => new Date(time).toISOString().slice(0, 10);

function options(args) {
  if (args.some(arg => !['--daily', '--backfill'].includes(arg)) || (args.includes('--daily') && args.includes('--backfill'))) {
    throw new Error('Use --daily (default, missing dates only) or --backfill (365 days, missing dates only)');
  }
  return { backfill: args.includes('--backfill') };
}

function retryAfterMs(value, now) {
  if (!value) return 0;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - now) : 0;
}

async function fetchHistory(days, {
  env = process.env, fetchImpl = fetch, sleep = delay, now = Date.now,
  random = Math.random, log = message => console.log(`[${new Date().toISOString()}] ${message}`),
} = {}) {
  if (env.COINGECKO_DEMO_API_KEY && env.COINGECKO_PRO_API_KEY) throw new Error('Configure only one CoinGecko key type');
  const pro = !!env.COINGECKO_PRO_API_KEY;
  const host = pro ? 'pro-api.coingecko.com' : 'api.coingecko.com';
  const headers = pro ? { 'x-cg-pro-api-key': env.COINGECKO_PRO_API_KEY }
    : env.COINGECKO_DEMO_API_KEY ? { 'x-cg-demo-api-key': env.COINGECKO_DEMO_API_KEY } : {};
  const url = `https://${host}/api/v3/coins/zcash/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const deadline = now() + 9 * 60000;
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    let body;
    let failed = false;
    try {
      response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
      if (response.ok) body = await response.json();
    } catch { failed = true; } // Never log transport URLs/credentials or raw provider bodies.
    if (response?.ok && !failed) return body;
    if (response && !failed && ![408, 429].includes(response.status) && response.status < 500) {
      throw new Error(`CoinGecko HTTP ${response.status}; collection deferred`);
    }
    const wait = Math.max(60000 * 2 ** attempt, retryAfterMs(response?.headers?.get('retry-after'), now())) + Math.floor(random() * 5000);
    if (attempt === 3 || now() + wait + 15000 > deadline) {
      throw new Error(`CoinGecko ${response ? `HTTP ${response.status}` : 'transport failure'}; retry budget exhausted, collection deferred`);
    }
    log(`CoinGecko ${response ? `HTTP ${response.status}` : 'transport failure'}; retry ${attempt + 1}/3 in ${wait}ms`);
    await sleep(wait);
  }
}

// The trailing live sample is not a daily observation. Keep existing date labels.
function dailyRows(data, today) {
  if (!Array.isArray(data?.prices) || !data.prices.length) throw new Error('CoinGecko returned no daily prices');
  const auxiliaries = key => new Map((data[key] || []).filter(point => Array.isArray(point)).map(point => [point[0], point[1]]));
  const caps = auxiliaries('market_caps');
  const volumes = auxiliaries('total_volumes');
  const integerOrNull = value => Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value)) ? Math.round(value) : null;
  const rows = new Map();
  for (const point of data.prices) {
    if (!Array.isArray(point) || !Number.isSafeInteger(point[0]) || point[0] < 0) throw new Error('Invalid daily price timestamp');
    const [timestamp, price] = point;
    const date = dateOf(timestamp);
    if (date >= today) continue;
    if (timestamp % DAY !== 0) throw new Error(`Non-daily historical price sample: ${date}`);
    if (!Number.isFinite(price) || price <= 0 || price >= 1e8 || Number(price.toFixed(4)) <= 0 || rows.has(date)) throw new Error(`Invalid or duplicate daily price: ${date}`);
    rows.set(date, { date, price: price.toFixed(4), cap: integerOrNull(caps.get(timestamp)), volume: integerOrNull(volumes.get(timestamp)) });
  }
  return rows;
}

async function collectPrices(client, opt = {}, dependencies = {}) {
  const today = dateOf((dependencies.now || Date.now)());
  const acquired = (await client.query('SELECT pg_try_advisory_lock($1) acquired', [LOCK])).rows[0].acquired;
  if (!acquired) return { skipped: 'collector already running' };
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS zec_price_daily (
      date DATE PRIMARY KEY, price_usd NUMERIC(12,4) NOT NULL, market_cap_usd BIGINT,
      volume_usd BIGINT, source VARCHAR(50) DEFAULT 'coingecko', created_at TIMESTAMP DEFAULT NOW()
    )`);
    const missing = (await client.query(`SELECT d::date::text date FROM generate_series(
      COALESCE((SELECT MIN(date) FROM zec_price_daily), $1::date-7), $1::date-1, '1 day') d
      WHERE NOT EXISTS (SELECT 1 FROM zec_price_daily p WHERE p.date=d::date AND p.price_usd>0) ORDER BY d`, [today])).rows.map(row => row.date);
    if (!missing.length && !opt.backfill) return { skipped: 'completed daily prices are current', through: dateOf(Date.parse(today) - DAY) };
    const days = opt.backfill ? 365 : Math.max(7, Math.ceil((Date.parse(today) - Date.parse(missing[0])) / DAY) + 1);
    if (days > 365) throw new Error(`Missing price ${missing[0]} is outside the automatic 365-day collection window`);
    const rows = dailyRows(await fetchHistory(days, dependencies), today);
    const uncovered = missing.filter(date => !rows.has(date));
    if (uncovered.length) throw new Error(`Provider did not return required daily prices: ${uncovered.join(', ')}`);
    await client.query('BEGIN');
    let inserted = 0;
    try {
      await client.query("SET LOCAL lock_timeout='1s'; SET LOCAL TIME ZONE 'UTC'");
      for (const row of rows.values()) {
        const result = await client.query(`INSERT INTO zec_price_daily(date,price_usd,market_cap_usd,volume_usd,source)
          VALUES($1,$2,$3,$4,'coingecko') ON CONFLICT(date) DO NOTHING`, [row.date, row.price, row.cap, row.volume]);
        inserted += result.rowCount;
      }
      if ((await client.query('SELECT date::text FROM zec_price_daily WHERE date=ANY($1::date[]) AND price_usd<=0', [missing])).rowCount) throw new Error('Existing invalid prices require reviewed repair');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    return { inserted, requestedDays: days, source: 'coingecko', through: dateOf(Date.parse(today) - DAY) };
  } finally { await client.query('SELECT pg_advisory_unlock($1)', [LOCK]); }
}
module.exports = { options, retryAfterMs, fetchHistory, dailyRows, collectPrices };
