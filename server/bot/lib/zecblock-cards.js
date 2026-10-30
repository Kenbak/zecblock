'use strict';

// Social cards share the site's type and palette. Chart stories lead with the
// event, then give the evidence enough room to read in a small social preview.
const { createCanvas, registerFont, loadImage } = require('canvas');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { floorTo } = require('./editorial-format');

const ASSETS = path.join(__dirname, '..', 'assets');
const LOGO = path.join(__dirname, '..', '..', '..', 'public', 'brand', 'zecblock-logotype.png');
const W = 1200, H = 675, PAD = 80;

// Dark tokens from app/globals.css and lib/chart-theme.ts.
const C = {
  bg: '#0B0C0E', surface: '#111316', border: '#24272D', grid: '#2C3037',
  text: '#F1F3F5', secondary: '#C2C7CF', muted: '#9CA4B0', faint: '#565D68',
  gold: '#F8BC21', ironwood: '#E8CF78', orchard: '#B6A0E0', sapling: '#91AC90',
  in: '#65C79A', out: '#E8776A',
};
const TONES = { in: C.in, out: C.out, gold: C.gold, ironwood: C.ironwood, text: C.text, muted: C.faint };
const NODE_FILL = { ironwood: C.ironwood, orchard: C.orchard, sapling: C.sapling, gold: C.gold };
const CHAIN_ICONS = { trx: 'tron', bnb: 'bsc', matic: 'pol' };

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  const font = name => path.join(ASSETS, 'fonts', name);
  registerFont(font('Geist-Medium.ttf'), { family: 'Geist', weight: '500' });
  registerFont(font('Geist-Regular.ttf'), { family: 'Geist', weight: 'normal' });
  registerFont(font('GeistMono-Regular.ttf'), { family: 'GeistMono', weight: 'normal' });
  fontsReady = true;
}

const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d });
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const dateLabel = (value, short = false) => new Date(`${value}T00:00:00Z`)
  .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(short ? {} : { year: 'numeric' }) });

// Shrinks a line to fit, down to a floor; past that the card is refused and
// the post falls back to text rather than clipping wording.
function fit(ctx, text, weight, size, min, width, family = 'Geist') {
  for (let s = size; s >= min; s -= 2) {
    ctx.font = `${weight} ${s}px ${family}`;
    if (ctx.measureText(text).width <= width) return s;
  }
  throw new Error('Card text exceeds safe bounds');
}

function wrappedText(ctx, text, x, y, { width, size = 32, min = 26, lines = 2, color = C.text, gap = 1.18 } = {}) {
  const words = String(text).trim().split(/\s+/);
  for (let fontSize = size; fontSize >= min; fontSize -= 2) {
    ctx.font = `500 ${fontSize}px Geist`;
    const result = [''];
    let fits = true;
    for (const word of words) {
      if (ctx.measureText(word).width > width) { fits = false; break; }
      const last = result.length - 1, next = result[last] ? `${result[last]} ${word}` : word;
      if (ctx.measureText(next).width <= width) result[last] = next;
      else result.push(word);
    }
    if (!fits || result.length > lines) continue;
    ctx.fillStyle = color;
    result.forEach((line, i) => ctx.fillText(line, x, y + i * fontSize * gap));
    return;
  }
  throw new Error('Card text exceeds safe bounds');
}

function drawChartHeading(ctx, card, accent) {
  wrappedText(ctx, card.title || card.line, PAD, 155, { width: W - 2 * PAD, size: 36, min: 30 });
  const unit = card.unit ? ` ${card.unit}` : '';
  fit(ctx, `${card.hero}${unit}`, '500', 78, 44, 550);
  ctx.fillStyle = accent;
  ctx.fillText(`${card.hero}${unit}`, PAD - 3, 257);
  if (card.qualifier) wrappedText(ctx, card.qualifier, 680, 224, {
    width: W - PAD - 680, size: 24, min: 20, color: C.secondary,
  });
}

