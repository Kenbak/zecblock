const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

function loadTS(file) {
  const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  new Function('module', 'exports', result.outputText)(module, module.exports);
  return module.exports;
}

const { HOME_ABOUT_HEADING, HOME_ABOUT_INTRO, HOME_FAQ, buildHomeFaqJsonLd } = loadTS('lib/home-about.ts');
const seoSource = fs.readFileSync('lib/seo.ts', 'utf8');
const pageSource = fs.readFileSync('app/page.tsx', 'utf8');
const configSource = fs.readFileSync('lib/config.ts', 'utf8');

test('mainnet homepage title and H1 lead with the exact phrase "Zcash Explorer"', () => {
  const mainnetTitle = seoSource.match(/network === 'mainnet'\) \{\s*return \{\s*title: '([^']+)'/);
  assert.ok(mainnetTitle, 'mainnet title not found in lib/seo.ts');
  assert.match(mainnetTitle[1], /^Zcash Explorer\b/);
  assert.match(mainnetTitle[1], /\| ZecBlock$/);
  assert.equal(mainnetTitle[1].match(/ZecBlock/g).length, 1);
  assert.match(pageSource, /: 'Zcash Explorer'\}/);
  // Testnet and Crosslink keep their own distinct search intent.
  assert.match(pageSource, /'The Zcash Testnet Explorer \(TAZ\)'/);
  assert.match(pageSource, /'The Zcash Crosslink Explorer'/);
});

test('the about section renders on mainnet only', () => {
  assert.match(pageSource, /\{!crosslinkMode && !isTestnet && <HomeAbout \/>\}/);
});

test('about copy names the explorer and uses the phrase the page targets', () => {
  assert.match(HOME_ABOUT_HEADING, /Zcash explorer/);
  assert.match(HOME_ABOUT_INTRO, /^ZecBlock is an open-source Zcash explorer\./);
});

test('FAQ items are complete, unique and link to real destinations', () => {
  assert.ok(HOME_FAQ.length >= 4);
  assert.equal(new Set(HOME_FAQ.map(item => item.question)).size, HOME_FAQ.length);
  const testnetUrl = configSource.match(/TESTNET_URL = '([^']+)'/)[1];
  for (const item of HOME_FAQ) {
    assert.match(item.question, /\?$/);
    assert.ok(item.answer.length >= 60, item.question);
    assert.doesNotMatch(item.answer, /[<>]/);
    assert.ok(item.link.label.length > 0);
    if (item.link.href.startsWith('/')) {
      const route = item.link.href.split('?')[0];
      assert.ok(fs.existsSync(`app${route}`), `missing route for ${item.link.href}`);
    } else {
      assert.equal(item.link.href, testnetUrl);
    }
  }
});

test('FAQPage JSON-LD is built from the visible questions and answers', () => {
  const schema = buildHomeFaqJsonLd('https://zecblock.com');
  assert.equal(schema['@type'], 'FAQPage');
  assert.equal(schema['@id'], 'https://zecblock.com/#faq');
  assert.equal(schema.url, 'https://zecblock.com/');
  assert.deepEqual(schema.isPartOf, { '@id': 'https://zecblock.com/#website' });
  assert.deepEqual(
    schema.mainEntity.map(entity => [entity['@type'], entity.name, entity.acceptedAnswer['@type'], entity.acceptedAnswer.text]),
    HOME_FAQ.map(item => ['Question', item.question, 'Answer', item.answer]),
  );
});

test('the hidden feed placeholder does not add a heading or placeholder text to the outline', () => {
  const feedCard = fs.readFileSync('components/HomeFeedCard.tsx', 'utf8');
  assert.doesNotMatch(feedCard, /LOADING_ACTIVITY/);
  assert.match(feedCard, /labelAsHeading=\{false\}/);
  const header = fs.readFileSync('components/ui/SectionHeader.tsx', 'utf8');
  assert.match(header, /const Label = labelAsHeading \? 'h2' : 'div';/);
});
