#!/usr/bin/env node
// Regenerates lib/ask/address-labels.json from the explorer's reviewed public
// labels (GET /v1/labels). Only verified labels with valid transparent
// addresses are kept; descriptions/logos are not copied. Review the diff
// before committing: SQL research inlines this snapshot as the `labels` table.
//
//   node scripts/update-ask-labels.mjs              # fetch from the public API
//   node scripts/update-ask-labels.mjs labels.json  # use a downloaded response
import { readFile, writeFile } from 'node:fs/promises';

const SOURCE = 'https://api.zecblock.com/v1/labels';
const OUTPUT = new URL('../lib/ask/address-labels.json', import.meta.url);

export function parseLabels(body) {
  const items = Array.isArray(body?.data) ? body.data : body?.data?.labels;
  if (!Array.isArray(items)) throw new Error('Unexpected labels response');
  const labels = items.filter(item => item.verified === true)
    .map(item => ({ address: String(item.address), label: String(item.label).trim(), category: String(item.category || 'other').trim() }))
    .filter(item => /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(item.address) && item.label && item.label.length <= 80 && /^[a-z_]{1,24}$/.test(item.category));
  if (!labels.length || new Set(labels.map(item => item.address)).size !== labels.length) throw new Error('Unexpected labels shape');
  return labels.sort((a, b) => a.address.localeCompare(b.address));
}

async function main() {
  const file = process.argv[2];
  const body = file ? JSON.parse(await readFile(file, 'utf8')) : await (await fetch(SOURCE, { signal: AbortSignal.timeout(20000) })).json();
  const data = { source: SOURCE, retrieved: new Date().toISOString().slice(0, 10), labels: parseLabels(body) };
  await writeFile(OUTPUT, JSON.stringify(data, null, 1) + '\n');
  console.log(`Wrote ${data.labels.length} labels to ${OUTPUT.pathname}`);
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
