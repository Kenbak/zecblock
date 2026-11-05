// Run against a production build: HOME_VERIFY_URL=http://127.0.0.1:3100 node scripts/verify-homepage-first-render.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const transactionFixture = JSON.parse(readFileSync(new URL('../server/tests/fixtures/transaction-list-mainnet.json', import.meta.url), 'utf8'));
const blockFixture = JSON.parse(readFileSync(new URL('../server/tests/fixtures/blocks-mainnet.json', import.meta.url), 'utf8'));

const url = process.env.HOME_VERIFY_URL || 'http://127.0.0.1:3100';
const browser = await chromium.launch({
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});
const errors = [];
const watch = page => {
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /hydration|hydrating|Minified React error/i.test(message.text())) errors.push(message.text());
  });
};

try {
  // Freeze one cached response so delayed hydration really uses the same HTML.
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1);
  assert.match(html, /ZecBlock/);
  assert.match(html, /zecblock\.com/i);
  assert.match(html, /<time[^>]*>[^<]*(?:ago|Just now)<\/time>/);
  const noJS = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await noJS.newPage();
  await staticPage.route(url + '/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await staticPage.goto(url);
  const structured = await staticPage.locator('script[type="application/ld+json"]').allTextContents();
  // Check the actual page: server feeds must not need an inline reveal or
  // successful React hydration to expose their existing data and links.
  assert.equal(await staticPage.locator('.home-feed-content').first().isVisible(), true);
  assert.equal(await staticPage.locator('.home-feed-placeholder').first().isVisible(), false);
  assert.ok(await staticPage.locator('.home-feed a[href^="/block/"]').count() > 0);
  for (const selector of ['title', 'meta[name="description"]', 'link[rel="canonical"]', 'meta[name="robots"]',
    'meta[property="og:title"]', 'meta[property="og:description"]', 'meta[property="og:url"]',
    'meta[property="og:image"]', 'meta[name="twitter:card"]', 'meta[name="twitter:title"]', 'meta[name="twitter:image"]']) {
    assert.ok(await staticPage.locator(selector).count() > 0, `Missing ${selector}`);
  }
  assert.ok(structured.length > 0);
  structured.forEach(value => JSON.parse(value));
  await noJS.close();
  console.log('PASS: actual page has visible server feeds without JavaScript, relative ages, metadata, JSON-LD and one H1');

  // Keep JavaScript enabled while failing/hanging its bundles: <noscript>
  // does not cover this failure mode. A saved alternative may show a
  // placeholder only until a real load failure or the bounded deadline.
  for (const failure of ['aborted-bundles', 'stalled-bundles', 'blocked-inline']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(() => localStorage.setItem('cipherscan-home-card-right', 'transactions'));
    const page = await context.newPage();
    await page.clock.install();
    await page.route(url + '/', route => route.fulfill({ contentType: 'text/html', body: html,
      ...(failure === 'blocked-inline' ? { headers: { 'Content-Security-Policy': "script-src 'none'" } } : {}),
    }));
    let releaseScripts;
    const scriptsReady = new Promise(resolve => { releaseScripts = resolve; });
    await page.route('**/_next/**/*.js', async route => {
      await scriptsReady;
      await route.abort();
    });
    const navigation = page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('.home-feed').first().waitFor();
    assert.equal(await page.locator('.home-feed-content').first().isVisible(), true, 'Default slot stays visible');
    if (failure !== 'blocked-inline') {
      await page.locator('.home-feed-placeholder').last().waitFor({ state: 'visible' });
      if (failure === 'stalled-bundles') await page.clock.fastForward(5001);
      else releaseScripts();
    }
    await page.locator('.home-feed-content').last().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.home-feed-placeholder').last().isVisible(), false);
    assert.ok(await page.locator('.home-feed a[href^="/block/"]').count() > 0);
    releaseScripts();
    await navigation;
    await context.close();
    console.log(`PASS: useful server feeds remain visible after ${failure}, with JavaScript enabled`);
  }

  const cases = ['transactions', 'shielded', 'invalid-preference', null, 'blocked-storage'];
  const selectedCase = process.env.HOME_VERIFY_CASE;
  if (selectedCase) assert.ok(cases.includes(selectedCase), 'Unknown HOME_VERIFY_CASE');
  for (const preference of selectedCase ? [selectedCase] : cases) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    await context.addInitScript(value => {
      if (value === 'blocked-storage') {
        const getItem = Storage.prototype.getItem;
        Storage.prototype.getItem = function (key) {
          // Exercise the feed's storage failure handling without changing
          // unrelated theme, banner and navigation storage behavior.
          if (key.startsWith('cipherscan-home-card-')) throw new Error('Preference storage disabled for test');
          return getItem.call(this, key);
        };
      } else if (value) {
        localStorage.setItem('cipherscan-home-card-right', value);
      }
    }, preference);
    const page = await context.newPage();
    watch(page);
    await page.clock.install();
    const fixtureTime = Math.floor(Date.now() / 1000) - 120;
    await page.route('**/v1/blocks?limit=5', route => route.fulfill({ json: {
      meta: { requestId: 'browser-blocks', network: 'mainnet' },
      data: blockFixture.blocks.map(block => ({ ...block, timestamp: String(fixtureTime) })),
    } }));
    await page.route(url + '/', route => route.fulfill({ contentType: 'text/html', body: html }));
    let releaseScripts;
    const scriptsReady = new Promise(resolve => { releaseScripts = resolve; });
    await page.route('**/_next/**/*.js', async route => {
      await scriptsReady;
      await route.continue();
    });
    let releaseTransactions;
    const transactionsReady = new Promise(resolve => { releaseTransactions = resolve; });
    await page.route('**/v1/transactions?*', async route => {
      await transactionsReady;
      await route.fulfill({ json: { meta: { requestId: 'browser-transactions', network: 'mainnet' }, data: transactionFixture.transactions.map(tx => ({
        ...tx, block_time: String(fixtureTime),
      })) } });
    });
    const navigation = page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.locator('.home-feed').first().waitFor();
    const before = await page.locator('.home-feed').last().boundingBox();
    const customPreference = preference === 'transactions';
    assert.equal(await page.locator('.home-feed-content').first().isVisible(), true);
    assert.equal(await page.locator('.home-feed-placeholder').last().isVisible(), customPreference);
    assert.equal(await page.locator('.home-feed-content').last().isVisible(), !customPreference);
    assert.equal(await page.getByRole('heading', { name: 'SHIELDED_ACTIVITY', exact: true }).isVisible(), !customPreference);
    releaseScripts();
    await navigation;
    await page.locator('.home-feed[data-preferences-ready="true"]').last().waitFor();
    const label = preference === 'transactions' ? 'RECENT_TRANSACTIONS' : 'SHIELDED_ACTIVITY';
    assert.equal(await page.getByRole('heading', { name: label, exact: true }).isVisible(), true);
    const loading = await page.locator('.home-feed').last().boundingBox();
    const geometry = await page.locator('.home-feed').last().evaluate(el =>
      [...el.querySelectorAll('.home-feed-content > div, .home-feed-content .card > div')].map(node => ({
        classes: node.className, height: node.getBoundingClientRect().height,
        lineHeight: getComputedStyle(node).lineHeight,
        children: [...node.children].map(child => ({ tag: child.tagName, height: child.getBoundingClientRect().height, lineHeight: getComputedStyle(child).lineHeight })),
      })),
    );
    assert.ok(Math.abs(before.height - loading.height) <= 2, `Loading height changed: ${before.height} → ${loading.height}: ${JSON.stringify(geometry)}`);
    releaseTransactions();
    if (preference === 'transactions') await page.locator('.home-feed').last().locator('tbody tr').first().waitFor();
    const after = await page.locator('.home-feed').last().boundingBox();
    assert.ok(Math.abs(before.height - after.height) <= 2, `Loaded height changed: ${before.height} → ${after.height}`);
    assert.equal(await page.locator('.home-feed-placeholder').last().isVisible(), false);
    await page.locator('.home-feed').first().locator(`a[href="/block/${blockFixture.blocks[0].height}"]`).waitFor();
    const ages = await page.locator('.home-feed time').allTextContents();
    assert.ok(ages.length > 0);
    assert.ok(ages.every(age => !age.includes('UTC')));
    // The shared clock must continue updating even without a table fetch.
    await page.clock.fastForward(125_000);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(previous => {
      const age = document.querySelector('.home-feed time')?.textContent;
      return age && age !== previous;
    }, ages[0]);
    if (preference === 'transactions') {
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.locator('.home-feed').last().getByRole('button', { name: 'Customize this card' }).click();
      await page.getByRole('button', { name: 'Recent Blocks', exact: true }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem('cipherscan-home-card-right')), 'blocks');
    }
    await context.close();
    console.log(`PASS: delayed hydration, stable dimensions, live ages and saved preference ${preference}`);
  }
  assert.deepEqual(errors, [], 'Browser errors');
} finally {
  await browser.close();
}
