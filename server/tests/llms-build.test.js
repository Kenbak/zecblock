// Markdown page versions for language models (llms.txt, https://llmstxt.org).
// Runs against the mainnet production build so CI checks what is deployed:
// every page has a Markdown version, llms.txt links only to real documents,
// and each document's title and description match the page's own metadata.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, '.next/server/app');
assert.ok(fs.existsSync(path.join(app, 'llms.txt.body')), 'Run a mainnet `npm run build` before the llms build verification');

const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const body = file => fs.readFileSync(path.join(app, file), 'utf8');
const meta = file => JSON.parse(fs.readFileSync(path.join(app, file), 'utf8'));

function loadTs(file, dependencies = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, require: name => dependencies[name] ?? require(name) });
  return exports;
}
const sitemaps = loadTs('lib/sitemaps.ts');
const paths = loadTs('lib/llms/paths.ts', { '@/lib/sitemaps': sitemaps });

const llmsTxt = body('llms.txt.body');
// "- [Title](https://zecblock.com/path.md): description"
const entries = [...llmsTxt.matchAll(/^- \[([^\]]+)\]\(https:\/\/zecblock\.com(\/[^)]+\.md)\)(?:: (.*))?$/gm)]
  .map(([, title, markdownPath, description = '']) => ({ title, markdownPath, description }));
const byMarkdownPath = new Map(entries.map(entry => [entry.markdownPath, entry]));
const docFile = markdownPath => `llms-md/${markdownPath.slice(1, -3)}.body`;

