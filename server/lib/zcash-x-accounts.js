'use strict';

/**
 * Zcash ecosystem X accounts the owner follows for news, schedules and tone.
 * Used by the calendar watcher (schedule posts) and x-pulse (trends and style
 * before drafting posts for @zecblock or @k6nb4k). Handles only; no claims
 * about who runs each account. Edit this list to change both tools.
 */
const ZCASH_X_ACCOUNTS = [
  'ZcashFoundation', 'zcash', 'ShieldedLabs', 'zodl_app', 'ZakuraZcash', 'ZcashLabs', 'vizorwallet',
  'cypherpunk', 'ebfull', 'zkDragon', 'aquietinvestor', 'maxdesalle', 'evansforbes', 'jswihart', 'zooko', 'bajpaiharsh244',
];

/** Our own accounts: excluded from "what others are doing", used as the voice baseline. */
const OWN_X_ACCOUNTS = ['zecblock', 'k6nb4k'];

const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

function parseAccounts(value, fallback = ZCASH_X_ACCOUNTS) {
  const list = (value ? String(value).split(',') : fallback).map(a => a.trim().replace(/^@/, '')).filter(a => HANDLE.test(a));
  return [...new Map(list.map(a => [a.toLowerCase(), a])).values()];
}

/**
 * Split `from:` clauses into X search queries that stay under the query
 * length limit (512 characters on the basic tiers) together with `suffix`.
 */
function fromQueries(accounts, suffix = '', limit = 512) {
  const queries = [];
  let group = [];
  const build = g => `(${g.map(a => `from:${a}`).join(' OR ')})${suffix ? ` ${suffix}` : ''}`;
  for (const account of accounts) {
    if (group.length && build([...group, account]).length > limit) { queries.push(build(group)); group = []; }
    group.push(account);
  }
  if (group.length) queries.push(build(group));
  return queries;
}

module.exports = { ZCASH_X_ACCOUNTS, OWN_X_ACCOUNTS, parseAccounts, fromQueries };
