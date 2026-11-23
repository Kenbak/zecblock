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
  assert.match(component, /<SectionHeader label=\{about\.heading\} icon=\{<InfoSectionIcon \/>\} size=\{size\}/);
  assert.match(component, /<AboutSection about=\{about\} size="lg"/);
  const markdown = homeAboutMarkdown(getHomeAbout('mainnet'), 'https://zecblock.com');
  assert.match(markdown, /^## About this Zcash explorer\n/);
  assert.match(markdown, /\[privacy pages\]\(https:\/\/zecblock\.com\/privacy\)/);
  assert.match(read('lib/llms/docs.ts'), /entry\.path === '\/' \? pageMarkdown\(entry, `\$\{SITE_URL\}\/`, homeAboutMarkdown\(getHomeAbout\('mainnet'\)!, SITE_URL\)\)/);
});

const pageModule = {};
vm.runInNewContext(ts.transpileModule(read('lib/page-about.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: pageModule, require });
const { PAGE_ABOUT } = pageModule;

function appSources(dir = 'app', out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) appSources(rel, out);
    else if (/\.tsx$/.test(entry.name)) out.push([rel, read(rel)]);
  }
  return out;
}

test('every page About entry is rendered exactly once, on a sitemap page', () => {
  const sitemaps = read('lib/sitemaps.ts');
  const sources = appSources();
  for (const page of Object.keys(PAGE_ABOUT)) {
    assert.ok(sitemaps.includes(`'${page}'`), `${page} is not a sitemap page`);
    const uses = sources.filter(([, text]) => text.includes(`<PageAbout path="${page}" />`));
    assert.equal(uses.length, 1, `${page} must render its About section exactly once (found ${uses.map(([file]) => file).join(', ') || 'none'})`);
  }
  // The privacy layout wraps /privacy/wallets, so /privacy renders its section in the page.
  assert.doesNotMatch(read('app/privacy/layout.tsx'), /PageAbout/);
});

test('page About copy names no Zcash Names, links to real pages and is mainnet only', () => {
  for (const [page, about] of Object.entries(PAGE_ABOUT)) {
    assert.doesNotMatch(allText(about), /\bnames?\b|ZNS/i, page);
    assert.match(about.heading, /^(About |Why )/, page);
    for (const part of [...about.intro, ...about.items.flatMap(item => item.answer)]) {
      if (typeof part === 'string') continue;
      const target = part.href.split('?')[0];
      assert.ok(fs.existsSync(path.join(root, 'app', target, 'page.tsx')), `${page}: ${part.href} has no page`);
    }
  }
  assert.match(read('components/HomeAbout.tsx'), /if \(!about \|\| getNetwork\(\) !== 'mainnet'\) return null;/);
});

test('each page keeps one About: the older explainer blocks were folded in', () => {
  for (const file of ['app/mempool/page.tsx', 'app/blocks/BlocksPage.tsx', 'app/txs/render.tsx']) {
    assert.doesNotMatch(read(file), /server-rendered for indexing|lowercase tracking-tight/, file);
  }
  assert.match(aboutPartsText(PAGE_ABOUT['/mempool'].intro), /^The mempool is the staging area of the Zcash network/);
  assert.match(aboutPartsText(PAGE_ABOUT['/blocks'].intro), /^Zcash block timing follows the active network upgrade/);
  assert.match(aboutPartsText(PAGE_ABOUT['/txs'].intro), /^Zcash supports two kinds of value transfer/);
  // Blend Check's collapsed explainer is now the server-rendered section.
  assert.doesNotMatch(read('app/tools/blend-check/page.tsx'), /Why does this matter\?/);
  assert.match(aboutPartsText(PAGE_ABOUT['/tools/blend-check'].intro), /7\.31924 ZEC/);
  // Nodes explains its own methodology; no second About.
  assert.equal(PAGE_ABOUT['/network/nodes'], undefined);
  // Pulse explains its metrics and thresholds itself.
  assert.equal(PAGE_ABOUT['/pulse'], undefined);
});

// The turnstile job runs every five minutes in production; every place that
// states the refresh frequency must say the same (it once said hourly and daily).
test('turnstile wording matches the production refresh schedule', () => {
  assert.match(read('server/deploy/crontab.production'), /^\*\/5 \* \* \* \* .*node refresh-turnstile\.js'/m);
  for (const file of ['app/turnstile/layout.tsx', 'components/pools/TurnstileTracker.tsx', 'lib/llms/docs.ts', 'lib/page-about.ts']) {
    const text = read(file);
    assert.match(text, /every 5 minutes/, file);
    assert.doesNotMatch(text.split('\n').filter(line => /turnstile|Turnstile|deshield/.test(line) || file.includes('Turnstile')).join('\n'), /Updated (hourly|daily)/, file);
  }
});