async function drawFrame(ctx, kicker, accent) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.font = 'normal 20px GeistMono';
  ctx.fillStyle = accent;
  ctx.fillText('>', PAD, 96);
  ctx.fillStyle = C.muted;
  ctx.fillText(kicker.toUpperCase(), PAD + 26, 96);
  const logo = await loadImage(LOGO);
  const lh = 30, lw = logo.width * lh / logo.height;
  ctx.drawImage(logo, W - PAD - lw, 73, lw, lh);
}

function drawText(ctx, card, accent, width) {
  // Hero shares one line with its unit; both shrink together if needed.
  const unitGap = card.unit ? 18 : 0;
  let size = 150;
  for (; size >= 72; size -= 4) {
    ctx.font = `500 ${size}px Geist`;
    const heroW = ctx.measureText(card.hero).width;
    ctx.font = `500 ${Math.round(size * 0.34)}px Geist`;
    if (heroW + (card.unit ? unitGap + ctx.measureText(card.unit).width : 0) <= width) break;
  }
  if (size < 72) throw new Error('Card headline exceeds safe bounds');
  const y = 290;
  ctx.font = `500 ${size}px Geist`;
  ctx.fillStyle = accent;
  ctx.fillText(card.hero, PAD - 6, y);
  if (card.unit) {
    const x = PAD - 6 + ctx.measureText(card.hero).width + unitGap;
    ctx.font = `500 ${Math.round(size * 0.34)}px Geist`;
    ctx.fillStyle = C.muted;
    ctx.fillText(card.unit, x, y);
  }
  ctx.fillStyle = C.text;
  fit(ctx, card.line, 500, 36, 26, width);
  ctx.fillText(card.line, PAD, 368);
  if (card.qualifier) {
    ctx.fillStyle = C.muted;
    fit(ctx, card.qualifier, 500, 36, 26, width);
    ctx.fillText(card.qualifier, PAD, 416);
  }
}

function drawFooter(ctx, source, date) {
  ctx.fillStyle = C.border;
  ctx.fillRect(PAD, H - 108, W - 2 * PAD, 1);
  ctx.font = 'normal 19px GeistMono';
  ctx.fillStyle = C.muted;
  ctx.fillText(source, PAD, H - 62);
  if (date) ctx.fillText(date, W - PAD - ctx.measureText(date).width, H - 62);
}

function chartValue(value, unit, { signed = false } = {}) {
  const magnitude = Math.abs(value), sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  if (unit === 'Sol/s') {
    for (const [scale, suffix] of [[1e12, 'TSol/s'], [1e9, 'GSol/s'], [1e6, 'MSol/s'], [1e3, 'KSol/s']]) {
      if (magnitude >= scale) return `${sign}${fmt(floorTo(magnitude / scale, 2), 2)} ${suffix}`;
    }
  }
  const digits = magnitude > 0 && magnitude < 0.01 ? 8 : unit === '%' ? 1 : 2;
  const number = magnitude >= 1e9 ? `${fmt(floorTo(magnitude / 1e9, 2), 2)}B`
    : magnitude >= 1e6 ? `${fmt(floorTo(magnitude / 1e6, 2), 2)}M`
      : magnitude >= 1e4 ? `${fmt(floorTo(magnitude / 1e3, 1), 1)}K` : fmt(floorTo(magnitude, digits), digits);
  return `${sign}${unit === 'USD' ? '$' : ''}${number}${unit && unit !== 'USD' ? unit === '%' ? '%' : ` ${unit}` : ''}`;
}

