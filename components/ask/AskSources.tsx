import type { AskDataContext, AskSource } from '@/lib/ask/chat';

export function AskSources({ sources, dataContext, inline = false }: { sources: AskSource[]; dataContext?: AskDataContext; inline?: boolean }) {
  if (!sources.length && !dataContext) return null;
  const content = <>
    {dataContext ? <div className="mt-3 leading-relaxed"><a href={dataContext.source} className="text-cipher-gold hover:underline">{dataContext.label} ↗</a>{dataContext.start && dataContext.end ? <p>{dataContext.start} – {dataContext.end} UTC</p> : null}<p>Retrieved {dataContext.retrievedAt.replace('T', ' ').slice(0, 19)} UTC</p><p>Retrieval time is when Ask read the data, not when the indexer last updated it.</p></div> : null}
    <ul aria-label="Answer sources" className="mt-3 space-y-2">{sources.map(source => <li key={source.id}><a href={source.url} rel="noopener noreferrer" target={source.url.startsWith('https://') ? '_blank' : undefined} className="text-cipher-gold hover:underline">{source.title} ↗</a><span className="block">Guide reviewed {source.reviewed}</span></li>)}</ul>
  </>;
  return inline ? content : <details className="mt-3 text-caption text-muted"><summary className="cursor-pointer text-cipher-gold hover:underline">Sources{dataContext?.end ? ` · observations through ${dataContext.end}` : ''}</summary>{content}</details>;
}
