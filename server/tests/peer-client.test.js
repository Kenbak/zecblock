'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePeerAddress, parsePeerClient } = require('../lib/peer-client');

const cases = [
  ['/Zebra:6.0.0/', 'Zebra', '6.0.0'],
  ['/Zebra:6.0.0-rc.0/', 'Zebra', '6.0.0-rc.0'],
  ['/Zebra:6.0.0-modified/', 'Zebra', '6.0.0-modified'],
  ['/MagicBean:6.20.0/', 'zcashd', '6.20.0'],
  ['/Zakura:1.0.0/', 'Zakura', '1.0.0'],
  ['/Zakura:1.0.0-rc3/Zakura:1.0.0-rc4/', 'Zakura', '1.0.0-rc3'],
  ['/Zakura:8.0.0/Zebra:5.0.0-rc.3/', 'Zakura', '8.0.0'],
  ['/Zebend:0.1.0/', 'Zebend', '0.1.0'],
  ['/Zebend-fullnode:0.1/', 'Zebend', '0.1'],
  ['/Zebend-follow:0.1/', 'Zebend', '0.1'],
  ['/Zebend-mempool:0.1/', 'Zebend', '0.1'],
  ['/Zebend-nu7-testnet-fetch:0.1/', 'Zebend', '0.1'],
  ['/ZEBEND-FULLNODE:v0.2.0-rc.1/', 'Zebend', '0.2.0-rc.1'],
  ['/Zebra:7.0.0/Zebend:0.1.0/', 'Zebend', '0.1.0'],
  ['/NotZebend:0.1/', 'Other', '0.1'],
  ['/Zebendish:0.1/', 'Other', '0.1'],
  ['/Zebend-unrecognized:0.1/', 'Other', '0.1'],
  ['zeeder/1.4.0', 'Seeder', '1.4.0'],
  ['/CustomNode:2.1.0-beta.1/', 'Other', '2.1.0-beta.1'],
  ['', 'Unknown', null],
  [null, 'Unknown', null],
  ['malformed', 'Unknown', null],
];

for (const [input, clientImpl, clientVersion] of cases) {
  test(`classifies ${JSON.stringify(input)} as ${clientImpl}`, () => {
    const result = parsePeerClient(input);
    assert.equal(result.clientImpl, clientImpl);
    assert.equal(result.clientVersion, clientVersion);
  });
}

test('retains Zebend component identity in the raw user agent', () => {
  const userAgent = '/Zebend-nu7-testnet-fetch:0.1/';
  assert.deepEqual(parsePeerClient(userAgent), {
    clientImpl: 'Zebend', clientVersion: '0.1', userAgent,
  });
});

test('truncates raw user agents before persistence', () => {
  const result = parsePeerClient(`/Custom:${'x'.repeat(300)}/`);
  assert.equal(result.userAgent.length, 255);
});

test('parses IPv4, DNS, Tor, and bracketed IPv6 peer addresses', () => {
  assert.deepEqual(parsePeerAddress('198.51.100.1:8233'), {
    host: '198.51.100.1',
    port: 8233,
  });
  assert.deepEqual(parsePeerAddress('seed.example.org:18233'), {
    host: 'seed.example.org',
    port: 18233,
  });
  assert.deepEqual(parsePeerAddress('examplelonghiddenservice.onion:8233'), {
    host: 'examplelonghiddenservice.onion',
    port: 8233,
  });
  assert.deepEqual(parsePeerAddress('[2001:db8::1]:8233'), {
    host: '2001:db8::1',
    port: 8233,
  });
});