// One pass, so an encoded ampersand is never decoded twice.
const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>' };
const decode = value => value.replace(/&(?:amp|quot|#x27|#39|lt|gt);/g, entity => ENTITIES[entity]);
const stripSuffix = title => title.replace(/\s*\|\s*ZecBlock$/, '');

test('llms.txt follows the format: H1, summary blockquote, H2 file lists, Optional last', () => {
  assert.match(llmsTxt, /^# ZecBlock\n\n> \S/);
  const headings = [...llmsTxt.matchAll(/^(#{1,6}) (.+)$/gm)].map(match => match[1] + ' ' + match[2]);
  assert.equal(headings[0], '# ZecBlock');
  assert.ok(headings.slice(1).every(heading => heading.startsWith('## ')), 'only H2 sections after the H1');
  assert.equal(headings.at(-1), '## Optional');
  assert.ok(entries.length >= 100, `expected every page to be listed, found ${entries.length}`);
  assert.equal(byMarkdownPath.size, entries.length, 'no duplicate links');
  // Small enough to read in one go; the detail lives behind the links.
  assert.ok(Buffer.byteLength(llmsTxt) < 64 * 1024, 'llms.txt stays compact');
});

test('every llms.txt link is a built Markdown document served as text/markdown', () => {
  for (const { markdownPath } of entries) {
    const file = docFile(markdownPath);
    assert.ok(fs.existsSync(path.join(app, file)), `${markdownPath} has no built document`);
    const headers = meta(file.replace(/\.body$/, '.meta')).headers;
    assert.match(headers['content-type'], /^text\/markdown; charset=utf-8$/, markdownPath);
    assert.match(headers.link, /<https:\/\/zecblock\.com\/llms\.txt>; rel="describedby"/, markdownPath);
    const doc = body(file);
    assert.match(doc, /^# \S/, `${markdownPath} starts with an H1`);
    assert.doesNotMatch(doc, /undefined|\[object Object\]|NaN/, markdownPath);
  }
  assert.ok(fs.existsSync(path.join(app, 'llms-full.txt.body')));
  for (const { markdownPath } of entries) {
    assert.ok(body('llms-full.txt.body').includes(body(docFile(markdownPath)).trim().split('\n')[0]), `${markdownPath} is in llms-full.txt`);
  }
});

test('every sitemap page, chart, newsletter issue and data page type has a Markdown version', () => {
  const pages = [...sitemaps.CORE_PATHS, ...sitemaps.CONTENT_PATHS, ...sitemaps.TOOL_PATHS].map(page => page.split('?')[0]);
  const charts = [...read('lib/chart-catalog.ts').matchAll(/id: ?['`]([a-z0-9-]+)['`]/g)].map(match => `/charts/${match[1]}`);
  charts.push('/charts/protocol-commitments', '/charts/protocol-nullifiers');
  const issues = fs.readdirSync(path.join(root, 'content/newsletter')).filter(file => file.endsWith('.md')).map(file => `/newsletter/${file.slice(0, -3)}`);
  const templates = ['/tx/abc', '/block/1', '/address/t1abc', '/name/example'];
  for (const page of [...new Set([...pages, ...charts, ...issues, ...templates])]) {
    assert.equal(paths.hasMarkdownVersion(page), true, `${page} must advertise a Markdown version`);
    assert.ok(byMarkdownPath.has(paths.markdownPathFor(page)), `${page} has no Markdown document (${paths.markdownPathFor(page)})`);
  }
});

// A new page needs a Markdown version, or an explicit reason here.
const NO_MARKDOWN = {
  '/blocks/latest': 'rewrite target of /blocks',
  '/txs/latest': 'rewrite target of /txs',
  '/bootstrap': 'Crosslink feature network only',
  '/chain': 'Crosslink feature network only',
  '/fork-monitor': 'Crosslink feature network only',
  '/validators': 'Crosslink feature network only',
  '/finalizer/[pubkey]': 'Crosslink feature network only',
  '/learn/crosslink': 'noindex Crosslink guide',
  '/governance/[slug]': 'covered per round through the sitemap governance paths',
  '/charts/[slug]': 'covered per chart from the chart catalog',
  '/newsletter/[slug]': 'covered per issue from content/newsletter',
};

test('every page route has a Markdown version or a recorded reason not to', () => {
  const routes = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.name === 'page.tsx') routes.push(('/' + path.relative('app', dir)).replace(/\/$/, '') || '/');
    }
  };
  walk('app');
  for (const route of routes) {
    if (NO_MARKDOWN[route]) continue;
    const sample = route.replace(/\[[^\]]+\]/g, 'x');
    assert.ok(paths.hasMarkdownVersion(sample) && byMarkdownPath.has(paths.markdownPathFor(sample)),
      `${route} has no Markdown version: add it to lib/llms/docs.ts or record why in NO_MARKDOWN`);
  }
});

test('Markdown titles and descriptions match the pages’ own metadata', () => {
  const sources = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (/^(page|layout)\.tsx$/.test(entry.name)) sources.push(read(path.join(dir, entry.name)));
    }
  };
  walk('app');
  const source = sources.join('\n').replace(/\\'/g, "'");
  // Grant round pages build their metadata from live proposal counts.
  const dynamicMetadata = new Set(['/governance/retroactive-grants-q4-2026.md', '/governance/retroactive-grants-q3-2026.md']);
  for (const page of [...sitemaps.CORE_PATHS, ...sitemaps.CONTENT_PATHS, ...sitemaps.TOOL_PATHS]) {
    const clean = page.split('?')[0];
    if (clean.startsWith('/charts/')) continue; // From the chart catalog by construction.
    const entry = byMarkdownPath.get(paths.markdownPathFor(clean));
    if (dynamicMetadata.has(entry.markdownPath)) continue;
    const html = path.join(app, clean === '/' ? 'index.html' : `${clean.slice(1)}.html`);
    if (fs.existsSync(html)) {
      const page = fs.readFileSync(html, 'utf8');
      assert.equal(entry.title, stripSuffix(decode(page.match(/<title>([^<]*)<\/title>/)[1])), `${clean} title`);
      assert.equal(entry.description, decode(page.match(/<meta name="description" content="([^"]*)"/)[1]), `${clean} description`);
    } else {
      // Rendered per request: the description must appear in the page source.
      assert.ok(source.includes(entry.description), `${clean} description differs from its page metadata`);
    }
  }
});

test('pages link to their Markdown version and llms.txt', () => {
  const home = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
  assert.match(home, /<link rel="alternate" type="text\/markdown" href="https:\/\/zecblock\.com\/index\.md"\/>/);
  assert.match(home, /<link rel="describedby" href="\/llms\.txt"\/>/);
  const about = fs.readFileSync(path.join(app, 'about.html'), 'utf8');
  assert.match(about, /<link rel="alternate" type="text\/markdown" href="https:\/\/zecblock\.com\/about\.md"\/>/);
  const config = read('next.config.ts');
  assert.match(config, /source: '\/:path\(\.\+\)\\\\\.md',\s*destination: '\/llms-md\/:path'/);
});

test('Markdown documents carry no server-side API origin', () => {
  for (const file of ['llms.txt.body', 'llms-full.txt.body']) {
    const text = body(file);
    for (const url of text.matchAll(/https?:\/\/[^\s)`>]+/g)) {
      assert.doesNotMatch(url[0], /localhost|127\.0\.0\.1|\.internal|:\d{4,5}\//, `${file}: ${url[0]}`);
    }
  }
});
