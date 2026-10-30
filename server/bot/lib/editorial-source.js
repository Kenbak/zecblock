'use strict';

const { addDays } = require('../../lib/transaction-activity');

const ORIGIN = 'https://zecblock.com';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDay = value => typeof value === 'string' && DATE.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

function sourceUrl(value) {
  const url = new URL(value);
  if (url.origin !== ORIGIN || url.username || url.password || /^\/(?:api|v1)(?:\/|$)/.test(url.pathname)) {
    throw new Error('Unexpected editorial source URL');
  }
  return url.toString();
}

function chartSource(story, original) {
  const e = story.evidence || {};
  // Legacy activity evidence carries its original pre-rebrand sourceUrl. It is
  // provenance, not an override of the current builder's canonical destination.
  if (e.editorialSourceUrl) return sourceUrl(e.editorialSourceUrl);
  const chart = story.type === 'activity_daily' ? e.metric === 'share' ? 'privacy-adoption'
    : ['shielded', 'total'].includes(e.metric) ? 'daily-activity' : null
    : story.type === 'network_signal' ? ({ mvrv: 'mvrv', daily_fees_zat: null,
        shield_volume_zat: 'flow-volume', deshield_volume_zat: 'flow-volume' })[e.metric]
        : null;
  return chart ? `${ORIGIN}/charts/${chart}?range=30d` : original;
}

function scope(story) {
  const type = story.type, e = story.evidence || {};
  if (type === 'swap' || type === 'crosschain_daily') return 'Tracked successful NEAR Intents swaps; provider-reported source USD.';
  if (type.startsWith('flow_')) return 'Public pool-boundary flow; private transferred amounts are not visible.';
  if (type === 'migration') return 'Pool migration, not new shielding.';
  if (type === 'pool_trend') return 'Net public Sapling/Orchard/Ironwood flows; Sprout and migrations excluded.';
  if (type === 'hashrate') return 'Estimated mining power; seven-day windows.';
  if (type === 'halving') return 'Estimated from consensus target spacing; actual timing follows block production.';
  if (type === 'nu7') return ({
    countdown: 'Serving-node NU7 schedule. Node protocol versions are self-reported.',
    activation: 'Serving-node NU7 schedule; canonical block data.',
    first_day: 'Canonical block-header times, not arrival times.',
    blocks: 'Canonical block-header times, not arrival times.',
    nsm: 'Node-reported NSM reserve change since activation, in exact zatoshi.',
  })[e.nu7Kind] || '';
  if (e.metric === 'mvrv') return 'Modeled cost basis; not holder profit or a price forecast.';
  if (e.metric === 'exchange_deposit_zat') return 'Tracked transparent exchange deposits; not necessarily sales.';
  if (type.startsWith('activity_') || type === 'network_briefing' || e.achievements) return 'Canonical non-coinbase activity; counts do not measure users.';
  return '';
}

// Keep the dated observation in the post; existing chart pages update over time.
// We do not invent unsupported end-date query parameters or immutable snapshots.
function observation(story) {
  const e = story.evidence || {};
  const period = e.period || e.achievements?.find(a => a.id === e.lead)?.period;
  if (validDay(period?.start) && validDay(period?.endExclusive)) {
    return `${period.start}–${addDays(period.endExclusive, -1)} UTC.`;
  }
  const target = e.target || story.key?.split(':').at(-1);
  if (validDay(target)) return `${target} UTC.`;
  return '';
}

function preparePublication(story) {
  if (!story.content || story.content.length > 280) throw new Error('Refusing invalid editorial copy');
  const links = [...story.content.matchAll(/https?:\/\/[^\s]+/g)];
  // Source-less internal fixtures and legacy callers retain their single-post
  // behavior; every scheduled production builder supplies a canonical URL.
  if (!links.length) return { content: story.content, sourceReply: null };
  if (links.length !== 1 || story.content.slice(links[0].index + links[0][0].length).trim()) {
    throw new Error('Editorial source must be one trailing URL');
  }
  const original = sourceUrl(links[0][0]);
  const url = chartSource(story, original);
  const content = story.content.slice(0, links[0].index).trim();
  if (!content) throw new Error('Editorial parent has no story');
  const notes = [observation(story), scope(story)].filter(Boolean).join(' ');
  const live = /\/charts\//.test(url) ? ' Chart updates over time.' : '';
  const reply = `Source & data\n${url}${notes ? `\n\n${notes}` : ''}${live}`;
  if (reply.length > 280) throw new Error('Editorial source reply exceeds 280 characters');
  return { content, sourceReply: { content: reply, url } };
}

module.exports = { preparePublication, sourceUrl };
