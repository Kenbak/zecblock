'use strict';
// Read-only operator check. Uses only the dedicated DSN, never the primary URL.
const { Pool } = require('pg');
const { analyticsConfig, GUARD, checkGuard } = require('../v1/lib/ask-analytics');
async function main() {
  const config = analyticsConfig(process.env);
  if (!config) throw new Error('Not configured');
  const pool = new Pool({connectionString:config.connectionString,max:1,connectionTimeoutMillis:1500,statement_timeout:3000,query_timeout:3500,options:'-c default_transaction_read_only=on -c search_path=pg_catalog'});
  pool.on('error',()=>{});
  try {
    const guard = (await pool.query(GUARD)).rows[0];
    // Only booleans/aggregate replay age, no SQL, hosts, tables or credentials.
    console.log(JSON.stringify({event:'ask_analytics_audit',checks:guard || null}));
    checkGuard(guard);
    console.log(JSON.stringify({event:'ask_analytics_audit',status:'passed'}));
  } finally { await pool.end(); }
}
if(require.main===module) main().catch(()=> {console.error(JSON.stringify({event:'ask_analytics_audit',status:'failed'}));process.exitCode=1;});
