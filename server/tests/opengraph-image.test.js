const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');

function loadImage(network, readFile) {
  const source = fs.readFileSync(path.join(root, 'app/opengraph-image.tsx'), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const hosts = {
    mainnet: 'https://zecblock.com',
    testnet: 'https://testnet.zecblock.com',
    'crosslink-testnet': 'https://crosslink.zecblock.com',
  };
  const imports = {
    'node:fs/promises': { readFile },
    '@/lib/seo': { getNetwork: () => network, getBaseUrl: () => hosts[network] },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    name => name in imports ? imports[name] : require(name), module, module.exports,
  );
  return module.exports;
}

test('metadata import works without image assets or filesystem reads', () => {
  let reads = 0;
  const image = loadImage('mainnet', () => {
    reads++;
    throw new Error('Image assets are absent from this page bundle');
  });
  assert.equal(reads, 0);
  assert.equal(image.contentType, 'image/png');
  assert.deepEqual(image.size, { width: 1200, height: 630 });
  assert.match(image.alt, /ZecBlock/);
});

test('asset failures reject the image request and a later request can retry', async () => {
  let available = false;
  const missing = Object.assign(new Error('Missing image asset'), { code: 'ENOENT' });
  const image = loadImage('mainnet', file => available
    ? require('node:fs/promises').readFile(file)
    : Promise.reject(missing));
  await assert.rejects(image.default(), { code: 'ENOENT' });
  available = true;
  const response = await image.default();
  assert.equal(response.status, 200);
  assert.ok((await response.arrayBuffer()).byteLength > 1000);
});

for (const network of ['mainnet', 'testnet', 'crosslink-testnet']) {
  test(`${network} share card renders a real 1200x630 PNG`, async () => {
    const image = loadImage(network, require('node:fs/promises').readFile);
    const response = await image.default();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/png/);
    const png = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), 1200);
    assert.equal(png.readUInt32BE(20), 630);
  });
}