// Older builders have dated evidence but no chart metadata. Only recover dates
// from that evidence; a target date alone does not prove a contiguous history.
function seriesModel(story) {
  const evidence = story.evidence, card = evidence.card, v = card.visual;
  const values = v.values;
  if (!Array.isArray(values) || values.length < 1 || Array.from(values).some(n => !Number.isFinite(n) || (!v.allowNegative && n < 0))) {
    throw new Error('Missing editorial value');
  }
  if (v.reference != null && (!Number.isFinite(v.reference) || (!v.allowNegative && v.reference < 0))) throw new Error('Invalid chart reference');
  const metric = evidence.metric;
  const unit = v.unit || (story.type === 'activity_daily' ? metric === 'share' ? '%' : 'transactions'
    : story.type === 'hashrate' ? 'Sol/s' : metric === 'mvrv' ? 'ratio'
      : metric === 'shielded_share' ? '%' : metric === 'shielded_usd' ? 'USD'
        : metric?.endsWith('_zat') || metric?.endsWith('_zec') ? 'ZEC' : card.unit || '');
  const label = v.label || (story.type === 'hashrate' ? '7-day average hashrate'
    : story.type === 'activity_daily' ? metric === 'share' ? 'Shielded share of transactions' : 'Transactions per UTC day'
      : metric === 'mvrv' ? 'MVRV ratio' : card.kicker.replace(/^[^·]+·\s*/, ''));
  let start = v.start, end = v.end;
  if ((start != null) !== (end != null) || (start != null && !validDate(start)) || (end != null && !validDate(end))) {
    throw new Error('Invalid chart dates');
  }
  if (!start && !end) {
    const rows = evidence.days || evidence.rows;
    if (Array.isArray(rows) && rows.length >= values.length) {
      const dates = rows.slice(-values.length).map(row => row.date);
      if (dates.every(validDate) && dates.every((date, i) => !i || Date.parse(date) - Date.parse(dates[i - 1]) === 86400000)) {
        start = dates[0]; end = dates.at(-1);
      }
    } else if (story.type === 'hashrate' && evidence.point?.date) {
      end = evidence.point.date.slice(0, 10);
      if (validDate(end)) start = new Date(Date.parse(end) - (values.length - 1) * 86400000).toISOString().slice(0, 10);
      else end = undefined;
    }
    if (!end && validDate(evidence.target)) end = evidence.target;
  }
  if (start && end && ((Date.parse(end) - Date.parse(start)) / 86400000 + 1 !== values.length)) throw new Error('Invalid chart date span');
  const low = Math.min(...values, v.reference ?? 0, 0), high = Math.max(...values, v.reference ?? 0, 0);
  const min = v.scale?.min ?? (low < 0 ? low * 1.1 : 0);
  const max = v.scale?.max ?? (high > 0 ? high * 1.1 : low < 0 ? 0 : 1);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > 0 || max < 0 || min >= max
    || values.some(value => value < min || value > max) || (v.reference != null && (v.reference < min || v.reference > max))) {
    throw new Error('Invalid chart scale');
  }
  return { ...v, values, unit, label, start, end, min, max };
}

function plotAxes(ctx, { x, y, w, h, min = 0, max, unit, start, end, compactDates = false, tickValues }) {
  const py = value => y + h - (value - min) / (max - min) * h;
  const ticks = tickValues || [...new Set([min, 0, max])];
  ctx.font = 'normal 18px GeistMono';
  for (const value of ticks) {
    ctx.strokeStyle = value === 0 ? C.faint : C.border; ctx.lineWidth = value === 0 ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(x, py(value)); ctx.lineTo(x + w, py(value)); ctx.stroke();
    const label = chartValue(value, ['%', 'USD', 'Sol/s'].includes(unit) ? unit : '');
    fit(ctx, label, 'normal', 18, 14, x - PAD - 14, 'GeistMono');
    ctx.fillStyle = C.muted;
    ctx.fillText(label, x - 14 - ctx.measureText(label).width, py(value) + 6);
  }
  ctx.font = 'normal 18px GeistMono'; ctx.fillStyle = C.muted;
  const short = compactDates && start && end && start.slice(0, 4) === end.slice(0, 4);
  const first = start && start === end ? 'One complete reporting window' : start ? dateLabel(start, short) : 'Earlier observations';
  const last = end ? `${dateLabel(end, short)} UTC` : 'Latest observation';
  ctx.fillText(first, x, 540);
  ctx.fillText(last, x + w - ctx.measureText(last).width, 540);
  return py;
}

