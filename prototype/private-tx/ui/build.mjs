import { build } from 'esbuild';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// PRIVATE_UI_OUT builds a separate copy (for example the explorer test) without touching web/.
const APP = resolve(HERE, '..');
const ROOT = resolve(APP, '../..');
const OUT = process.env.PRIVATE_UI_OUT ? resolve(process.env.PRIVATE_UI_OUT) : resolve(APP, 'web');
const localAdapter = resolve(HERE, 'adapters/local-only.tsx');
const configAdapter = resolve(HERE, 'adapters/config.ts');
const safeAliases = new Map([
  ['next/link', localAdapter],
  ['@/components/AddressWithLabel', localAdapter],
  ['@/components/PrivacyRiskInline', localAdapter],
  ['@/components/TokenChainIcon', localAdapter],
  ['@/components/Tooltip', localAdapter],
  ['@/components/ui/FactBox', resolve(HERE, 'adapters/fact-box.tsx')],
  ['@/components/ExportButton', resolve(HERE, 'adapters/export-button.tsx')],
  ['@/lib/address-labels', localAdapter],
  ['@/lib/config', configAdapter],
  ['@/lib/network', configAdapter],
]);
const bundled = await build({
  absWorkingDir: ROOT,
  entryPoints: [resolve(HERE, 'main.tsx')],
  outfile: resolve(OUT, 'app.js'),
  bundle: true, minify: true, format: 'esm', platform: 'browser', target: ['es2022'],
  jsx: 'automatic', metafile: true,
  nodePaths: [resolve(APP, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'private-presentational-boundary',
    setup(plugin) {
      // Shared source files may sit beside another checkout's node_modules.
      // A single React instance must own both the app and reused components.
      plugin.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, args => plugin.resolve(resolve(APP, 'node_modules', args.path), { kind: args.kind, resolveDir: APP }));
      plugin.onResolve({ filter: /^(next\/link|@\/)/ }, args => {
        if (safeAliases.has(args.path)) return { path: safeAliases.get(args.path) };
        if (/^@\/lib\/api-|useTransactionPage/.test(args.path)) throw new Error(`Ordinary data fetching cannot enter the private UI: ${args.path}`);
        if (args.path.startsWith('@/')) return plugin.resolve(resolve(ROOT, args.path.slice(2)), { kind: args.kind, resolveDir: args.resolveDir });
      });
      plugin.onResolve({ filter: /^\.\/(BridgeExplorerLinks|IconTooltip)$/ }, () => ({ path: localAdapter }));
      // Resolve source aliases using esbuild's extension handling instead of
      // assuming every repository import is TSX.
    },
  }],
  resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.json'],
  logLevel: 'warning',
});
const forbidden = Object.keys(bundled.metafile.inputs).filter(file => /useTransactionPage|\/RawDataSection\.tsx|\/PrivacyRiskInline\.tsx|\/address-labels\.tsx?|\/next\//.test(file));
if (forbidden.length) throw new Error(`Forbidden lookup modules entered private UI: ${forbidden.join(', ')}`);
const escapedReact = Object.keys(bundled.metafile.inputs).filter(file => /(?:^|\/)node_modules\/react(?:-dom)?\//.test(file)
  && !resolve(ROOT, file).startsWith(`${resolve(APP, 'node_modules')}/`));
if (escapedReact.length) throw new Error(`React must resolve only inside the private prototype: ${escapedReact.join(', ')}`);
await mkdir(resolve(APP, '.local/ui'), { recursive: true });
await writeFile(resolve(APP, '.local/ui/bundle-inputs.json'), `${JSON.stringify(Object.keys(bundled.metafile.inputs), null, 2)}\n`);

const originalCss = await readFile(resolve(ROOT, 'app/globals.css'), 'utf8');
const css = originalCss.replace(/^@import "tailwindcss";\n/, '').replace(/^@source .*;\n/gm, '');
const additional = await readFile(resolve(HERE, 'private.css'), 'utf8');
const input = [
  `@import "${resolve(APP, 'node_modules/tailwindcss/index.css')}" source(none);`,
  `@source "${resolve(ROOT, 'components')}";`,
  `@source "${resolve(ROOT, 'app/tx')}";`,
  `@source "${resolve(ROOT, 'app/block')}";`,
  `@source "${HERE}";`,
  css, additional,
].join('\n');
const inputPath = resolve(APP, '.local/ui/input.css');
await writeFile(inputPath, input);
const result = spawnSync(process.execPath, [resolve(APP, 'node_modules/@tailwindcss/cli/dist/index.mjs'), '-i', inputPath, '-o', resolve(OUT, 'style.css'), '--minify'], { cwd: APP, stdio: 'inherit' });
if (result.status !== 0) throw new Error('Private UI stylesheet build failed.');

await mkdir(resolve(OUT, 'fonts'), { recursive: true });
const geist = resolve(APP, 'node_modules/geist/dist/fonts');
await copyFile(resolve(geist, 'geist-sans/Geist-Variable.woff2'), resolve(OUT, 'fonts/geist-sans.woff2'));
await copyFile(resolve(geist, 'geist-mono/GeistMono-Variable.woff2'), resolve(OUT, 'fonts/geist-mono.woff2'));
await copyFile(resolve(APP, 'node_modules/geist/LICENSE.txt'), resolve(OUT, 'fonts/LICENSE.txt'));
await mkdir(resolve(OUT, 'brand'), { recursive: true });
for (const file of ['zecblock-logotype.png', 'zecblock-logotype-light.png']) await copyFile(resolve(ROOT, 'public/brand', file), resolve(OUT, 'brand', file));
await copyFile(resolve(ROOT, 'public/favicon-32x32.png'), resolve(OUT, 'favicon.png'));
process.stdout.write(`Built private React transaction view from ${Object.keys(bundled.metafile.inputs).length} local source modules.\n`);
