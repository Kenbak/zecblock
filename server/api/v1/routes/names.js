/** Native v1 name reads. The fixed ZNS service remains the data authority. */
const { sendSuccess } = require('../lib/envelope');
const { sendProblem } = require('../lib/problem');
const { encodeCursor, decodeCursor } = require('../lib/cursor');

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), normalize(v)]));
  return value;
}
function buildNamesHandler(entry, config) {
  return async (req, res) => {
    const rpc = async (method, params = {}) => {
      const response = await fetch(config.znsUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.any([req.v1.abortSignal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error('ZNS unavailable');
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('ZNS response too large'); }
        chunks.push(Buffer.from(value));
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload || payload.error || !Object.hasOwn(payload, 'result')) throw new Error('Invalid ZNS response');
      return normalize(payload.result);
    };
    try {
      res.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      if (entry.v1.nativeKey === 'nameStatus') return sendSuccess(res, await rpc('status'));
      if (entry.v1.nativeKey === 'names') {
        const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
        const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : null;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500 || (req.query.cursor && (!cursor || cursor.route !== '/v1/names' || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 100000))) {
          return sendProblem(res, 'validation-error', { detail: 'Invalid name collection limit or cursor.' });
        }
        const offset = cursor?.offset ?? 0;
        const all = await rpc('resolve', { query: '', limit: Math.min(limit + 1, 500), offset });
        if (!Array.isArray(all)) throw new Error('Invalid ZNS collection');
        let hasNext = all.length > limit;
        if (!hasNext && all.length === limit && limit === 500) {
          const probe = await rpc('resolve', { query: '', limit: 1, offset: offset + limit });
          if (!Array.isArray(probe)) throw new Error('Invalid ZNS collection probe');
          hasNext = probe.length > 0;
        }
        return sendSuccess(res, all.slice(0, limit), { page: {
          limit, hasNext, hasPrev: offset > 0,
          nextCursor: hasNext ? encodeCursor({ route: '/v1/names', offset: offset + limit }) : null,
          prevCursor: offset > 0 ? encodeCursor({ route: '/v1/names', offset: Math.max(0, offset - limit) }) : null,
        } });
      }
      const name = req.params.name.trim().toLowerCase().replace(/\.(zcash|zec)$/, '');
      if (!/^[a-z0-9]{1,62}$/.test(name)) return sendProblem(res, 'validation-error', { detail: 'Names contain 1–62 letters or digits.' });
      if (entry.v1.nativeKey === 'nameEvents') return sendSuccess(res, await rpc('events', { name, limit: 50 }));
      const registration = await rpc('resolve', { query: name });
      const data = registration || { pricing: (await rpc('status')).pricing ?? null };
      return sendSuccess(res, data);
    } catch {
      return sendProblem(res, 'upstream-error', { detail: 'The name registry is temporarily unavailable.' });
    }
  };
}
module.exports = { buildNamesHandler, normalize };
