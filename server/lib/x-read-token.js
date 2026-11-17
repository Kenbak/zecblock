'use strict';

const fs = require('node:fs');

/**
 * A token for reading X: X_BEARER_TOKEN, else X_ACCESS_TOKEN (the bot's OAuth2
 * user token, also a bearer) from the environment, else only the
 * X_ACCESS_TOKEN line from the bot's env file, which the bot keeps
 * current after each refresh. Never refreshes: X OAuth2 refresh tokens are
 * single-use, and a second refresher would log the posting bot out.
 */
function readXToken(env = process.env) {
  if (env.X_BEARER_TOKEN?.trim()) return env.X_BEARER_TOKEN.trim();
  if (env.X_ACCESS_TOKEN?.trim()) return env.X_ACCESS_TOKEN.trim();
  try {
    const file = env.X_TOKEN_FILE || env.CALENDAR_WATCH_X_TOKEN_FILE || '/root/cipherscan/server/bot/.env';
    const line = fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith('X_ACCESS_TOKEN='));
    const token = line?.slice('X_ACCESS_TOKEN='.length).trim().replace(/^['"]|['"]$/g, '');
    return token || null;
  } catch { return null; }
}

module.exports = { readXToken };
