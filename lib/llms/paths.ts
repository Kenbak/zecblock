// Path rules for the Markdown versions of pages served to language models
// (llms.txt convention, https://llmstxt.org). Kept free of data imports so the
// shared metadata builder can use it on every page.

import { CONTENT_PATHS, CORE_PATHS, TOOL_PATHS } from '@/lib/sitemaps';

const STATIC_PAGES = new Set<string>(
  [...CORE_PATHS, ...CONTENT_PATHS, ...TOOL_PATHS].map(path => path.split('?')[0]),
);

/** Data pages share one Markdown description per page type. */
export const MARKDOWN_TEMPLATES = {
  '/tx/': '/tx.md',
  '/block/': '/block.md',
  '/address/': '/address.md',
  '/name/': '/name.md',
} as const;

/** Markdown URL path for a page path: the page URL with `.md` appended. */
export function markdownPathFor(path: string): string {
  const clean = path.split(/[?#]/)[0] || '/';
  for (const [prefix, template] of Object.entries(MARKDOWN_TEMPLATES)) {
    if (clean.startsWith(prefix)) return template;
  }
  if (clean === '/') return '/index.md';
  return `${clean.replace(/\/+$/, '')}.md`;
}

/** Internal route segments for a Markdown path, e.g. /charts/mvrv.md → ['charts', 'mvrv']. */
export function markdownRouteSegments(markdownPath: string): string[] {
  return markdownPath.replace(/^\//, '').replace(/\.md$/, '').split('/');
}

/**
 * Whether a page has a Markdown version: every static sitemap page, every
 * chart and newsletter issue, and the shared data page types. CI checks the
 * documents behind this rule exist (server/tests/llms-docs.test.js).
 */
export function hasMarkdownVersion(path: string): boolean {
  const clean = path.split(/[?#]/)[0] || '/';
  if (STATIC_PAGES.has(clean)) return true;
  if (Object.keys(MARKDOWN_TEMPLATES).some(prefix => clean.startsWith(prefix))) return true;
  return /^\/(charts|newsletter)\/[a-z0-9][a-z0-9_-]*$/i.test(clean);
}
