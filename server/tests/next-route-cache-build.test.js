const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../..');
const manifestPath = path.join(repositoryRoot, '.next/prerender-manifest.json');

assert.ok(
  fs.existsSync(manifestPath),
  'Run `npm run build` before the route-cache build verification',
);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

test('newsletter issues are prebuilt and unknown slugs cannot use a streaming fallback', () => {
  assert.equal(manifest.dynamicRoutes?.['/newsletter/[slug]']?.fallback, false);
  for (const file of fs.readdirSync(path.join(repositoryRoot, 'content/newsletter'))) {
    if (!file.endsWith('.md')) continue;
    const route = `/newsletter/${file.slice(0, -3)}`;
    assert.ok(manifest.routes?.[route], `${route} must remain available as a published issue`);
  }
});

test('latest list pages are emitted as 30-second ISR pages with on-demand revalidation', () => {
  const expected = [
    '/blocks/latest',
    '/txs/latest',
  ];

  for (const route of expected) {
    const entry = manifest.routes?.[route];
    assert.ok(entry, `${route} is not present in the Next prerender manifest`);
    assert.equal(entry.initialRevalidateSeconds, 30);
  }
});

test('query-aware archive handlers remain outside the full route cache', () => {
  for (const route of ['/blocks', '/txs']) {
    assert.equal(
      manifest.routes?.[route],
      undefined,
      `${route} must remain dynamic so query-specific HTML is not collapsed`,
    );
  }
});

test('homepage uses ISR with on-demand revalidation and rich-list retains ISR', () => {
  assert.equal(manifest.routes?.['/']?.initialRevalidateSeconds, 30);
  assert.equal(manifest.routes?.['/rich-list']?.initialRevalidateSeconds, 60);
});

test('detail routes retain on-demand static fallbacks for runtime ISR', () => {
  for (const route of ['/block/[height]', '/tx/[txid]', '/address/[address]']) {
    const entry = manifest.dynamicRoutes?.[route];
    assert.ok(entry, `${route} is not present in the Next dynamic prerender manifest`);
    assert.equal(entry.fallback, null, `${route} must generate uncached params on demand`);
  }
});

// A short server fetch silently lowers the whole route's cache lifetime.
test('network snapshot retains five-minute ISR independently of live browser polling', () => {
  assert.equal(manifest.routes?.['/network']?.initialRevalidateSeconds, 300);
});

test('governance announcements compute clock boundaries at request time before entering the CDN', () => {
  assert.equal(
    manifest.routes?.['/api/governance/announcement'],
    undefined,
    'announcement selection must not become a static ISR response that outlives a known vote boundary',
  );
});

test('governance hub retains its minute ISR interval when catalog reads are coalesced', () => {
  assert.equal(manifest.routes?.['/governance']?.initialRevalidateSeconds, 60);
});
