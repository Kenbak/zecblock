'use strict';

/**
 * Pure helpers for the Zcash calendar source watcher. Forum and release text
 * is untrusted data: it is only parsed into candidate dates and block heights
 * for a human to review. Nothing here edits the calendar.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_RE = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?(?:\\s*\\((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\))?`, 'gi');
const ISO_RE = /\b(20\d\d)-(\d\d)-(\d\d)(?:[T\s](\d\d):(\d\d)(?::\d\d)?\s*(?:Z|UTC))?/g;
const TIME_RE = /^\s*(?:@|at)?\s*(\d{1,2}):(\d\d)\s*(?:UTC|GMT|Z)\b/i;

/** Discourse cooked HTML → plain text with line breaks preserved. */
function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(?:br|\/p|\/li|\/h\d|\/tr|\/div)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&#8217;/g, '’')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const pad = n => String(n).padStart(2, '0');

/** Year for a month/day without one: the occurrence nearest the post date. */
function inferYear(month, day, reference) {
  const ref = new Date(reference);
  const year = ref.getUTCFullYear();
  const candidates = [year - 1, year, year + 1].map(y => ({ y, t: Date.UTC(y, month, day) }));
  // Announcements look forward: prefer dates from 60 days before the post onward.
  const forward = candidates.filter(c => c.t >= ref.getTime() - 60 * 86_400_000);
  return (forward.length ? forward : candidates).sort((a, b) => Math.abs(a.t - ref.getTime()) - Math.abs(b.t - ref.getTime()))[0].y;
}

/** Short label for a date: the words on the same line before it ("Polling/Voting Period"). */
function labelBefore(text, index) {
  const line = text.slice(0, index).split('\n').pop();
  const clause = line.split(/(?<=[.!?])\s+/).pop();
  return clause.replace(/[:\-–—(@\s]+$/, '').replace(/^[\s•*\-–]+/, '').slice(-80).trim();
}

/**
 * Dates mentioned in text. A UTC time right after a date (or after the end of a
 * "A – B @ 20:00 UTC" range) attaches to that date; other dates stay date-only.
 */
function extractDates(text, reference) {
  const found = [];
  for (const match of text.matchAll(DATE_RE)) {
    const month = MONTHS.findIndex(m => m.startsWith(match[1].toLowerCase().slice(0, 3)));
    const day = Number(match[2]);
    if (month < 0 || day < 1 || day > 31) continue;
    const year = match[3] ? Number(match[3]) : inferYear(month, day, reference);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 24);
    const time = after.match(TIME_RE);
    const isRangeStart = /^\s*[–—-]\s*/.test(after) && new RegExp(`^\\s*[–—-]\\s*${MONTH_RE}`, 'i').test(after);
    const date = `${year}-${pad(month + 1)}-${pad(day)}`;
    if (Number.isNaN(Date.parse(date))) continue;
    // A yearless date far ahead of the post is usually a past month in a work summary.
    if (!match[3] && Date.parse(date) - Date.parse(reference) > 183 * 86_400_000) continue;
    found.push({
      date,
      at: time ? `${date}T${pad(time[1])}:${time[2]}:00Z` : null,
      label: labelBefore(text, match.index),
      role: isRangeStart ? 'start' : 'single',
      excerpt: text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 24).replace(/\s+/g, ' ').trim(),
    });
  }
  for (const match of text.matchAll(ISO_RE)) {
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    if (Number.isNaN(Date.parse(date))) continue;
    found.push({ date, at: match[4] ? `${date}T${match[4]}:${match[5]}:00Z` : null, label: labelBefore(text, match.index), role: 'single', excerpt: match[0] });
  }
  // A range "A – B @ time" carries the time on its end; mark ends of ranges explicitly.
  for (let i = 1; i < found.length; i++) if (found[i - 1].role === 'start' && found[i].role === 'single') {
    found[i].role = 'end';
    found[i].label ||= found[i - 1].label;
  }
  const unique = new Map();
  for (const item of found) {
    const key = `${item.at ?? item.date}|${item.label}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

/**
 * Block heights explicitly named as a block/height/snapshot/activation, with
 * the sentence they appear in. Heights the source places on testnet are dropped.
 */
function extractHeights(text) {
  const heights = new Map();
  const re = /\b(?:block(?:\s+height)?|height|snapshot(?:\s+block)?|activation(?:\s+height)?|activates\s+at)\s*(?:#|:|=|of|at|is)?\s*#?([1-9]\d{0,2}(?:,\d{3}){1,2}|[1-9]\d{5,8})\b/gi;
  for (const match of text.matchAll(re)) {
    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isSafeInteger(value) || value < 100_000 || value >= 100_000_000 || heights.has(value)) continue;
    const start = Math.max(text.lastIndexOf('\n', match.index), text.lastIndexOf('. ', match.index - 2) + 1, match.index - 200);
    const end = [text.indexOf('\n', match.index), text.indexOf('. ', match.index)].filter(i => i >= 0).reduce((a, b) => Math.min(a, b), Math.min(text.length, match.index + 200));
    const excerpt = text.slice(start, end).replace(/\s+/g, ' ').trim();
    // "...Testnet past NU7 at height X, or Mainnet past NU7 at height Y": look at the words right before the height.
    const lead = text.slice(Math.max(0, match.index - 60), match.index).toLowerCase();
    const t = lead.lastIndexOf('testnet'), m = lead.lastIndexOf('mainnet');
    const network = t > m ? 'testnet' : m > t ? 'mainnet' : /testnet/i.test(excerpt) && !/mainnet/i.test(excerpt) ? 'testnet' : 'unspecified';
    heights.set(value, { value, excerpt, network });
  }
  return [...heights.values()].filter(h => h.network !== 'testnet').sort((a, b) => a.value - b.value);
}

const SIGNAL = /\b(vote|voting|poll(?:ing)?|snapshot|ballot|call for proposals|review period|deadline|network upgrade|NU\d(?:\.\d)?|activation|activates|hard fork|halving|election|results?|schedule|dates?)\b/i;

/**
 * Whether a forum topic could carry a calendar event. Applications and
 * nominations in the grants category are excluded; organizer posts are not.
 */
function isCandidateTopic({ title, categoryId, author }, trustedAuthors = []) {
  if (/^\s*(retroactive grant application|retroactive grant nomination|grant application)\b/i.test(title)) return false;
  if (categoryId === 54) return trustedAuthors.includes(author) || /\b(call for proposals|review period|voting|vote|results|dates)\b/i.test(title);
  return trustedAuthors.includes(author) || SIGNAL.test(title);
}

function classify(title, text = '') {
  const t = `${title}\n${text.slice(0, 600)}`;
  if (/\b(NU\d(?:\.\d)?|network upgrade|activation height|hard fork)\b/i.test(t)) return 'upgrade';
  if (/\bhalving\b/i.test(title)) return 'halving';
  if (/\bsnapshot\b/i.test(t) && /\b(vote|poll|ballot)\b/i.test(t)) return 'snapshot';
  if (/\b(vote|voting|poll|ballot|election)\b/i.test(t)) return 'vote';
  if (/\b(deadline|call for proposals|review period|submission)\b/i.test(t)) return 'deadline';
  return 'other';
}

/** Topic and date identities already in the calendar, read from its source files. */
function knownCalendar(sources) {
  const topics = new Set();
  const dates = new Set();
  const heights = new Set();
  for (const text of sources) {
    for (const m of text.matchAll(/forum\.zcashcommunity\.com\/t\/(?:[^/'"\s]+\/)?(\d+)/g)) topics.add(Number(m[1]));
    for (const m of text.matchAll(/topicIds:\s*\[([^\]]*)\]/g)) for (const n of m[1].match(/\d+/g) ?? []) topics.add(Number(n));
    for (const m of text.matchAll(/'(20\d\d-\d\d-\d\d)(?:T\d\d:\d\d:\d\dZ)?'/g)) dates.add(m[1]);
    for (const m of text.matchAll(/\b(\d{1,2}_\d{3}_\d{3}|\d{6,8})\b/g)) heights.add(Number(m[1].replace(/_/g, '')));
  }
  return { topics, dates, heights };
}

const escapeMarkdown = value => String(value).replace(/([_*`\[\]])/g, '\\$1');

