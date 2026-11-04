'use strict';

const RETRY_MINUTES = 5;
const MAX_ATTEMPTS = 5;

async function deliverSourceReply(db, xClient, parent, { logger = console } = {}) {
  if (!parent.sourceReply || xClient.dryRun) return null;
  if (typeof xClient.reply !== 'function') return { status: 'unsupported' };
  if (!/^\d+$/.test(String(parent.id))) throw new Error('Invalid source-reply parent ID');
  const key = `source_reply:${parent.key}`;
  const metadata = { deliveryRole: 'source_reply', parentKey: parent.key,
    parentPostId: String(parent.id), sourceUrl: parent.sourceReply.url };
  const { rows: [claim] } = await db.query(`INSERT INTO social_post_outbox
    (post_type,dedup_key,content,metadata,status,attempts)
    VALUES ('source_reply',$1,$2,$3::jsonb,'posting',1)
    ON CONFLICT(dedup_key) DO UPDATE SET status='posting',attempts=social_post_outbox.attempts+1,
      updated_at=NOW(),error_message=NULL
    WHERE social_post_outbox.status='retryable' AND social_post_outbox.attempts<$4
      AND social_post_outbox.updated_at<=NOW()-($5::text||' minutes')::interval
    RETURNING id,attempts`, [key, parent.sourceReply.content, JSON.stringify(metadata), MAX_ATTEMPTS, RETRY_MINUTES]);
  if (!claim) return { status: 'held-or-complete', key };
  try {
    const result = await xClient.reply(parent.sourceReply.content, String(parent.id));
    if (!/^\d+$/.test(String(result?.id))) throw new Error('Missing real X source-reply ID');
    logger.info(`[Editorial source] X accepted ${key}: ${result.id}`);
    await db.query(`UPDATE social_post_outbox SET status='posted',x_post_id=$2,
      posted_at=NOW(),updated_at=NOW() WHERE id=$1`, [claim.id, String(result.id)]);
    return { status: 'posted', key, id: String(result.id) };
  } catch (error) {
    // Retry only a definite rejection for rate limiting. Timeouts, lost response
    // IDs and DB failures after acceptance are ambiguous and stay held.
    const status = error.statusCode === 429 ? claim.attempts >= MAX_ATTEMPTS ? 'blocked' : 'retryable'
      : error.statusCode >= 400 && error.statusCode < 500 ? 'blocked' : 'uncertain';
    await db.query(`UPDATE social_post_outbox SET status=$2,error_message=$3,updated_at=NOW() WHERE id=$1`,
      [claim.id, status, String(error.message).slice(0, 500)]);
    logger.error(`[Editorial source] ${key}: ${status}: ${error.message}`);
    return { status, key };
  }
}

async function recoverSourceReplies(db, xClient, { logger = console } = {}) {
  if (xClient.dryRun || typeof xClient.reply !== 'function') return [];
  // Only new two-part publications qualify. Old posts are never backfilled.
  // A crash after recording the parent but before claiming its reply is safe.
  const { rows } = await db.query(`SELECT p.dedup_key,p.x_post_id,p.metadata
    FROM social_post_outbox p LEFT JOIN social_post_outbox r
      ON r.dedup_key='source_reply:'||p.dedup_key
    WHERE p.status='posted' AND p.x_post_id IS NOT NULL
      AND p.metadata->>'deliveryVersion'='2'
      AND p.posted_at>=NOW()-interval '7 days'
      AND (r.id IS NULL OR (r.status='retryable' AND r.attempts<$1
        AND r.updated_at<=NOW()-($2::text||' minutes')::interval))
    ORDER BY p.posted_at,p.id LIMIT 3`, [MAX_ATTEMPTS, RETRY_MINUTES]);
  const results = [];
  for (const row of rows) {
    const sourceReply = row.metadata?.sourceReply;
    if (!sourceReply?.content || !sourceReply.url) continue;
    results.push(await deliverSourceReply(db, xClient,
      { key: row.dedup_key, id: row.x_post_id, sourceReply }, { logger }));
  }
  return results;
}

module.exports = { deliverSourceReply, recoverSourceReplies };
