'use strict';

// Public data headers are sent under the ZecBlock name and, for existing
// clients, the original CipherScan name. Both carry the same value.
const DATA_HEADER_PREFIXES = ['X-ZecBlock-', 'X-CipherScan-'];

function setDataHeader(res, suffix, value) {
  for (const prefix of DATA_HEADER_PREFIXES) res.set(`${prefix}${suffix}`, value);
}

function dataHeaderNames(suffix) {
  return DATA_HEADER_PREFIXES.map((prefix) => `${prefix}${suffix}`);
}

module.exports = { setDataHeader, dataHeaderNames };
