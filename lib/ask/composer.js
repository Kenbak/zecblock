'use strict';
// Routing convenience only. Every SQL submission still passes server validation.
function sqlDraft(text) {
  const fenced = text.trim().match(/^```sql\s*\n([\s\S]*?)\n```$/i);
  const sql = fenced ? fenced[1].trim() : text.trim();
  const prefix = sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, '');
  if (fenced || /^with\s+(?:recursive\s+)?(?:"[^"]+"|[a-z_][\w]*)\s*(?:\([^)]*\))?\s+as\s*\(/i.test(prefix)
    || /^select\b/i.test(prefix) && (/\bfrom\b/i.test(prefix) || /^select\s+(?:[\d*'"(]|distinct\b)/i.test(prefix))
    || /^(?:drop\s+(?:table|schema|database)|delete\s+from|insert\s+into|update\s+[\w."]+\s+set|truncate\s|alter\s+(?:table|role)|copy\s|grant\s|revoke\s)/i.test(prefix)) return sql;
  return null;
}
module.exports = { sqlDraft };
