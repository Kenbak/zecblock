'use strict';

/**
 * ZecBlock Data Bot — Orchestrator
 *
 * Entry point for the bot service. Manages cron scheduling:
 *  - Every 5 minutes: ranked flows, swaps, migrations and reorgs
 *  - Daily after 06:00 UTC: completed-day analysis and historical records
 *  - Evenings from 21:00 UTC: an animated replay when its data has a story,
 *    at most one a week (needs ffmpeg on the host)
 *
 * Configuration via environment variables:
 *  - DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 *  - X_ACCESS_TOKEN (OAuth2 user access token)
 *  - X_CLIENT_ID, X_CLIENT_SECRET, X_REFRESH_TOKEN (for token refresh)
 *  - BOT_DRY_RUN=1 (skip actual posting, log only)
 */

const { getPool, getReadPool } = require('../lib/db-pool');
const { XClient } = require('./lib/x-client');
const editorial = require('./jobs/editorial');
const replay = require('./jobs/replay');
const { renderEditorial } = require('./lib/zecblock-cards');

const pool = getPool({ max: 5, idleTimeoutMillis: 60000, connectionTimeoutMillis: 5000 });

const dryRun = process.env.BOT_DRY_RUN === '1';
const reader = getReadPool({ max: 2 });

const path = require('path');

const xClient = new XClient({
  accessToken: process.env.X_ACCESS_TOKEN || '',
  refreshToken: process.env.X_REFRESH_TOKEN || '',
  clientId: process.env.X_CLIENT_ID || '',
  clientSecret: process.env.X_CLIENT_SECRET || '',
  tokenFile: path.resolve(__dirname, '.env'),
  dryRun,
});

const logger = {
  info: (...args) => console.log(new Date().toISOString(), '[INFO]', ...args),
  warn: (...args) => console.warn(new Date().toISOString(), '[WARN]', ...args),
  error: (...args) => console.error(new Date().toISOString(), '[ERROR]', ...args),
};

let running = false;

async function tick() {
  if (running) return;
  running = true;

  try {
    const result = await editorial.run(pool, xClient, { logger, reader, render: renderEditorial });
    logger.info(`[Tick] Editorial run: ${result.results?.length || 0} selected posts`);
  } catch (err) {
    logger.error(`[Tick] Unhandled error: ${err.message}`);
  }
  // The weekly video is independent of the editorial run: neither blocks the other.
  try {
    const result = await replay.run(pool, xClient, { logger });
    if (!['outside-window', 'no-story-today', 'weekly-cap'].includes(result.skipped)) logger.info(`[Tick] Replay: ${JSON.stringify(result)}`);
  } catch (err) {
    logger.error(`[Tick] Replay error: ${err.message}`);
  } finally {
    running = false;
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

async function start() {
  logger.info(`ZecBlock Data Bot starting (dry_run=${dryRun})`);

  try {
    const { rows } = await pool.query('SELECT NOW() as t, current_database() as db');
    logger.info(`Connected to ${rows[0].db} at ${rows[0].t}`);
  } catch (err) {
    logger.error(`Database connection failed: ${err.message}`);
    process.exit(1);
  }

  // Proactively refresh token on startup (access tokens expire every 2h)
  if (!dryRun && xClient.refreshTokenValue && xClient.clientId) {
    try {
      await xClient._doRefresh();
      logger.info('Token refreshed on startup');
    } catch (err) {
      logger.warn(`Startup token refresh failed: ${err.message}`);
    }
  }

  // Run immediately on start
  await tick();

  // Then every 5 minutes
  const INTERVAL_MS = 5 * 60 * 1000;
  setInterval(tick, INTERVAL_MS);
  logger.info(`Scheduled: alerts every 5m, daily analysis after 06:00 UTC`);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await pool.end();
  if (reader !== pool) await reader.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down');
  await pool.end();
  if (reader !== pool) await reader.end();
  process.exit(0);
});

start().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