function drawSeries(ctx, v, accent) {
  const x = 195, y = 354, w = W - PAD - x, h = 150;
  const { values, unit, min, max } = v;
  ctx.fillStyle = C.secondary;
  fit(ctx, v.label, '500', 22, 18, 650);
  ctx.fillText(v.label, PAD, 302);
  const latest = `Latest: ${chartValue(values.at(-1), unit, { signed: v.allowNegative })}`;
  fit(ctx, latest, 'normal', 20, 16, 370, 'GeistMono');
  ctx.fillStyle = accent; ctx.fillText(latest, W - PAD - ctx.measureText(latest).width, 302);
  if (v.reference != null) {
    const reference = `${v.referenceLabel || 'Reference'}: ${chartValue(v.reference, unit, { signed: v.allowNegative })}`;
    fit(ctx, reference, 'normal', 18, 16, W - 2 * PAD, 'GeistMono');
    ctx.fillStyle = C.muted; ctx.fillText(reference, PAD, 331);
  }
  const py = plotAxes(ctx, { x, y, w, h, min, max, unit, start: v.start, end: v.end });
  const px = i => values.length === 1 ? x + w : x + i / (values.length - 1) * w;
  if (v.reference != null) {
    ctx.strokeStyle = C.muted; ctx.lineWidth = 1.5; ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(x, py(v.reference)); ctx.lineTo(x + w, py(v.reference)); ctx.stroke(); ctx.setLineDash([]);
  }
  const trace = () => values.forEach((n, i) => (i ? ctx.lineTo(px(i), py(n)) : ctx.moveTo(px(i), py(n))));
  // A first complete weekly window has one observation. It gets a marker,
  // without an area that could suggest an invented earlier observation.
  if (values.length > 1) {
    // Fill to the actual zero line, including signed net flows below zero.
    ctx.beginPath(); trace(); ctx.lineTo(x + w, py(0)); ctx.lineTo(x, py(0)); ctx.closePath();
    ctx.fillStyle = `${accent}18`; ctx.fill();
  }
  ctx.beginPath(); trace(); ctx.strokeStyle = accent; ctx.lineWidth = 3.5; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.fillStyle = accent; ctx.fillRect(px(values.length - 1) - 6, py(values.at(-1)) - 6, 12, 12);
}

