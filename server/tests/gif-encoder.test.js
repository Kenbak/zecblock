'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const sharp = require('sharp');

const source = fs.readFileSync(path.join(__dirname, '../../lib/gif-encoder.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', js)(loaded, loaded.exports, require);
const { buildPalette, encodeGif } = loaded.exports;

function frames(W, H, color) {
  return [0, 1, 2].map(f => {
    const d = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p++) d.set([...color(p % W, Math.floor(p / W), f), 255], p * 4);
    return d;
  });
}

for (const [name, W, H, color] of [
  ['flat chart colors', 6, 4, (x, y, f) => [[248, 188, 33], [17, 19, 22], [226, 166, 110]][(x + y + f) % 3]],
  ['many colors past the 4096-code table reset', 400, 260, (x, y, f) => [(x * 7 + f * 40) & 255, (y * 5) & 255, ((x ^ y) * 3) & 255]],
]) {
  test(`GIF encoder: ${name} decode exactly to the chosen palette, looping, with the frame delay`, async () => {
    const input = frames(W, H, color);
    const palette = buildPalette(input, ['#F8BC21']);
    const buf = Buffer.from(await encodeGif(input, W, H, palette, 60).arrayBuffer());
    const meta = await sharp(buf, { animated: true }).metadata();
    assert.deepEqual([meta.pages, meta.loop, meta.width, meta.pageHeight, meta.delay], [3, 0, W, H, [60, 60, 60]]);
    const raw = await sharp(buf, { animated: true }).raw().toBuffer();
    const ch = raw.length / (W * H * input.length);
    for (let f = 0; f < input.length; f++) for (let p = 0; p < W * H; p++) {
      const d = input[f];
      const idx = palette.lookup[((d[p * 4] >> 3) << 10) | ((d[p * 4 + 1] >> 3) << 5) | (d[p * 4 + 2] >> 3)];
      for (let k = 0; k < 3; k++) assert.equal(raw[(f * W * H + p) * ch + k], palette.colors[idx * 3 + k]);
    }
  });
}

test('GIF palette keeps required colors exactly representable', () => {
  const palette = buildPalette([new Uint8ClampedArray(4 * 10).fill(10)], ['#F8BC21', '#7F897A']);
  const has = hex => { const v = parseInt(hex.slice(1), 16); const want = [(v >> 16) >> 3, ((v >> 8) & 255) >> 3, (v & 255) >> 3];
    for (let i = 0; i < 256; i++) if (want.every((w, k) => palette.colors[i * 3 + k] >> 3 === w)) return true; return false; };
  assert.ok(has('#F8BC21') && has('#7F897A'));
});
