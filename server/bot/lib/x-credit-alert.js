'use strict';

// Telegram alert when X refuses the bot because the API account has no credits
// left. Without it the bot just goes quiet: every post fails and nothing says why.
const { sendSignalReport } = require('../../lib/signal-telegram');

const REPEAT_MS = 6 * 3600_000;
const TEXT = 'ZecBlock X bot: X refused a request because the API account is out of credits. '
  + 'The bot cannot post until credits are added in the X developer console.';

/**
 * X answers a pay-per-use account with no balance with HTTP 402 and a
 * "CreditsDepleted" title. Match the wording too, in case the status differs.
 */
function isCreditError(error) {
  return error?.statusCode === 402 || /credits?\s*depleted|does not have any credits/i.test(String(error?.message || ''));
}

/** Returns a handler for X client errors. It alerts at most once every six hours and never throws. */
function createCreditAlert({ send = sendSignalReport, logger = console, now = Date.now, repeatMs = REPEAT_MS } = {}) {
  let last = -Infinity;
  return async function onXError(error) {
    if (!isCreditError(error) || now() - last < repeatMs) return false;
    const previous = last;
    last = now();
    try {
      await send(TEXT);
      logger.warn('[Credit alert] X is out of credits; Telegram alert sent');
      return true;
    } catch (failure) {
      // Try again on the next failure rather than staying silent for six hours.
      last = previous;
      logger.error(`[Credit alert] X is out of credits; Telegram alert failed: ${failure.message}`);
      return false;
    }
  };
}

module.exports = { createCreditAlert, isCreditError, TEXT };
