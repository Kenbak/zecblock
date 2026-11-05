// Public-network subsidy clock, matching zakura-chain 8.0.0's segmented
// target-spacing sum. Activation heights come from the serving node, not dates.
const MAX_HEIGHT = 499_999_999;
const HALVING_SECONDS = 840_000 * 150;
const SLOW_START_SECONDS = 10_000 * 150;
const KNOWN_UPGRADES = new Set(['Overwinter', 'Sapling', 'Blossom', 'Heartwood', 'Canopy', 'NU5', 'NU6', 'NU6.1', 'NU6.2', 'NU6.3', 'NU7']);

function networkSchedule(info) {
  if (!['main', 'test'].includes(info?.chain) || !info.upgrades) return null;
  const upgrades = Object.values(info.upgrades);
  if (upgrades.some(u => !KNOWN_UPGRADES.has(u.name) || !Number.isSafeInteger(u.activationheight) || u.activationheight < 0)) return null;
  const blossom = upgrades.find(u => u.name === 'Blossom');
  if (blossom?.activationheight !== (info.chain === 'main' ? 653_600 : 584_000)) return null;
  const nu7 = upgrades.find(u => u.name === 'NU7');
  if (nu7 && (nu7.activationheight <= blossom.activationheight || nu7.activationheight > MAX_HEIGHT)) return null;
  return { network: info.chain, source: 'node-upgrade-schedule', nu7Height: nu7?.activationheight ?? null,
    eras: [{ height: 0, seconds: 150 }, { height: blossom.activationheight, seconds: 75 },
      ...(nu7 ? [{ height: nu7.activationheight, seconds: 25 }] : [])] };
}

function targetSeconds(schedule, start, end) {
  if (!schedule || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > MAX_HEIGHT) return null;
  return schedule.eras.reduce((sum, era, i) => sum + Math.max(0,
    Math.min(end, schedule.eras[i + 1]?.height ?? end) - Math.max(start, era.height)) * era.seconds, 0);
}

function targetSpacing(schedule, height) {
  if (!schedule || !Number.isSafeInteger(height) || height < 0 || height > MAX_HEIGHT) return null;
  return schedule.eras.filter(era => era.height <= height).at(-1).seconds;
}

// Height whose target-time distance to `end` is about `seconds`, walking back
// across spacing eras. Estimates only; prefer header timestamps when indexed.
function heightBefore(schedule, end, seconds) {
  if (!schedule || !Number.isSafeInteger(end) || end < 0 || end > MAX_HEIGHT || !(seconds >= 0)) return null;
  let height = end;
  let remaining = seconds;
  for (let i = schedule.eras.length - 1; i >= 0 && remaining > 0; i--) {
    const era = schedule.eras[i];
    if (era.height >= height) continue;
    const available = height - era.height;
    const needed = remaining / era.seconds;
    if (needed <= available) { height -= Math.round(needed); remaining = 0; }
    else { height = era.height; remaining -= available * era.seconds; }
  }
  return height;
}

function halvingIndex(schedule, height) {
  const seconds = targetSeconds(schedule, 0, height);
  return seconds === null ? null : Math.max(0, Math.floor((seconds - SLOW_START_SECONDS) / HALVING_SECONDS));
}

function halvingHeight(schedule, index) {
  if (!schedule || index < 1 || halvingIndex(schedule, MAX_HEIGHT) < index) return null;
  let lo = 0; let hi = MAX_HEIGHT;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (halvingIndex(schedule, mid) < index) lo = mid + 1; else hi = mid;
  }
  return lo;
}

module.exports = { networkSchedule, targetSeconds, targetSpacing, heightBefore, halvingIndex, halvingHeight };