/** One Telegram message (Markdown) for a batch of candidates; trimmed under Telegram's limit. */
function formatDigest(candidates, { max = 3500 } = {}) {
  const lines = [`*Calendar watch* · ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} to review`];
  for (const c of candidates) {
    const block = [`\n${c.tracked ? '↻' : '•'} *${escapeMarkdown(c.title)}*`, `${escapeMarkdown(c.kind)} · ${escapeMarkdown(c.source)}${c.tracked ? ' · tracked topic edited' : ''}`];
    for (const d of c.dates.slice(0, 6)) block.push(`  ${d.known ? '✓' : '+'} ${escapeMarkdown(d.at ? `${d.at.slice(0, 16).replace('T', ' ')} UTC` : d.date)}${d.label ? ` — ${escapeMarkdown(d.label)}` : ''}`);
    for (const h of c.heights.slice(0, 4)) block.push(`  ${h.known ? '✓' : '+'} block #${h.value.toLocaleString('en-US')} — ${escapeMarkdown(h.excerpt.slice(0, 160))}`);
    block.push(`  ${c.url}`);
    const next = [...lines, ...block].join('\n');
    if (next.length > max) { lines.push(`\n…and ${candidates.length - candidates.indexOf(c)} more (run the watcher with --preview)`); break; }
    lines.push(...block);
  }
  lines.push('\n✓ already in the calendar · + new. Add approved events to lib/grant-rounds.ts or lib/zcash-calendar.ts.');
  return lines.join('\n');
}

module.exports = { htmlToText, extractDates, extractHeights, isCandidateTopic, classify, knownCalendar, formatDigest, inferYear };
