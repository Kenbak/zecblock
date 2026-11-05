'use strict';
// Import-map entries for rendering AskWorkspace in node tests. The lazily
// loaded CodeMirror editor is stood in for by a textarea with the same
// value/onChange(string)/onRun contract.
const React = require('react');
function SQLEditorStandIn({ value, onChange, disabled }) {
  return React.createElement('textarea', { value, disabled, 'aria-label': 'SQL query', 'data-sql-editor': '', onChange: event => onChange(event.target.value) });
}
module.exports = {
  'next/dynamic': { default: () => SQLEditorStandIn },
  '@/lib/ask/research-catalogue': require('../../lib/ask/research-catalogue'),
  '@/lib/ask/sql-examples': require('../../lib/ask/sql-examples'),
  '@/lib/ask/sql-display': require('../../lib/ask/sql-display'),
  '@/lib/ask/copy-button': require('../../lib/ask/copy-button'),
  '@/components/ask/ZiftMark': { ZiftMark: () => null },
  '@/components/ask/AskSQLTools': { SQLProblem: () => null, SQLStarters: () => null, SQLTables: () => null, editorPosition: () => null, sqlFeedbackFrom: () => null },
};