// Both pools share one zero-based transaction scale. Orchard's dashed trace
// and outlined endpoint remain visible when the two series meet or overlap.
function drawComparison(ctx, v, card) {
  const keys = ['ironwood', 'orchard'];
  if (typeof v.label !== 'string' || !v.label.trim() || v.unit !== 'transactions'
    || !validDate(v.start) || !validDate(v.end) || !Array.isArray(v.series)
    || v.series.length !== 2 || new Set(v.series.map(s => s?.key)).size !== 2
    || v.periodDays != null && ![7, 30, 365].includes(v.periodDays)) {
    throw new Error('Invalid comparison evidence');
  }
  const series = keys.map(key => v.series.find(s => s?.key === key));
  const length = series[0]?.values?.length;
  if (!Number.isInteger(length) || length < 2
    || (Date.parse(v.end) - Date.parse(v.start)) / 86400000 + 1 !== length
    || series.some((s, i) => !s || s.label !== (i ? 'Orchard' : 'Ironwood') || s.tone !== keys[i]
      || !Array.isArray(s.values) || s.values.length !== length
      || Array.from(s.values).some(value => !Number.isSafeInteger(value) || value < 0))) {
    throw new Error('Invalid comparison values or dates');
  }
  const colors = [C.ironwood, C.orchard];
  wrappedText(ctx, card.title || card.line, PAD, 159, { width: W - 2 * PAD, size: 44, min: 36, lines: 1 });
  const description = v.periodDays ? `Rolling ${v.periodDays}-day totals · coinbase excluded` : v.label;
  fit(ctx, description, 'normal', 22, 20, W - 2 * PAD);
  ctx.fillStyle = C.muted; ctx.fillText(description, PAD, 197);

  // The chart carries the comparison. Its endpoint labels replace a separate
  // metrics row and connect each measured count to the corresponding line.
  const x = 155, y = 258, w = 665, h = 262;
  const peak = series.reduce((n, s) => s.values.reduce((m, value) => Math.max(m, value), n), 1);
  const step = Math.max(1, 10 ** Math.floor(Math.log10(peak)) / 2);
  const max = Math.ceil(peak * 1.1 / step) * step;
  const px = i => x + i / (length - 1) * w;
  const py = plotAxes(ctx, { x, y, w, h, max, unit: v.unit, start: v.start, end: v.end,
    compactDates: true, tickValues: [0, max / 2, max] });
  ctx.font = 'normal 16px GeistMono'; ctx.fillStyle = C.muted;
  const axisLabel = 'Window end date';
  ctx.fillText(axisLabel, x + (w - ctx.measureText(axisLabel).width) / 2, 540);
  ctx.save();
  series.forEach((s, i) => {
    ctx.beginPath();
    s.values.forEach((value, j) => (j ? ctx.lineTo(px(j), py(value)) : ctx.moveTo(px(j), py(value))));
    ctx.strokeStyle = colors[i]; ctx.lineWidth = 3; ctx.lineJoin = 'round';
    ctx.setLineDash(i ? [7, 5] : []);
    ctx.stroke();
  });
  ctx.setLineDash([]);
  const endX = px(length - 1);
  ctx.fillStyle = colors[0];
  ctx.fillRect(endX - 6, py(series[0].values.at(-1)) - 6, 12, 12);
  ctx.strokeStyle = colors[1]; ctx.lineWidth = 2;
  ctx.strokeRect(endX - 9, py(series[1].values.at(-1)) - 9, 18, 18);

  const labels = series.map((s, i) => ({ s, i, pointY: py(s.values.at(-1)), top: py(s.values.at(-1)) - 24 }))
    .sort((a, b) => a.pointY - b.pointY || a.i - b.i);
  const minTop = y + 4, maxTop = y + h - 58, gap = 86;
  labels[0].top = Math.max(minTop, Math.min(maxTop - gap, labels[0].top));
  labels[1].top = Math.max(labels[0].top + gap, Math.min(maxTop, labels[1].top));
  // Label positions may separate close values; the actual lines and endpoint
  // markers never move. Keep the label order consistent with the data heights.
  const labelX = 910, labelWidth = W - PAD - labelX;
  const totals = series.map(s => fmt(s.values.at(-1)));
  let numberSize = 32, unitSize;
  for (; numberSize >= 16; numberSize -= 2) {
    unitSize = Math.max(14, Math.round(numberSize * 0.6));
    ctx.font = `normal ${unitSize}px Geist`;
    const unitWidth = ctx.measureText('txs').width;
    ctx.font = `500 ${numberSize}px Geist`;
    if (totals.every(total => ctx.measureText(total).width + 8 + unitWidth <= labelWidth)) break;
  }
  if (numberSize < 16) throw new Error('Comparison total exceeds safe bounds');
  labels.forEach(({ s, i, top }) => {
    ctx.font = 'normal 20px Geist'; ctx.fillStyle = colors[i];
    ctx.fillText(s.label, labelX, top + 18);
    ctx.font = `500 ${numberSize}px Geist`; ctx.fillStyle = C.text;
    ctx.fillText(totals[i], labelX, top + 54);
    const unitX = labelX + ctx.measureText(totals[i]).width + 8;
    ctx.font = `normal ${unitSize}px Geist`; ctx.fillStyle = C.muted;
    ctx.fillText('txs', unitX, top + 54);
  });
  ctx.restore();
}

