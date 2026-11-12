#!/usr/bin/env node
'use strict';
// Same public shield/deshield/migration flow model. Scheduled runs refresh
// seven completed UTC days from stored state; full rebuilds are explicit.
// Usage: --today-only OR --rebuild. No notifications are sent by this job.
function run(args = process.argv.slice(2)) {
  if (args.length !== 1 || !['--today-only', '--rebuild'].includes(args[0])) {
    throw new Error('Use --today-only (bounded seven-day refresh) or --rebuild (all historical model flows)');
  }
  return require('../jobs/refresh-pool-realized-cap').run(['--apply', args[0] === '--today-only' ? '--refresh' : '--rebuild']);
}
if (require.main === module) Promise.resolve().then(() => run()).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };
