'use strict';
const { targetSeconds, targetSpacing, halvingIndex, halvingHeight } = require('./network-schedule');
const MAX_ZAT = 2100000000000000n;

// Scheduled new issuance only. NSM reissuance and future supply removals are
// state-dependent and cannot be predicted from the subsidy clock.
function issuanceBetween(schedule, start, end) {
  if (!schedule || !Number.isSafeInteger(start) || start < 20000 || !Number.isSafeInteger(end) || end < start) return null;
  let sum = 0n;
  for (let height = start + 1; height <= end;) {
    const index = halvingIndex(schedule, height);
    const spacing = targetSpacing(schedule, height);
    if (index === null || spacing === null) return null;
    const boundary = Math.min(end + 1, halvingHeight(schedule, index + 1) ?? end + 1,
      schedule.eras.find(era => era.height > height)?.height ?? end + 1);
    const subsidy = 1250000000n * BigInt(spacing) / 150n / (2n ** BigInt(index));
    sum += BigInt(boundary - height) * subsidy;
    height = boundary;
  }
  return sum;
}

// Long-range dates use the consensus target-spacing clock from one anchor
// (a node height and the time it was read). Observed block cadence is not
// extrapolated: a short sample moves multi-year dates by weeks.
function targetDate(schedule, anchor, height) {
  if (!Number.isSafeInteger(anchor?.height) || !Number.isFinite(anchor?.time) || !Number.isSafeInteger(height)) return null;
  const seconds = height >= anchor.height ? targetSeconds(schedule, anchor.height, height) : targetSeconds(schedule, height, anchor.height);
  if (seconds === null) return null;
  return new Date(anchor.time + (height >= anchor.height ? seconds : -seconds) * 1000).toISOString();
}

function supplyProjection({ schedule, latest, currentHeight, anchorTime }) {
  const start = latest?.height;
  const time = Date.parse(latest?.date);
  const supply = latest?.circulatingZat;
  if (!schedule || !Number.isSafeInteger(start) || start < 20000 || !Number.isSafeInteger(currentHeight) || start > currentHeight ||
      !Number.isFinite(time) || !Number.isFinite(anchorTime) || !Number.isSafeInteger(supply) || supply <= 0 || BigInt(supply) > MAX_ZAT) return null;
  const index = halvingIndex(schedule, start);
  if (index === null) return null;
  const milestones = Array.from({ length: 4 }, (_, i) => ({ height: halvingHeight(schedule, index + i + 1), halving: index + i + 1 }))
    .filter(m => m.height !== null);
  const end = milestones.at(-1)?.height;
  if (!end) return null;
  const heights = new Set([start, ...milestones.map(m => m.height),
    ...schedule.eras.filter(e => e.height > start && e.height <= end).map(e => e.height)]);
  for (let i = 1; i < 160; i++) heights.add(Math.floor(start + (end - start) * i / 160));
  const anchor = { height: currentHeight, time: anchorTime };
  const points = [...heights].sort((a, b) => a - b).map(height => {
    const issued = issuanceBetween(schedule, start, height);
    const total = issued === null ? null : BigInt(supply) + issued;
    // Already-mined heights stay between the supply observation and the anchor.
    const date = height === start ? new Date(time).toISOString()
      : new Date(Math.max(time, Date.parse(targetDate(schedule, anchor, height)))).toISOString();
    return { height, date,
      circulating: total !== null && total <= MAX_ZAT ? Number(total) / 1e8 : null,
      circulatingZat: total !== null && total <= MAX_ZAT ? total.toString() : null,
      halving: milestones.find(m => m.height === height)?.halving ?? null };
  });
  return { method: 'observed-supply-plus-scheduled-subsidy', dateBasis: 'consensus-target-spacing',
    anchorHeight: currentHeight, excludes: ['future-supply-removals', 'nsm-reissuance'], points };
}
module.exports = { issuanceBetween, supplyProjection, targetDate };
