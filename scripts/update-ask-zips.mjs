#!/usr/bin/env node
// Regenerates server/api/v1/lib/ask-zips.json from the official ZIP index
// (README.rst in github.com/zcash/zips). Only numbers, titles, statuses and the
// NU7 plan are copied; Ask writes no summaries of ZIP contents.
//
//   node scripts/update-ask-zips.mjs            # fetch from GitHub
//   node scripts/update-ask-zips.mjs README.rst # use a downloaded copy
//
// Review the diff before committing: statuses change as ZIPs progress.
import { readFile, writeFile } from 'node:fs/promises';

const SOURCE = 'https://raw.githubusercontent.com/zcash/zips/main/README.rst';
const OUTPUT = new URL('../server/api/v1/lib/ask-zips.json', import.meta.url);
// Decode entities in one pass (so "&amp;lt;" stays "&lt;"), then drop markup
// until none remains; titles are plain text and never keep angle brackets.
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const entities = text => {
  let plain = text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ENTITIES[entity]);
  for (let previous; previous !== plain;) { previous = plain; plain = plain.replace(/<[^<>]*>/g, ''); }
  return plain.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
};

export function parseIndex(readme) {
  const start = readme.indexOf('Index of ZIPs');
  if (start < 0) throw new Error('Index of ZIPs section not found');
  const rows = [...readme.slice(start).matchAll(/<tr>\s*<td>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td>(.*?)<\/td>/g)];
  // The index also lists unnumbered guides/templates (e.g. "guide-markdown"); only numbered ZIPs are kept.
  const zips = rows.flatMap(([, number, title, status]) => {
    const label = entities(number);
    if (!/^\d{1,4}$/.test(label)) return [];
    const n = Number(label);
    return [{ number: n, title: entities(title), status: entities(status), url: `https://zips.z.cash/zip-${String(n).padStart(4, '0')}` }];
  });
  if (zips.length < 50 || new Set(zips.map(z => z.number)).size !== zips.length) throw new Error('Unexpected ZIP index shape');
  // Only the "NU7 ZIPs" section: planned ZIPs, planned revisions and the deployment ZIP.
  const nu7Start = readme.indexOf('NU7 ZIPs'), nu7End = readme.indexOf('License', nu7Start);
  if (nu7Start < 0 || nu7End < 0 || nu7End > start) throw new Error('NU7 ZIPs section not found');
  const nu7 = [...new Set([...readme.slice(nu7Start, nu7End).matchAll(/`ZIP (\d+):[^`]*<zips\/zip-\d+\.(?:rst|md)>`__/g)].map(([, n]) => Number(n)))];
  // "The most recent settled Network Upgrade on Mainnet is NU6.3, which activated at Mainnet block height 3428143."
  const settled = /settled <[^>]+>`__ Network Upgrade on Mainnet is ([^,\s]+),\s*which activated at Mainnet block height (\d+)/.exec(readme);
  return { source: SOURCE, zips: zips.sort((a, b) => a.number - b.number), nu7Planned: nu7.sort((a, b) => a - b),
    settledUpgrade: settled ? { name: settled[1], activationHeight: Number(settled[2]) } : null };
}

async function main() {
  const file = process.argv[2];
  const readme = file ? await readFile(file, 'utf8') : await (await fetch(SOURCE, { signal: AbortSignal.timeout(20000) })).text();
  const index = parseIndex(readme);
  const data = { ...index, retrieved: new Date().toISOString().slice(0, 10) };
  await writeFile(OUTPUT, JSON.stringify(data, null, 1) + '\n');
  console.log(`Wrote ${data.zips.length} ZIPs (${data.nu7Planned.length} in the NU7 plan) to ${OUTPUT.pathname}`);
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
