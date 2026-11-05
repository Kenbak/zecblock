#!/usr/bin/env node
// Read-only rendered launch audit. Run against the local rebrand preview.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const base = process.env.BASE_URL || 'http://localhost:3000';
const out = process.env.AUDIT_OUT || 'output/launch-audit';
const routes = process.env.AUDIT_ROUTES?.split(',') || [
  '/', '/about', '/press', '/privacy-policy', '/terms', '/docs', '/tools',
  '/tools/unit-converter', '/crosschain', '/usage-clock', '/pulse', '/zodl',
  '/turnstile', '/pools', '/network', '/network/attestations', '/mining',
  '/ironwood', '/txs', '/blocks', '/learn', '/charts', '/newsletter',
  '/newsletter/weekly-2026-09-27', '/governance', '/decrypt', '/zift',
];
const chrome = process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
console.log('Launching browser');
const browser = await chromium.launch({ ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
await mkdir(out, { recursive: true });
const results = [];
try {
  const context = await browser.newContext({ hasTouch: process.env.AUDIT_TOUCH === '1' });
  const page = await context.newPage();
  for (const route of routes) {
    console.log('Checking', route);
    const errors = [];
    const onError = error => errors.push(error.stack || error.message);
    page.on('pageerror', onError);
    await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const response = await context.request.get(base + route, { timeout: 60000 });
    await page.locator('main').first().waitFor();
    await page.evaluate(() => Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 5000))]));
    // Give client data a bounded opportunity; this is not an API health assertion.
    await page.waitForTimeout(1500);
    const html = await response.text();
    const seo = {
      h1: (html.match(/<h1\b/g) || []).length,
      title: /<title>[^<]+<\/title>/.test(html),
      canonical: /rel="canonical"/.test(html),
      noindex: /name="robots"[^>]*content="[^"]*noindex/.test(html),
      robots: /name="robots"/.test(html),
      og: /property="og:title"/.test(html),
      twitter: /name="twitter:card"/.test(html),
      jsonLd: [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].every(match => { try { JSON.parse(match[1]); return true; } catch { return false; } }),
    };
    for (const width of (process.env.AUDIT_WIDTHS || '1440,390').split(',').map(Number)) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['dark', 'light']) {
        // Exercise ThemeContext too: changing only the root class leaves canvas/SVG charts in the old theme.
        if (!(await page.locator('html').getAttribute('class'))?.split(' ').includes(theme)) {
          const toggle = page.getByRole('button', { name: `Switch to ${theme} mode`, includeHidden: true }).first();
          if (await toggle.count()) await toggle.evaluate(button => button.click());
          else {
            await page.evaluate(theme => { localStorage.setItem('theme', theme); localStorage.setItem('theme-user-set', '1'); }, theme);
            await page.reload({ waitUntil: 'domcontentloaded' });
          }
          await page.waitForFunction(theme => document.documentElement.classList.contains(theme), theme);
        }
        await page.waitForTimeout(300); // Let theme color transitions finish before inspection/capture.
        const dom = await page.evaluate(() => {
          const main = document.querySelector('main');
          const elements = [...main.querySelectorAll('*')].filter(e =>
            !e.closest('script,style,.sr-only,[aria-hidden="true"]') &&
            [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) &&
            e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
          return {
            mainLandmarks: document.querySelectorAll('main').length,
            small: elements.filter(e => parseFloat(getComputedStyle(e).fontSize) < 12).map(e => ({ tag: e.tagName, text: e.textContent.trim().slice(0, 90), size: getComputedStyle(e).fontSize })),
            legacyBrand: /CipherScan|@cipherscan_app/i.test(document.body.innerText + document.title),
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            staleX: [...document.querySelectorAll('a[href]')].some(a => /(?:x|twitter)\.com\/cipherscan_app/.test(a.href)),
          };
        });
        results.push({ route, width, theme, status: response.status(), seo, ...dom, errors: [...errors] });
        if (process.env.AUDIT_CAPTURE_ALL === '1' || ['/press','/docs','/privacy-policy','/terms','/pulse','/crosschain'].includes(route)) {
          await page.screenshot({ path: `${out}/${route.slice(1).replaceAll('/', '-')}-${width}-${theme}.png` });
        }
      }
    }
    page.off('pageerror', onError);
    console.log(route, response.status(), `h1=${seo.h1}`, 'checked');
    await writeFile(`${out}/report.json`, JSON.stringify(results, null, 2));
  }
} finally { await browser.close(); }
const failures = results.filter(r => r.status !== 200 || r.mainLandmarks !== 1 || r.small.length || r.legacyBrand || r.overflow || r.staleX || r.errors.length || !r.seo.title || (!r.seo.canonical && !r.seo.noindex) || !r.seo.robots || !r.seo.og || !r.seo.twitter || !r.seo.jsonLd || r.seo.h1 !== 1);
console.log(`${results.length} route/theme/viewport checks; ${failures.length} need attention. Report: ${out}/report.json`);
if (failures.length) process.exitCode = 1;
