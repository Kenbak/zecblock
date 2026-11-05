'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api-client';
import type { ResearchDataset } from '@/lib/ask/research-catalogue';
import { sqlFeedbackSchema, type SQLFeedback } from '@/lib/ask/sql-feedback';
import type { SQLExample } from '@/lib/ask/sql-examples';
import styles from './AskSQLTools.module.css';

const STAGES: Record<SQLFeedback['stage'], string> = { syntax: 'Syntax error', policy: 'Not supported here', database: 'Query error', cost: 'Query too large' };

// Feedback about the visitor's own SQL, schema-checked from the problem document.
export function sqlFeedbackFrom(error: unknown): SQLFeedback | null {
  const parsed = error instanceof ApiError ? sqlFeedbackSchema.safeParse(error.extensions?.sql) : null;
  return parsed?.success ? parsed.data : null;
}

// The server validates trimmed SQL; shift its line/column back to the editor text.
export function editorPosition(feedback: SQLFeedback, sql: string) {
  if (!feedback.line) return null;
  const lines = (/^\s*/.exec(sql)?.[0] || '').split('\n');
  return { line: feedback.line + lines.length - 1, column: feedback.line === 1 && feedback.column ? feedback.column + lines.at(-1)!.length : feedback.column };
}

export function SQLProblem({ feedback, sql }: { feedback: SQLFeedback; sql: string }) {
  const at = editorPosition(feedback, sql);
  return <div className={styles.problem} role="alert">
    <p className={styles.problemTitle}>{STAGES[feedback.stage]}{at ? <span className={styles.position}> · line {at.line}{at.column ? `, column ${at.column}` : ''}</span> : null}</p>
    <p className={styles.problemMessage}>{feedback.message}</p>
    {feedback.hint ? <p className={styles.hint}>{feedback.hint}</p> : null}
  </div>;
}

// Collapsed by default: one row of table names; opening a table shows its columns.
export function SQLTables({ datasets, onInsert }: { datasets: readonly ResearchDataset[]; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [table, setTable] = useState<string | null>(null);
  const selected = datasets.find(dataset => dataset.id === table);
  return <div className={styles.tables}>
    <button type="button" className={styles.toggle} aria-expanded={open} onClick={() => setOpen(value => !value)}>Tables {open ? '▴' : '▾'}</button>
    {open ? <div className={styles.panel}>
      <div className={styles.chips} role="group" aria-label="Tables">{datasets.map(dataset => <button type="button" key={dataset.id} aria-pressed={table === dataset.id} className={styles.chip} onClick={() => setTable(table === dataset.id ? null : dataset.id)} title={dataset.title}>{dataset.id}</button>)}</div>
      {selected ? <div className={styles.detail}>
        <p className={styles.description}>{selected.description}</p>
        <div className={styles.chips} role="group" aria-label={`${selected.id} columns`}>
          <button type="button" className={`${styles.chip} ${styles.insertTable}`} onClick={() => onInsert(selected.id)}>insert {selected.id}</button>
          {selected.columns.split(',').map(column => column.trim()).map(column => <button type="button" key={column} className={styles.chip} onClick={() => onInsert(column)}>{column}</button>)}
        </div>
      </div> : <p className={styles.description}>Pick a table to see its columns. Times are Unix seconds (UTC); amounts are zatoshis, so divide by 100000000 for ZEC.</p>}
    </div> : null}
  </div>;
}

export function SQLStarters({ examples, onPick, disabled }: { examples: readonly SQLExample[]; onPick: (example: SQLExample) => void; disabled?: boolean }) {
  return <div className={styles.starters}>{examples.map(example => <button type="button" key={example.id} disabled={disabled} className={styles.starter} onClick={() => onPick(example)} title={example.description}>{example.title}</button>)}</div>;
}
