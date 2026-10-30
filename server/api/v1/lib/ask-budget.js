'use strict';
const { askError, askStage } = require('./ask-errors');
const { createHmac, randomUUID } = require('node:crypto');

// All keys share a Redis Cluster slot. Reserve the conservative maximum, never
// refund uncertain/cancelled calls. Prices are deployment-reviewed upper bounds.
// Ordinary beta traffic gets useful routing headroom without making distributed
// cheap requests unbounded: 20/minute and 400/day/IP; 3000/hour and 20000/day/site.
// AI work keeps 5/minute and 20/day/IP (it also spends the USD budgets). SQL runs
// on our own database and gets 10/minute and 100/day/IP; the worker separately
// caps site-wide daily executions (ASK_ANALYTICS_DAILY_QUERY_LIMIT).
const REQUEST_LIMITS = Object.freeze({ minute: 20, day: 400, globalHour: 3000, globalDay: 20000 });
const WORK_LIMITS = Object.freeze({ ai: Object.freeze({ minute: 5, day: 20 }), sql: Object.freeze({ minute: 10, day: 100 }) });
const RESERVE = `
local calls = tonumber(redis.call('GET', KEYS[1]) or '0')
local daily = tonumber(redis.call('GET', KEYS[3]) or '0')
local monthly = tonumber(redis.call('GET', KEYS[4]) or '0')
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
if calls >= tonumber(ARGV[3]) then return -1 end
if daily + tonumber(ARGV[5]) > tonumber(ARGV[6]) then return -2 end
if monthly + tonumber(ARGV[5]) > tonumber(ARGV[7]) then return -3 end
if redis.call('ZCARD', KEYS[2]) >= 3 then
  local first = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  return {-4, math.max(1, math.min(60, math.ceil((tonumber(first[2]) - tonumber(ARGV[1])) / 1000)))}
end
redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], 172800)
redis.call('INCRBY', KEYS[3], ARGV[5]); redis.call('EXPIRE', KEYS[3], 172800)
redis.call('INCRBY', KEYS[4], ARGV[5]); redis.call('EXPIRE', KEYS[4], 3456000)
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[4]); redis.call('EXPIRE', KEYS[2], 60)
return 1`;
const ADMIT = `
if tonumber(redis.call('GET', KEYS[2]) or '0') >= ${REQUEST_LIMITS.day} then return -2 end
if tonumber(redis.call('GET', KEYS[1]) or '0') >= ${REQUEST_LIMITS.minute} then return -1 end
if tonumber(redis.call('GET', KEYS[4]) or '0') >= ${REQUEST_LIMITS.globalDay} then return -4 end
if tonumber(redis.call('GET', KEYS[3]) or '0') >= ${REQUEST_LIMITS.globalHour} then return -3 end
redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], 120)
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], 172800)
redis.call('INCR', KEYS[3]); redis.call('EXPIRE', KEYS[3], 7200)
redis.call('INCR', KEYS[4]); redis.call('EXPIRE', KEYS[4], 172800)
return 1`;
const ADMIT_WORK = `
local minute = math.max(tonumber(redis.call('GET', KEYS[1]) or '0'), tonumber(redis.call('GET', KEYS[3]) or '0'))
local day = math.max(tonumber(redis.call('GET', KEYS[2]) or '0'), tonumber(redis.call('GET', KEYS[4]) or '0'))
if day >= tonumber(ARGV[2] or '${WORK_LIMITS.ai.day}') then return -2 end
if minute >= tonumber(ARGV[1] or '${WORK_LIMITS.ai.minute}') then return -1 end
-- Seed from the larger historical/current count before incrementing. Merely
-- comparing the maximum and incrementing a smaller new count grants extra work.
-- Historical keys are never changed; each work class carries its own baseline.
redis.call('SET', KEYS[1], minute + 1, 'EX', 120)
redis.call('SET', KEYS[2], day + 1, 'EX', 172800)
return 1`;
function windowRetry(now, milliseconds) { return Math.max(1, Math.ceil((milliseconds - now % milliseconds) / 1000)); }
function monthRetry(now) {
  const date = new Date(now);
  return Math.max(1, Math.ceil((Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - now) / 1000));
}
function quotaError(quotaCode, retryAfter) {
  const error = new Error('Ask allowance reached');
  error.quota = true; error.quotaCode = quotaCode; error.retryAfter = retryAfter;
  return error;
}
function identityFor(config, req, day) {
  return createHmac('sha256', config.abuseSecret).update(`${day}:${req.ip || req.socket?.remoteAddress || 'unknown'}`).digest('hex');
}
function money(value) { return /^\d+(\.\d{1,6})?$/.test(value || '') ? Math.round(Number(value) * 1e6) : NaN; }
function budgetConfig(env, { authenticatedStaging = false } = {}) {
  // Constructor-only opt-in, coupled to a separate staging entrypoint flag.
  // A request body/header can never change the admission mode.
  const staging = authenticatedStaging === true && env.ASK_STAGING_ENABLED === 'true';
  const dailyBudget = money(env.ASK_DAILY_BUDGET_USD);
  const monthlyBudget = money(env.ASK_MONTHLY_BUDGET_USD);
  const inputRate = Number(env.ASK_MAX_INPUT_USD_PER_MILLION);
  const outputRate = Number(env.ASK_MAX_OUTPUT_USD_PER_MILLION);
  if (![dailyBudget, monthlyBudget].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1e9)
    || ![inputRate, outputRate].every(value => Number.isFinite(value) && value > 0 && value <= 1000)
    || !env.ASK_ABUSE_SECRET || env.ASK_ABUSE_SECRET.length < 32
    || !staging && (!env.ASK_TURNSTILE_SECRET || !env.ASK_TURNSTILE_HOSTNAME || !env.ASK_TURNSTILE_SITE_KEY)) return null;
  return { dailyBudget, monthlyBudget, inputRate, outputRate, abuseSecret: env.ASK_ABUSE_SECRET, challengeSecret: staging ? null : env.ASK_TURNSTILE_SECRET, challengeHostname: staging ? null : env.ASK_TURNSTILE_HOSTNAME, siteKey: staging ? null : env.ASK_TURNSTILE_SITE_KEY, ...(staging ? { authenticatedStaging: true } : {}) };
}
// Planning calls that reason need room for reasoning tokens inside the cap.
const MAX_OUTPUT_TOKENS = 4000;
function maximumCost(config, body) {
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > 48000) throw new Error('Context too large');
  let request;
  try { request = JSON.parse(body); } catch { /* Legacy text callers reserve the default cap. */ }
  const caps = [request?.max_completion_tokens, request?.max_tokens].filter(value => value !== undefined);
  if (caps.some(value => !Number.isInteger(value) || value < 1 || value > MAX_OUTPUT_TOKENS)) throw new Error('Invalid provider output allowance');
  const outputTokens = Math.max(500, ...caps);
  // UTF-8 bytes conservatively bound text tokens; overhead covers provider
  // wrappers and schema handling. Output includes reasoning within token cap.
  return Math.ceil((bytes + 4096) * config.inputRate + outputTokens * config.outputRate);
}
async function reserve(redis, config, body, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const active = 'ask:{mainnet}:active';
  const lease = randomUUID();
  const result = await redis.eval(RESERVE, {
    keys: [`ask:{mainnet}:calls:${day}`, active, `ask:{mainnet}:usd:${day}`, `ask:{mainnet}:usd:${day.slice(0, 7)}`],
    arguments: [String(now), String(now + 60000), String(config.dailyCalls), lease, String(maximumCost(config, body)), String(config.dailyBudget), String(config.monthlyBudget)],
  });
  const code = Number(Array.isArray(result) ? result[0] : result);
  if (code !== 1) {
    if (code === -1) throw quotaError('ask-ai-calls-day', windowRetry(now, 86400000));
    if (code === -2) throw quotaError('ask-ai-budget-day', windowRetry(now, 86400000));
    if (code === -3) throw quotaError('ask-ai-budget-month', monthRetry(now));
    const retryAfter = Array.isArray(result) ? Number(result[1]) : NaN;
    if (code === -4 && Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60) throw quotaError('ask-ai-busy', retryAfter);
    throw askError('unavailable');
  }
  return async () => { try { await redis.zRem(active, lease); } catch { /* lease expires */ } };
}
async function admitWork(redis, config, req, kind, now = Date.now()) {
  if (kind !== 'ai' && kind !== 'sql') throw new TypeError('Invalid Ask work class');
  const day = new Date(now).toISOString().slice(0, 10), identity = identityFor(config, req, day);
  const prefix = `ask:{mainnet}:work:${kind}:${identity}`, legacy = `ask:{mainnet}:ip:${identity}`;
  const minute = Math.floor(now / 60000);
  const result = Number(await redis.eval(ADMIT_WORK, {
    keys: [`${prefix}:${minute}`, `${prefix}:day`, `${legacy}:${minute}`, `${legacy}:day`], arguments: [String(WORK_LIMITS[kind].minute), String(WORK_LIMITS[kind].day)],
  }));
  if (result === -1) throw quotaError(`ask-${kind}-minute`, windowRetry(now, 60000));
  if (result === -2) throw quotaError(`ask-${kind}-day`, windowRetry(now, 86400000));
  if (result !== 1) throw askError('unavailable');
}
async function admit(redis, config, req, fetchImpl = fetch) {
  // The router's per-process attempt limiter runs before this check. Reject
  // invalid verification before touching shared request counters, so unverified
  // callers cannot drain the site-wide ordinary allowance without admission.
  if (config.authenticatedStaging === true) {
    if (req.v1?.authenticatedStaging !== true) throw askError('verification');
    // Pinned authenticated mTLS gateway replaces CAPTCHA only here.
  } else {
    const token = req.body?.challenge;
    if (typeof token !== 'string' || !token || token.length > 2048) throw askError('verification');
    const response = await askStage('verification', () => fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', redirect: 'error', signal: AbortSignal.any([req.v1.abortSignal, AbortSignal.timeout(5000)]), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: config.challengeSecret, response: token }) }));
    if (!response.ok) throw askError('verification');
    const result = await askStage('verification', () => response.json());
    if (!result.success || result.action !== 'ask' || result.hostname !== config.challengeHostname) throw askError('verification');
  }
  // Compute the charged UTC windows after verification, which may cross a reset.
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const identity = identityFor(config, req, day), prefix = `ask:{mainnet}:requests:ip:${identity}`;
  const admission = Number(await redis.eval(ADMIT, {
    keys: [`${prefix}:${Math.floor(now / 60000)}`, `${prefix}:day`, `ask:{mainnet}:requests:hour:${new Date(now).toISOString().slice(0, 13)}`, `ask:{mainnet}:requests:day:${day}`], arguments: [],
  }));
  if (admission !== 1) {
    const failure = { '-1': ['ask-request-minute', 60000], '-2': ['ask-request-day', 86400000], '-3': ['ask-request-global-hour', 3600000], '-4': ['ask-request-global-day', 86400000] }[admission];
    if (failure) throw quotaError(failure[0], windowRetry(now, failure[1]));
    throw askError('unavailable');
  }
}
module.exports = { RESERVE, ADMIT, ADMIT_WORK, REQUEST_LIMITS, WORK_LIMITS, budgetConfig, maximumCost, reserve, admit, admitWork, identityFor };
