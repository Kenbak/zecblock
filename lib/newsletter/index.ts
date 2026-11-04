import fs from 'fs';
import path from 'path';
import { parseNewsletterSource } from './frontmatter';
import type { NewsletterIssue } from './types';
import { extractSections, parseNewsletterContent } from './parser';

export type {
  NewsletterIssue,
  ParsedSection,
  ParsedGrantGroup,
  ParsedQuote,
  ParsedSubsection,
  ParsedTable,
  ParsedTimelineItem,
  ParsedToolUpdate,
} from './types';
export { extractSections, parseNewsletterContent, parseNewsletterFooter } from './parser';
export { inlineMarkdown, proseMarkdown, extractFirstLink } from './inline';
export type { MarkdownLink } from './inline';
export { extractMarkdownTables, parseMarkdownTableBlock } from './tables';

const NEWSLETTER_DIR = path.join(process.cwd(), 'content', 'newsletter');
// Slugs are one filename segment, never filesystem paths or encoded paths.
const NEWSLETTER_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/;

export function getAllNewsletters(): NewsletterIssue[] {
  if (!fs.existsSync(NEWSLETTER_DIR)) return [];

  const files = fs.readdirSync(NEWSLETTER_DIR).filter((f) =>
    f.endsWith('.md') && NEWSLETTER_SLUG.test(f.slice(0, -3))
  );

  return files
    .map((file) => {
      const slug = file.replace('.md', '');
      const raw = fs.readFileSync(path.join(NEWSLETTER_DIR, file), 'utf8');
      const { data, content } = parseNewsletterSource(raw);

      return {
        slug,
        title: data.title || `Issue ${slug}`,
        summary: data.summary || '',
        date: data.date ? String(data.date) : slug,
        issue: data.issue || 0,
        content,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function getNewsletter(slug: string): NewsletterIssue | null {
  if (typeof slug !== 'string' || !NEWSLETTER_SLUG.test(slug)) return null;
  const filePath = path.join(NEWSLETTER_DIR, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf8');
  const { data, content } = parseNewsletterSource(raw);

  return {
    slug,
    title: data.title || `Issue ${slug}`,
    summary: data.summary || '',
    date: data.date ? String(data.date) : slug,
    issue: data.issue || 0,
    content,
  };
}

/** @deprecated Use NewsletterContent component instead */
export function markdownToHtml(md: string): string {
  const sections = parseNewsletterContent(md);
  return sections
    .map((s) => `<h2 id="${s.id}">${s.title}</h2>${s.body.replace(/\n/g, '<br/>')}`)
    .join('');
}
