'use strict';
// Issue a Zift SQL-over-MCP key. Prints the raw key once (give it to the key
// holder) and the ZIFT_MCP_SQL_KEYS entry to add on the API host. The server
// stores only the SHA-256 hash; a lost key is replaced, never recovered.
// Usage: node scripts/mcp-sql-key.js <label>   (label: a-z, 0-9, _ or -)
const { randomBytes, createHash } = require('node:crypto');
const label = process.argv[2];
if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(label || '')) {
  console.error('Usage: node scripts/mcp-sql-key.js <label>  (lowercase letters, digits, _ or -, up to 32)');
  process.exit(1);
}
const key = `zift_${randomBytes(24).toString('base64url')}`;
console.log(`Key for ${label} (shown once):\n  ${key}\n\nAdd to ZIFT_MCP_SQL_KEYS on the API host (comma-separated):\n  ${label}:${createHash('sha256').update(key).digest('hex')}`);
