'use strict';
// Build-time only: keep Ask's public chart descriptions aligned with the UI catalogue.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../../..');
function load(relative, imports = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (!Object.hasOwn(imports, name)) throw new Error(`Unexpected catalogue dependency: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}
const { CHART_CATALOG } = load('lib/chart-catalog.ts', { './network-overview': load('lib/network-overview.ts'), './mining-metrics': load('lib/mining-metrics.ts') });
const guides = CHART_CATALOG.map(({ id, title, description, unit, window, href }) => ({ id, title, description, unit, window, source: href }));
fs.writeFileSync(path.join(root, 'lib/ask/chart-pages.json'), JSON.stringify(guides, null, 2) + '\n');
console.log(`Wrote ${guides.length} Ask chart descriptions`);