function drawBriefing(ctx, card, accent) {
  const v = card.visual;
  if (!Array.isArray(v.items) || v.items.length < 1 || v.items.length > 3
    || v.items.some(item => typeof item.label !== 'string' || !item.label.trim()
      || typeof item.value !== 'string' || !item.value.trim()
      || item.detail != null && typeof item.detail !== 'string')) throw new Error('Invalid briefing evidence');
  wrappedText(ctx, card.title || `${card.hero} ${card.line}`, PAD, 165, {
    width: W - 2 * PAD, size: 46, min: 34,
  });
  if (card.qualifier) wrappedText(ctx, card.qualifier, PAD, 245, {
    width: W - 2 * PAD, size: 24, min: 22, lines: 1, color: C.muted,
  });
  const gap = 24, width = (W - 2 * PAD - gap * (v.items.length - 1)) / v.items.length;
  v.items.forEach((item, i) => {
    const x = PAD + i * (width + gap), tone = TONES[item.tone] || accent;
    ctx.fillStyle = C.surface; ctx.fillRect(x, 290, width, 225);
    ctx.fillStyle = tone; ctx.fillRect(x, 290, width, 3);
    wrappedText(ctx, item.label, x + 22, 335, { width: width - 44, size: 23, min: 21, lines: 1, color: C.secondary });
    fit(ctx, item.value, '500', 49, 30, width - 44);
    ctx.fillStyle = tone; ctx.fillText(item.value, x + 22, 408);
    if (item.detail) wrappedText(ctx, item.detail, x + 22, 457, {
      width: width - 44, size: 21, min: 19, lines: 2, color: C.secondary,
    });
  });
}

// Public side on top, shielded pool below. The arrow stays neutral; colour
// lives on the headline amount, which already states the size.
function drawTransfer(ctx, v) {
  const x = 800, box = 44, topY = 160, bottomY = 400;
  const node = (n, y) => {
    if (n.style === 'outline') { ctx.strokeStyle = C.muted; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, box - 2, box - 2); }
    else { ctx.fillStyle = NODE_FILL[n.style] || C.gold; ctx.fillRect(x, y, box, box); }
    ctx.font = '500 26px Geist'; ctx.fillStyle = C.text; ctx.fillText(n.name, x + box + 20, y + 22);
    ctx.font = 'normal 16px GeistMono'; ctx.fillStyle = C.muted; ctx.fillText(n.detail, x + box + 20, y + 46);
  };
  node(v.top, topY);
  node(v.bottom, bottomY);
  const cx = x + box / 2, from = topY + box + 18, to = bottomY - 18;
  ctx.fillStyle = C.text;
  for (let y = from + 26; y < to - 22; y += 18) ctx.fillRect(cx - 4, y, 8, 8);
  ctx.beginPath();
  if (v.direction === 'down') { ctx.moveTo(cx - 12, to - 16); ctx.lineTo(cx + 12, to - 16); ctx.lineTo(cx, to); }
  else { ctx.moveTo(cx - 12, from + 16); ctx.lineTo(cx + 12, from + 16); ctx.lineTo(cx, from); }
  ctx.fill();
}

async function chainNode(ctx, code, cx, cy, ring) {
  const r = 34;
  ctx.beginPath(); ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.fillStyle = C.surface; ctx.fill();
  ctx.strokeStyle = ring; ctx.lineWidth = 1.5; ctx.stroke();
  const file = path.join(ASSETS, 'chains', `${CHAIN_ICONS[code] || code}.png`);
  if (fs.existsSync(file)) {
    const img = await loadImage(file);
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(img, cx - r, cy - r, 2 * r, 2 * r); ctx.restore();
  }
  const label = code.toUpperCase();
  ctx.font = 'normal 16px GeistMono'; ctx.fillStyle = C.muted;
  ctx.fillText(label, cx - ctx.measureText(label).width / 2, cy + 74);
}

