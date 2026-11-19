'use strict';

function telegramConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) throw new Error('Signal Telegram is not configured: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Signal Telegram bot token has an invalid format');
  return { token, chatId };
}

async function request(method, body, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const {token} = telegramConfig(env);
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
  } catch {
    // Fetch errors may contain the credential-bearing URL. Never log them.
    throw new Error('Signal Telegram request failed or exceeded 15 seconds');
  }
  let payload;
  try { payload = await response.json(); } catch { throw new Error('Signal Telegram returned an invalid response'); }
  if (!response.ok || payload?.ok !== true) {
    // The status lets a caller tell a rejected message (400) from an outage. Never attach the payload or URL.
    throw Object.assign(new Error(`Signal Telegram rejected ${method} (HTTP ${response.status})`), { status: response.status });
  }
  return payload.result;
}

/** `parseMode` defaults to Telegram's legacy Markdown; pass 'HTML', or null for plain text. */
async function sendSignalReport(text, options = {}) {
  const {chatId} = telegramConfig(options.env);
  const parseMode = options.parseMode === undefined ? 'Markdown' : options.parseMode;
  await request('sendMessage', {chat_id:chatId, text, ...(parseMode ? {parse_mode:parseMode} : {}), disable_web_page_preview:true}, options);
}

async function checkSignalTelegram(options = {}) {
  const {chatId} = telegramConfig(options.env);
  await request('getMe', {}, options);
  await request('getChat', {chat_id:chatId}, options);
}
module.exports = { telegramConfig, sendSignalReport, checkSignalTelegram };
