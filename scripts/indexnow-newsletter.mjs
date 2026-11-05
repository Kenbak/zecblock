#!/usr/bin/env node
// Submits published or updated newsletter issues to IndexNow after a
// successful mainnet production deployment. Usage:
//
//   node scripts/indexnow-newsletter.mjs --commit <sha>   # issues added/modified by that commit
//   node scripts/indexnow-newsletter.mjs <slug> [<slug>…] # explicit issues (manual re-run)
//
// Requires INDEXNOW_KEY and INDEXNOW_HOST (and NETWORK=mainnet) in the
// environment; the eligibility rules, URL shapes and request format are the
// same module the API uses (server/api/indexnow.js). Deleted issues are never
// submitted: their URLs are missing pages, not a state change worth a hint.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createIndexNowNotifier, resolveIndexNowConfig } = require('../server/api/indexnow.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEWSLETTER_FILE = /^content\/newsletter\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,119})\.md$/;

export function changedNewsletterSlugs(commit, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('--commit must be a full 40-character SHA');
  // First parent only: a merge into main is compared with the previous main.
  const output = git(['diff', '--name-only', '--diff-filter=AMR', `${commit}^1`, commit, '--', 'content/newsletter']);
  return output.split('\n').map((file) => file.match(NEWSLETTER_FILE)?.[1]).filter(Boolean);
}

async function main(argv) {
  const config = resolveIndexNowConfig(process.env);
  if (!config.enabled) {
    console.log(`IndexNow skipped: ${config.reason}`);
    return 0;
  }

  const commitIndex = argv.indexOf('--commit');
  const slugs = commitIndex >= 0 ? changedNewsletterSlugs(argv[commitIndex + 1] || '') : argv;
  const published = [...new Set(slugs)].filter((slug) => existsSync(path.join(root, 'content', 'newsletter', `${slug}.md`)));
  if (!published.length) {
    console.log('IndexNow: no published newsletter issues changed.');
    return 0;
  }

  let failed = false;
  const notifier = createIndexNowNotifier({
    ...config,
    onError: (context, err) => {
      failed = true;
      console.error(`IndexNow ${context} failed: ${err.message}`);
    },
    onSubmit: ({ status, count }) => console.log(`IndexNow accepted ${count} URL(s) with HTTP ${status}.`),
  });
  for (const slug of published) notifier.newsletterPublished(slug);
  console.log(`IndexNow: submitting ${published.map((slug) => `/newsletter/${slug}`).join(', ')}`);
  await notifier.flush();
  const { rejectedIneligible } = notifier.stats();
  if (rejectedIneligible) console.error(`IndexNow rejected ${rejectedIneligible} ineligible slug(s).`);
  return failed || rejectedIneligible ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