async function drawSwap(ctx, v) {
  const y = 250, x1 = 820, x2 = W - PAD - 40;
  ctx.fillStyle = C.text;
  for (let x = x1 + 58; x < x2 - 70; x += 22) ctx.fillRect(x, y - 4, 8, 8);
  ctx.beginPath(); ctx.moveTo(x2 - 62, y - 12); ctx.lineTo(x2 - 62, y + 12); ctx.lineTo(x2 - 46, y); ctx.fill();
  await chainNode(ctx, v.from, x1, y, v.from === 'zec' ? C.gold : C.border);
  await chainNode(ctx, v.to, x2, y, v.to === 'zec' ? C.gold : C.border);
}

// Ten blocks; the ranked week is gold and the busier weeks are outlined.
function drawRank(ctx, v) {
  const size = 34, gap = 10, x0 = W - PAD - 10 * (size + gap) + gap, y0 = 250;
  ctx.font = 'normal 16px GeistMono'; ctx.fillStyle = C.muted;
  ctx.fillText(v.tied ? 'Joint rank among complete weeks' : 'Rank among complete weeks', x0, y0 - 22);
  for (let i = 1; i <= 10; i++) {
    const x = x0 + (i - 1) * (size + gap);
    if (i === v.rank) { ctx.fillStyle = C.gold; ctx.fillRect(x, y0, size, size); }
    else { ctx.strokeStyle = i < v.rank ? C.muted : C.grid; ctx.lineWidth = 1.5; ctx.strokeRect(x + 0.75, y0 + 0.75, size - 1.5, size - 1.5); }
    ctx.font = 'normal 15px GeistMono'; ctx.fillStyle = i === v.rank ? C.gold : C.faint;
    const label = `#${i}`;
    ctx.fillText(label, x + (size - ctx.measureText(label).width) / 2, y0 + size + 28);
  }
}

function drawBars(ctx, v) {
  const x = 760, w = W - PAD - x;
  if (v.items.some(i => !Number.isFinite(i.value) || i.value < 0)) throw new Error('Invalid comparison');
  const max = Math.max(...v.items.map(i => i.value), 1);
  v.items.forEach((item, i) => {
    const y = 230 + i * 120;
    ctx.font = 'normal 22px Geist'; ctx.fillStyle = C.secondary;
    ctx.fillText(item.label, x, y - 18);
    ctx.font = 'normal 18px GeistMono'; ctx.fillStyle = C.text;
    ctx.fillText(item.display, x + w - ctx.measureText(item.display).width, y - 18);
    ctx.fillStyle = C.border; ctx.fillRect(x, y, w, 14);
    ctx.fillStyle = TONES[item.tone] || C.gold; ctx.fillRect(x, y, w * item.value / max, 14);
  });
}

// A short chain with `depth` replaced blocks forking off it.
function drawReorg(ctx, v) {
  const size = 30, gap = 14, step = size + gap, mid = 285, x0 = 740;
  const fork = x0 + 2 * step + size, fx = x0 + 3 * step + 20;
  ctx.fillStyle = C.muted;
  for (let i = 0; i < 3; i++) ctx.fillRect(x0 + i * step, mid - size / 2, size, size);
  ctx.strokeStyle = C.faint; ctx.lineWidth = 1.5;
  for (const dy of [-70, 70]) {
    ctx.beginPath(); ctx.moveTo(fork, mid); ctx.lineTo(fx, mid + dy); ctx.stroke();
  }
  for (let i = 0; i < v.depth; i++) {
    const x = fx + i * step;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x + 0.75, mid - 70 - size / 2 + 0.75, size - 1.5, size - 1.5);
    ctx.setLineDash([]);
    ctx.fillStyle = C.gold; ctx.fillRect(x, mid + 70 - size / 2, size, size);
  }
  ctx.font = 'normal 15px GeistMono'; ctx.fillStyle = C.muted;
  ctx.fillText('replaced', fx, mid - 70 - size / 2 - 14);
  ctx.fillText('canonical', fx, mid + 70 + size / 2 + 26);
}

