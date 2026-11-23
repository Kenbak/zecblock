// Server-rendered "About this explorer" copy at the bottom of the homepage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const moduleExports = {};
vm.runInNewContext(ts.transpileModule(read('lib/home-about.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: moduleExports, require });
const { getHomeAbout, aboutPartsText, homeAboutMarkdown } = moduleExports;

const allText = about => [about.heading, aboutPartsText(about.intro), ...about.items.flatMap(item => [item.question, aboutPartsText(item.answer)])].join('\n');

test('mainnet and testnet each get their own copy; Crosslink gets none', () => {
  const mainnet = getHomeAbout('mainnet');
  const testnet = getHomeAbout('testnet');
  assert.equal(mainnet.heading, 'About this Zcash explorer');
  assert.equal(testnet.heading, 'About this Zcash testnet explorer');
  assert.equal(getHomeAbout('crosslink-testnet'), null);
  assert.match(allText(mainnet), /Zcash block explorer/);
  assert.match(allText(testnet), /TAZ/);
  assert.doesNotMatch(allText(testnet), /\bZEC on mainnet\b.*\bTAZ\b.*has value/i);
});

test('the copy does not mention Zcash Names', () => {
  for (const network of ['mainnet', 'testnet']) {
    assert.doesNotMatch(allText(getHomeAbout(network)), /\bnames?\b|ZNS/i, network);
  }
});

test('internal links point to real pages and external links to the other network', () => {
  for (const network of ['mainnet', 'testnet']) {
    for (const item of [{ answer: getHomeAbout(network).intro }, ...getHomeAbout(network).items]) {
      for (const part of item.answer) {
        if (typeof part === 'string') continue;
        if (part.href.startsWith('http')) {
          assert.equal(part.href, network === 'mainnet' ? 'https://testnet.zecblock.com/' : 'https://zecblock.com/');
        } else {
          assert.ok(fs.existsSync(path.join(root, 'app', part.href, 'page.tsx')), `${network}: ${part.href} has no page`);
        }
      }
    }
  }
});

test('the homepage renders the section after the live data, and its Markdown carries the same text', () => {
  const page = read('app/page.tsx');
  assert.match(page, /const homeAbout = getHomeAbout\(getNetwork\(\)\);/);
  assert.ok(page.indexOf('<RecentMempool') < page.indexOf('<HomeAbout about={homeAbout} />'), 'About comes after the mempool');
  const component = read('components/HomeAbout.tsx');
  assert.doesNotMatch(component, /'use client'/);
  assert.match(component, /<SectionHeader label=\{about\.heading\} icon=\{<InfoSectionIcon \/>\} size="lg" \/>/);
  const markdown = homeAboutMarkdown(getHomeAbout('mainnet'), 'https://zecblock.com');
  assert.match(markdown, /^## About this Zcash explorer\n/);
  assert.match(markdown, /\[privacy pages\]\(https:\/\/zecblock\.com\/privacy\)/);
  assert.match(read('lib/llms/docs.ts'), /entry\.path === '\/' \? pageMarkdown\(entry, `\$\{SITE_URL\}\/`, homeAboutMarkdown\(getHomeAbout\('mainnet'\)!, SITE_URL\)\)/);
});
