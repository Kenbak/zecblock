'use strict';

/**
 * CipherScan Data Bot — Adaptive Thresholds
 *
 * Determines whether a flow event is "exceptional" enough to trigger an alert.
 * Uses both absolute floors and rolling percentile comparisons.
 */

const DEFAULT_CONFIG = {
  // Large flow alert: must exceed BOTH absolute floor AND percentile
  largeFlow: {
    absoluteFloorZat: 10_000_00000000, // 10,000 ZEC minimum
    percentile: 0.995,                  // 99.5th percentile of 90-day flows
    windowDays: 90,
    maxAlertsPerDay: 2,
  },

  // Ironwood milestones: round numbers and percentage thresholds
  ironwoodMilestones: {
    volumeSteps: [100_000, 250_000, 500_000, 750_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 3_500_000, 4_000_000, 4_500_000, 5_000_000],
    usdSteps: [1_000_000_000, 2_000_000_000, 5_000_000_000, 10_000_000_000],
    countSteps: [1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000],
    supplyPctSteps: [25, 50, 60, 70, 75, 80, 85, 90, 95, 99],
    complianceSteps: [50, 75, 80, 85, 90, 95],
  },

  // Reorg alerts
  reorg: {
    minDepth: 2,
    lookbackMinutes: 30,
  },

  // Cross-chain whale alerts
  crossChain: {
    minUsd: 50000, // $50K minimum swap
    maxAlertsPerDay: 3,
  },

  // Privacy risk alerts (daily aggregate)
  privacyRisk: {
    minHighLinkages: 3, // post only if >= 3 high-confidence linkages in 24h
  },

  // Network pulse anomaly alerts (statistical z-score events)
  pulse: {
    minAbsZ: 3.0,      // only strong/extreme intensity (matches /pulse page tiers)
    maxPerDay: 2,      // cap posts per day to stay signal, not noise
    lookbackHours: 26, // detect-anomalies runs daily ~21:00 UTC; window covers a full cycle
  },

  // Chain stall
  stall: {
    maxBlockIntervalSeconds: 600, // 10 minutes: 8x the 75s target before NU7, 24x the 25s target after
    confirmFromNodes: true,
  },
};

/**
 * Check if a flow amount exceeds the adaptive threshold.
 * Returns { triggered: boolean, percentile: number, threshold: number }
 */
function isExceptionalFlow(amountZat, { absoluteFloorZat, rollingThresholdZat }) {
  const meetsFloor = amountZat >= absoluteFloorZat;
  const meetsPercentile = amountZat >= rollingThresholdZat;
  return {
    triggered: meetsFloor && meetsPercentile,
    amountZec: amountZat / 1e8,
    thresholdZec: rollingThresholdZat / 1e8,
    floorZec: absoluteFloorZat / 1e8,
  };
}

/**
 * Check if a milestone has been crossed.
 * Returns the milestone value if newly crossed, or null.
 */
function checkMilestone(currentValue, steps, previousValue) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (currentValue >= step && (previousValue == null || previousValue < step)) {
      return step;
    }
  }
  return null;
}

/**
 * Determine the historical percentile rank of a given flow amount.
 */
function computePercentileRank(amountZat, rollingThresholdZat, percentile) {
  if (amountZat >= rollingThresholdZat) {
    return Math.min(99.99, percentile * 100 + (amountZat / rollingThresholdZat - 1) * 2);
  }
  return (amountZat / rollingThresholdZat) * percentile * 100;
}

module.exports = {
  DEFAULT_CONFIG,
  isExceptionalFlow,
  checkMilestone,
  computePercentileRank,
};
