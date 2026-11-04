const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file) {
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const localRequire = name => {
    if (name === 'next/link') return { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) };
    if (name === '@/components/ui') return load('components/ui/SectionHeader.tsx');
    if (name === '@/components/ui/Card') return { Card: ({ children }) => React.createElement('div', null, children), CardBody: ({ children }) => React.createElement('div', null, children) };
    if (name === '@/contexts/ThemeContext') return { useTheme: () => ({ theme: 'dark' }) };
    if (name === '@/lib/chart-theme') return { getChartColors: () => ({}) };
    if (name === '@/lib/flow-colors') return { getFlowColors: () => ({}) };
    if (['@/lib/turnstile-period', '@/components/pools/TurnstileTracker', '@/components/ui/PeriodPillTags'].includes(name)) {
      const base = name.slice(2);
      return load(`${base}.${fs.existsSync(`${base}.ts`) ? 'ts' : 'tsx'}`);
    }
    // Data/chart dependencies are unused during the initial loading render.
    if (name.startsWith('@/') || name === 'recharts') return {};
    return require(name);
  };
  new Function('module', 'exports', 'require', output)(module, module.exports, localRequire);
  return module.exports;
}

const Page = load('app/turnstile/page.tsx').default;
const Tracker = load('components/pools/TurnstileTracker.tsx').TurnstileTracker;
function activePeriod(html) {
  return html.match(/<button\b[^>]*aria-pressed="true"[^>]*>([^<]+)<\/button>/)?.[1];
}

test('Turnstile deep links select each existing period in the initial rendered filter', async () => {
  for (const [period, label] of [['nu6.2', 'Since NU6.2'], ['30d', '30D'], ['90d', '90D'], ['1y', '1Y'], ['all', 'ALL']]) {
    const page = await Page({ searchParams: Promise.resolve({ period }) });
    assert.equal(activePeriod(renderToStaticMarkup(page)), label, period);
  }
});

test('missing, invalid and repeated period query values retain the 30-day default', async () => {
  for (const query of [{}, { period: '' }, { period: 'NU6.2' }, { period: '7d' }, { period: ['nu6.2'] }, { period: ['nu6.2', 'all'] }]) {
    const page = await Page({ searchParams: Promise.resolve(query) });
    assert.equal(activePeriod(renderToStaticMarkup(page)), '30D', JSON.stringify(query));
  }
});

test('embedded Turnstile trackers keep the default and reject an invalid initial value', () => {
  for (const props of [{}, { initialPeriod: 'unsupported' }]) {
    assert.equal(activePeriod(renderToStaticMarkup(React.createElement(Tracker, props))), '30D');
  }
});
