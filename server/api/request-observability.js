'use strict';

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setDataHeader } = require('./lib/data-headers');
const {
  formatRequestTimings,
  runWithRequestTimings,
} = require('./request-timing-context');

function finiteNonNegativeInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Adds privacy-safe request and freshness diagnostics.
 *
 * Dynamic identifiers are deliberately excluded: this middleware emits only
 * an opaque request ID, aggregate chain heights/lag, and total server time.
 */
function createRequestObservability({
  getIndexedHeight = () => null,
  getDataAgeBlocks = () => null,
  createRequestId = randomUUID,
  now = () => performance.now(),
} = {}) {
  return function requestObservability(req, res, next) {
    const started = now();
    const requestId = createRequestId();
    req.requestId = requestId;
    res.set('X-Request-Id', requestId);

    const originalEnd = res.end;
    res.end = function observedEnd(...args) {
      if (!res.headersSent) {
        const indexedHeight = finiteNonNegativeInteger(getIndexedHeight());
        const dataAgeBlocks = finiteNonNegativeInteger(getDataAgeBlocks());
        if (indexedHeight !== null) {
          setDataHeader(res, 'Indexed-Height', String(indexedHeight));
        }
        if (dataAgeBlocks !== null) {
          setDataHeader(res, 'Data-Age-Blocks', String(dataAgeBlocks));
        }

        const elapsedMs = Math.max(0, now() - started).toFixed(1);
        const existing = [res.get('Server-Timing'), formatRequestTimings()]
          .filter(Boolean)
          .join(', ');
        const totalTiming = `app;dur=${elapsedMs}`;
        res.set('Server-Timing', existing ? `${existing}, ${totalTiming}` : totalTiming);
      }
      return originalEnd.apply(this, args);
    };

    runWithRequestTimings(next);
  };
}

module.exports = {
  createRequestObservability,
  finiteNonNegativeInteger,
};