// Blocks on a time axis: each tick is a block at its header time, so the gaps
// are block intervals. NU7 blocks are gold; activation is a dashed marker.
function drawPulse(ctx, v) {
  const x = 700, w = W - PAD - x, top = 200, h = 170;
  const span = v.end - v.start;
  if (!(span > 0) || !v.blocks.length) throw new Error('Invalid pulse');
  const px = t => x + Math.max(0, Math.min(1, (t - v.start) / span)) * w;
  ctx.fillStyle = C.surface; ctx.fillRect(x, top, w, h);
  ctx.strokeStyle = C.border; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, top + 0.5, w - 1, h - 1);
  for (const block of v.blocks) {
    ctx.fillStyle = block.nu7 ? C.gold : C.faint;
    ctx.fillRect(Math.round(px(block.t)) - 2, top + 30, 4, h - 60);
  }
  const first = v.blocks.find(block => block.nu7);
  if (first) {
    const mx = Math.round(px(first.t)) - 7;
    ctx.strokeStyle = C.gold; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(mx, top - 16); ctx.lineTo(mx, top + h); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = 'normal 16px GeistMono'; ctx.fillStyle = C.gold; ctx.fillText('NU7', mx + 8, top - 4);
  }
  ctx.font = 'normal 15px GeistMono'; ctx.fillStyle = C.muted;
  ctx.fillText(`${Math.round(span / 60)} min earlier`, x, top + h + 28);
  const now = 'latest block';
  ctx.fillText(now, x + w - ctx.measureText(now).width, top + h + 28);
  ctx.font = 'normal 18px Geist'; ctx.fillStyle = C.secondary;
  ctx.fillText('Each line is a block at its header time.', x, top + h + 66);
}

async function renderEditorial(story) {
  const card = story.evidence?.card;
  if (!card?.hero || !card.line || !card.kicker) throw new Error('Story has no card');
  const link = String(story.content || '').split('\n').at(-1);
  if (!link.startsWith('https://zecblock.com/') || !/^zecblock\.com\//.test(card.source || '')) {
    throw new Error('Unexpected editorial link');
  }
  ensureFonts();
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d');
  const accent = TONES[card.tone] || C.gold;
  await drawFrame(ctx, card.kicker, accent);
  const v = card.visual;
  if (v?.kind === 'briefing') drawBriefing(ctx, card, accent);
  else if (v?.kind === 'series') drawChartHeading(ctx, card, accent);
  else if (v?.kind === 'comparison') { /* Comparison has its own paired heading. */ }
  else drawText(ctx, card, accent, v ? 590 : W - 2 * PAD);
  if (v?.kind === 'series') drawSeries(ctx, seriesModel(story), accent);
  else if (v?.kind === 'comparison') drawComparison(ctx, v, card);
  else if (v?.kind === 'transfer') drawTransfer(ctx, v);
  else if (v?.kind === 'swap') await drawSwap(ctx, v);
  else if (v?.kind === 'rank') drawRank(ctx, v);
  else if (v?.kind === 'bars') drawBars(ctx, v);
  else if (v?.kind === 'reorg') drawReorg(ctx, v);
  else if (v?.kind === 'pulse') drawPulse(ctx, v);
  else if (v && v.kind !== 'briefing') throw new Error(`Unknown card visual: ${v.kind}`);
  drawFooter(ctx, card.source, v?.kind === 'comparison' && card.date ? `Latest window: ${card.date} UTC` : card.date);
  const file = path.join(os.tmpdir(), `zecblock-card-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  fs.writeFileSync(file, canvas.toBuffer('image/png'));
  return file;
}

module.exports = { renderEditorial, seriesModel, chartValue, W, H, C, fmt };
