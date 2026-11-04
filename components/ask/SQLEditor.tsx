'use client';

import { useEffect, useRef } from 'react';
import { EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, drawSelection, keymap, lineNumbers, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { PostgreSQL, sql } from '@codemirror/lang-sql';
import { tags } from '@lezer/highlight';
import type { ResearchDataset } from '@/lib/ask/research-catalogue';

// One highlighted error line, set from server feedback and cleared on edit.
const setErrorLine = StateEffect.define<number | null>();
const errorLine = StateField.define({
  create: () => Decoration.none,
  update(lines, transaction) {
    if (transaction.docChanged) return Decoration.none;
    for (const effect of transaction.effects) if (effect.is(setErrorLine)) {
      const number = effect.value;
      if (number === null || number < 1 || number > transaction.state.doc.lines) return Decoration.none;
      return Decoration.set([Decoration.line({ class: 'cm-sqlErrorLine' }).range(transaction.state.doc.line(number).from)]);
    }
    return lines;
  },
  provide: field => EditorView.decorations.from(field),
});

const theme = EditorView.theme({
  // Sits inside the Ask composer, which owns the border and focus ring.
  '&': { color: 'var(--color-text-primary)', backgroundColor: 'transparent', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-geist-mono), monospace', lineHeight: '1.65', minHeight: '140px', maxHeight: '380px' },
  '.cm-content': { caretColor: 'var(--color-gold)', padding: '14px 0 8px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--color-text-muted)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'rgb(var(--color-gold-rgb) / 0.22)' },
  '.cm-sqlErrorLine': { backgroundColor: 'rgb(var(--color-orange-rgb) / 0.16)' },
  '.cm-placeholder': { color: 'var(--color-text-muted)' },
  '.cm-tooltip': { backgroundColor: 'var(--color-elevated)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--color-hover)', color: 'var(--color-text-primary)' },
  '.cm-completionDetail': { color: 'var(--color-text-muted)', fontStyle: 'normal' },
});
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--color-gold)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-green)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--color-purple)' },
  { tag: tags.comment, color: 'var(--color-text-muted)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--color-info)' },
  { tag: tags.operator, color: 'var(--color-text-secondary)' },
]);

// Completion schema comes from the same reviewed catalogue the server enforces.
export function editorSchema(datasets: readonly ResearchDataset[]) {
  return Object.fromEntries(datasets.map(dataset => [dataset.id, dataset.columns.split(',').map(column => column.trim())]));
}

export function SQLEditor({ value, onChange, onRun, datasets, errorAt, disabled = false, labelledBy, autoFocus = false, onInsertReady }: {
  value: string; onChange: (value: string) => void; onRun: () => void; datasets: readonly ResearchDataset[];
  errorAt?: number | null; disabled?: boolean; labelledBy?: string; autoFocus?: boolean;
  // Gives the parent an insert-at-cursor function without importing CodeMirror itself.
  onInsertReady?: (insert: ((text: string) => boolean) | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Latest callbacks without rebuilding the editor on every render.
  const callbacks = useRef({ onChange, onRun, onInsertReady });
  callbacks.current = { onChange, onRun, onInsertReady };
  const schemaKey = datasets.map(dataset => dataset.id).join(',');

  useEffect(() => {
    if (!host.current) return;
    const extensions: Extension[] = [
      lineNumbers(), history(), drawSelection(), indentOnInput(), bracketMatching(), closeBrackets(),
      autocompletion({ activateOnTyping: true }), highlightSelectionMatches(), errorLine, theme, syntaxHighlighting(highlight),
      sql({ dialect: PostgreSQL, schema: editorSchema(datasets), upperCaseKeywords: true }),
      placeholder('SELECT … FROM blocks'),
      // Tab is left to the browser so keyboard users can leave the editor.
      Prec.highest(keymap.of([{ key: 'Mod-Enter', preventDefault: true, run: () => { callbacks.current.onRun(); return true; } }])),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap]),
      EditorView.updateListener.of(update => { if (update.docChanged) callbacks.current.onChange(update.state.doc.toString()); }),
      EditorView.contentAttributes.of({ 'aria-label': 'SQL query', ...(labelledBy ? { 'aria-labelledby': labelledBy } : {}), spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', translate: 'no' }),
      EditorView.lineWrapping,
    ];
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions }) });
    view.current = editor;
    if (autoFocus) editor.focus();
    callbacks.current.onInsertReady?.(text => insertInto(editor, text));
    return () => { callbacks.current.onInsertReady?.(null); editor.destroy(); view.current = null; };
    // The document is synchronized below; rebuild only when the schema changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey, labelledBy]);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);
  useEffect(() => { view.current?.dispatch({ effects: setErrorLine.of(errorAt ?? null) }); }, [errorAt, value]);
  useEffect(() => { view.current?.contentDOM.setAttribute('aria-disabled', String(disabled)); }, [disabled]);

  return <div ref={host} data-testid="sql-editor" />;
}

// Insert text at the cursor of a mounted editor (used by the table picker).
export function insertInto(editor: EditorView | null, text: string) {
  if (!editor) return false;
  const { from, to } = editor.state.selection.main;
  editor.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  editor.focus();
  return true;
}
