#!/usr/bin/env node
'use strict';

// Local, read-only render of animated cards from the public API. It posts
// nothing and touches no database or X client.
//   node server/bot/animate.js --card=pools --output=/path/pools.mp4 [--network=testnet] [--still=/path/last.png]
//   node server/bot/animate.js --card=all --dir=/path/to/folder
const fs = require('fs');
const path = require('path');
const { ANIMATIONS, renderVideo, renderStill } = require('./lib/animated-card');

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const network = arg('network') === 'testnet' ? 'testnet' : 'mainnet';
const api = network === 'testnet' ? 'https://api.testnet.zecblock.com' : 'https://api.zecblock.com';

async function render(id, output, still) {
  const animation = ANIMATIONS[id];
  if (!animation) throw new Error(`Unknown card "${id}". Use one of: ${Object.keys(ANIMATIONS).join(', ')}, all`);
  if (!animation.networks.includes(network)) throw new Error(`${id} is not available on ${network}`);
  const response = await fetch(`${api}${animation.path}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${animation.path} returned ${response.status}`);
  const model = animation.build(await response.json(), { network });
  if (!model) throw new Error(`${id}: source history is incomplete; nothing rendered`);
  const result = await renderVideo(model, output);
  if (still) fs.writeFileSync(still, await renderStill(model, model.frames.length - 1));
  return { id, ...result, points: model.dates.length, from: model.dates[0], to: model.dates.at(-1) };
}

(async () => {
  const card = arg('card') || 'pools';
  if (card === 'all') {
    const dir = arg('dir');
    if (!dir) throw new Error('Pass --dir=<folder> with --card=all');
    fs.mkdirSync(dir, { recursive: true });
    for (const id of Object.keys(ANIMATIONS).filter(key => ANIMATIONS[key].networks.includes(network))) {
      // One failed source must not hide the others.
      try { console.log(JSON.stringify(await render(id, path.join(dir, `${id}.mp4`), path.join(dir, `${id}.png`)))); } catch (error) { console.error(error.message); process.exitCode = 1; }
    }
    return;
  }
  const output = arg('output');
  if (!output) throw new Error('Pass --output=<file.mp4>');
  console.log(JSON.stringify(await render(card, output, arg('still'))));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
