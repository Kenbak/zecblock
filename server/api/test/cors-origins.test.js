'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OWN_HTTP_ORIGINS, PARTNER_HTTP_ORIGINS, allowedHttpOrigins } = require('../cors-origins');

test('HTTP CORS allows our domains and the Shielded Labs NSM page', () => {
  const origins = allowedHttpOrigins({});
  for (const origin of ['https://zecblock.com', 'https://www.zecblock.com', 'https://cipherscan.app', 'https://nsm.shieldedlabs.net']) {
    assert.ok(origins.includes(origin), origin);
  }
  assert.ok(!origins.includes('https://shieldedlabs.net'));
  assert.ok(!origins.includes('https://evil.example'));
});

test('CORS_ORIGINS adds trimmed extra origins and ignores empty entries', () => {
  const origins = allowedHttpOrigins({ CORS_ORIGINS: ' https://a.example, ,https://b.example ' });
  assert.ok(origins.includes('https://a.example'));
  assert.ok(origins.includes('https://b.example'));
  assert.ok(!origins.includes(''));
  assert.equal(origins.length, OWN_HTTP_ORIGINS.length + PARTNER_HTTP_ORIGINS.length + 2);
});

test('partner origins get HTTP CORS only, not WebSocket access', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const own = source.slice(source.indexOf('const OWN_ORIGINS = ['), source.indexOf('];', source.indexOf('const OWN_ORIGINS = [')));
  assert.ok(own.length > 0);
  for (const origin of PARTNER_HTTP_ORIGINS) assert.ok(!own.includes(origin), origin);
  assert.match(source, /const allowedOrigins = allowedHttpOrigins\(\);/);
});
