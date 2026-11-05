'use strict';

const MAX_USER_AGENT_LENGTH = 255;
// Component names advertised by betterclever/zebend at ec5f7ec (including
// its outbound NU7 testnet fetcher). These are self-reported identities;
// recognizing one does not establish chain identity or full-node services.
const ZEBEND_CLIENT_NAMES = new Set([
  'zebend', 'zebend-fullnode', 'zebend-follow', 'zebend-mempool',
  'zebend-nu7-testnet-fetch',
]);

function firstVersion(segments, name) {
  return segments.find((segment) => segment.name.toLowerCase() === name)?.version || null;
}

function parsePeerClient(value) {
  const userAgent = typeof value === 'string'
    ? value.trim().slice(0, MAX_USER_AGENT_LENGTH)
    : '';

  if (!userAgent) {
    return { clientImpl: 'Unknown', clientVersion: null, userAgent: null };
  }

  const segments = Array.from(
    userAgent.matchAll(/\/?([^/:\s]+):v?([^/\s]+)\/?/g),
    (match) => ({ name: match[1], version: match[2] })
  );

  const zebendVersion = segments.find((segment) => ZEBEND_CLIENT_NAMES.has(segment.name.toLowerCase()))?.version;
  if (zebendVersion) {
    return { clientImpl: 'Zebend', clientVersion: zebendVersion, userAgent };
  }

  const zakuraVersion = firstVersion(segments, 'zakura');
  if (zakuraVersion) {
    return { clientImpl: 'Zakura', clientVersion: zakuraVersion, userAgent };
  }

  const zebraVersion = firstVersion(segments, 'zebra');
  if (zebraVersion) {
    return { clientImpl: 'Zebra', clientVersion: zebraVersion, userAgent };
  }

  const zcashdVersion = firstVersion(segments, 'magicbean');
  if (zcashdVersion) {
    return { clientImpl: 'zcashd', clientVersion: zcashdVersion, userAgent };
  }

  const seederMatch = userAgent.match(/^zeeder\/([^\s/]+)/i);
  if (seederMatch) {
    return { clientImpl: 'Seeder', clientVersion: seederMatch[1], userAgent };
  }

  const generic = segments[0];
  return {
    clientImpl: generic ? 'Other' : 'Unknown',
    clientVersion: generic?.version || null,
    userAgent,
  };
}

function parsePeerAddress(value, defaultPort = 8233) {
  const address = typeof value === 'string' ? value.trim() : '';
  if (!address) return { host: null, port: defaultPort };

  const bracketed = address.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    return {
      host: bracketed[1],
      port: Number(bracketed[2]) || defaultPort,
    };
  }

  const separator = address.lastIndexOf(':');
  if (separator > 0) {
    const possiblePort = address.slice(separator + 1);
    if (/^\d+$/.test(possiblePort)) {
      return {
        host: address.slice(0, separator),
        port: Number(possiblePort) || defaultPort,
      };
    }
  }

  return { host: address, port: defaultPort };
}

module.exports = {
  MAX_USER_AGENT_LENGTH,
  parsePeerAddress,
  parsePeerClient,
};
