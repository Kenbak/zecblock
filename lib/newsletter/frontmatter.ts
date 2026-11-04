import { parseDocument } from 'yaml';

interface NewsletterMetadata {
  title?: string;
  summary?: string;
  date?: string;
  issue?: number;
}

/** Newsletter files use YAML metadata only; never select an executable engine. */
export function parseNewsletterSource(raw: string): { data: NewsletterMetadata; content: string } {
  const source = raw.replace(/^\uFEFF/, '');
  if (!source.startsWith('---')) return { data: {}, content: source };

  const header = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(source);
  if (!header || header.index !== 0) throw new Error('Invalid newsletter YAML front matter');

  const document = parseDocument(header[1], { schema: 'core' });
  if (document.errors.length || document.warnings.length) {
    throw new Error('Invalid newsletter YAML metadata');
  }
  const metadata: unknown = document.toJS({ maxAliasCount: 100 }) ?? {};
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Newsletter metadata must be a mapping');
  }
  const data = metadata as Record<string, unknown>;
  for (const key of ['title', 'summary', 'date']) {
    if (data[key] != null && typeof data[key] !== 'string') {
      throw new Error(`Newsletter ${key} must be a string`);
    }
  }
  if (data.issue != null && (!Number.isSafeInteger(data.issue) || (data.issue as number) < 0)) {
    throw new Error('Newsletter issue must be a nonnegative integer');
  }
  return { data: data as NewsletterMetadata, content: source.slice(header[0].length) };
}
