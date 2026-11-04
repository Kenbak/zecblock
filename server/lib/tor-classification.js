'use strict';
const { isIP } = require('node:net');
const TOR_CLASSIFICATION_KEY = 'zcash:tor-classification:census-v3';
const TOR_CLASSIFICATION_TTL_SECONDS = 600;
const MAX_AGE_MS = TOR_CLASSIFICATION_TTL_SECONDS * 1000;

function parseTorExitList(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) return null;
  const ips = new Set();
  for (const raw of text.split('\n')) {
    const ip = raw.trim();
    if (!ip || ip.startsWith('#')) continue;
    if (!isIP(ip) || ip.includes('%')) return null;
    ips.add(isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip);
  }
  return ips.size ? ips : null;
}

function validateTorClassificationStatus(value, now = Date.now()) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || value.version !== 1 || typeof value.available !== 'boolean') return null;
  const keys = ['checkedAtMs', 'sourceObservedAtMs', 'committedAtMs', 'snapshotTimeMs'];
  if (keys.some(k => !Number.isSafeInteger(value[k]) || value[k] <= 0 || value[k] > now)) return null;
  if (value.sourceObservedAtMs > value.checkedAtMs || value.checkedAtMs > value.committedAtMs
    || value.snapshotTimeMs > value.committedAtMs || now - value.checkedAtMs > MAX_AGE_MS
    || now - value.sourceObservedAtMs > MAX_AGE_MS) return null;
  if (value.available && (!Number.isSafeInteger(value.classifiedTorNodes) || value.classifiedTorNodes < 0)) return null;
  if (!value.available && value.classifiedTorNodes !== null) return null;
  return value;
}

async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Tor classification cache timeout')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function readTorClassificationStatus(redis, { now = Date.now, timeoutMs = 200 } = {}) {
  if (!redis || redis.isOpen === false || redis.isReady === false) return null;
  try {
    const raw = await bounded(() => redis.get(TOR_CLASSIFICATION_KEY), timeoutMs);
    return validateTorClassificationStatus(raw, typeof now === 'function' ? now() : now);
  } catch { return null; }
}

async function readLatestTorCensusSnapshot(pool, { timeoutMs = 200 } = {}) {
  try {
    const result = await bounded(() => pool.query('SELECT MAX(snapshot_time) AS snapshot_time FROM node_snapshots WHERE census_version = 3'), timeoutMs);
    return result.rows[0]?.snapshot_time ?? null;
  } catch { return null; }
}

function timestamp(value) {
  if (typeof value === 'number') return value;
  return value ? new Date(value).getTime() : NaN;
}

function torClassificationForStats(stats, status) {
  const available = !!(status?.available && timestamp(stats.lastUpdated) === status.sourceObservedAtMs
    && timestamp(stats.censusSnapshotTime) === status.snapshotTimeMs);
  const publicStats = { ...stats };
  delete publicStats.censusSnapshotTime;
  return { ...publicStats, torNodes: available ? status.classifiedTorNodes : null,
    torClassificationAvailable: available,
    torClassificationCheckedAt: status ? new Date(status.checkedAtMs).toISOString() : null };
}

function torClassificationForSnapshot(snapshotTime, status) {
  const available = !!(status?.available && timestamp(snapshotTime) === status.snapshotTimeMs);
  return { torNodes: available ? status.classifiedTorNodes : null,
    torClassificationAvailable: available,
    torClassificationCheckedAt: available ? new Date(status.checkedAtMs).toISOString() : null };
}

async function publishTorClassificationStatus(status, { createClient = require('redis').createClient } = {}) {
  const redis = createClient({ socket: { host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'), connectTimeout: 1000, reconnectStrategy: false } });
  redis.on('error', () => {});
  try {
    await bounded(() => redis.connect(), 1200);
    await bounded(() => redis.set(TOR_CLASSIFICATION_KEY, JSON.stringify(status), { EX: TOR_CLASSIFICATION_TTL_SECONDS }), 1200);
    return true;
  } catch { return false; }
  finally { if (redis.isOpen) { try { await redis.disconnect(); } catch {} } }
}

module.exports = { TOR_CLASSIFICATION_KEY, TOR_CLASSIFICATION_TTL_SECONDS, parseTorExitList,
  validateTorClassificationStatus, readTorClassificationStatus, torClassificationForStats,
  torClassificationForSnapshot, publishTorClassificationStatus, readLatestTorCensusSnapshot };
