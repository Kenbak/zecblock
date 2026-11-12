'use strict';

const { execFileSync } = require('node:child_process');
const { validateCrawlSnapshot, verifiedNodes } = require('../lib/node-census');

function checkHealth(metrics, now = Date.now()) {
  validateCrawlSnapshot(metrics, now);
  // A process can keep publishing while its connection scheduler has stalled.
  const runtime = metrics.crawler_runtime?.secs;
  const lastVerified = Math.max(0, ...verifiedNodes(metrics, now).map(n => n.chain_verified_at_ms));
  if (runtime > 900 && now - lastVerified > 900_000) {
    throw new Error('No successful Zcash chain verification for fifteen minutes');
  }
}

const DEFAULT_TARGETS = [['127.0.0.1:54321', 'zcash-crawler.service'], ['127.0.0.1:54322', 'zcash-crawler-tor.service']];

/**
 * `CRAWLER_HEALTH_TARGETS` overrides the primary's two loopback collectors,
 * e.g. on a regional observer: `10.77.0.2:54321=zcash-crawler.service`.
 */
function healthTargets(spec = process.env.CRAWLER_HEALTH_TARGETS) {
  if (!spec || !spec.trim()) return DEFAULT_TARGETS;
  return spec.split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const match = entry.match(/^((?:\d{1,3}\.){3}\d{1,3}:\d{1,5})=(zcash-crawler[a-z0-9-]*\.service)$/);
    if (!match) throw new Error(`Invalid CRAWLER_HEALTH_TARGETS entry: ${entry.slice(0, 80)}`);
    return [match[1], match[2]];
  });
}

async function run() {
  for (const [endpoint, unit] of healthTargets()) {
    try {
      const response = await fetch(`http://${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getmetrics', params: [] }),
        signal: AbortSignal.timeout(8000),
      });
      checkHealth((await response.json()).result);
      console.log(`${unit}: fresh observations`);
    } catch (error) {
      console.error(`${unit}: unhealthy (${error.message}); restarting collector`);
      // Collector units enforce StartLimitIntervalSec/StartLimitBurst.
      try {
        execFileSync('/usr/bin/systemctl', ['restart', unit], { timeout: 35000, stdio: 'inherit' });
      } catch (restartError) {
        console.error(`${unit}: restart failed (${restartError.message})`);
        process.exitCode = 1;
      }
    }
  }
}
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checkHealth, healthTargets };
