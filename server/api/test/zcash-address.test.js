const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { bech32, bech32m } = require('bech32');
const {
  isValidBase58CheckAddress,
  isValidUnifiedAddress,
  isValidSaplingAddress,
  texToTransparentAddress,
} = require('../lib/zcash-address');

const MAINNET_UA = 'u1fh3kwyl9hq9q907rx9j8mdy2r7gz4xh0y4yt63dxykk2856gr0238vxsegemyfu8s5a77ycq72tcnzkxa75ykjtcn6wp2w9rtuu3ssdzpe2fyghl8wlk3vh6f67304xe4lrxtvywtudy5t434zc07u6mh27ekufx7ssr55l8875z7f4k76c3tk23s3jzf8rxdlkequlta8lwsv09gxm';

test('accepts a checksummed mainnet unified address', () => {
  assert.equal(isValidUnifiedAddress(MAINNET_UA), true);
});

test('rejects prefix-only and checksum-corrupted unified addresses', () => {
  assert.equal(isValidUnifiedAddress('u1not-an-address'), false);
  assert.equal(isValidUnifiedAddress(`${MAINNET_UA.slice(0, -1)}q`), false);
  assert.equal(isValidUnifiedAddress(`${MAINNET_UA.slice(0, 10).toUpperCase()}${MAINNET_UA.slice(10)}`), false);
});

test('does not confuse unified and Sapling encodings', () => {
  assert.equal(isValidSaplingAddress(MAINNET_UA), false);
});

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58Check(payload) {
  const checksum = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

test('validates Base58Check envelopes and rejects corrupted transparent/Sprout-like strings', () => {
  const valid = encodeBase58Check(Buffer.from('1cb8'.padEnd(44, '0'), 'hex'));
  assert.equal(isValidBase58CheckAddress(valid), true);
  assert.equal(isValidBase58CheckAddress(`${valid.slice(0, -1)}1`), false);
  assert.equal(isValidBase58CheckAddress('t1not-a-real-zcash-address'), false);
  assert.equal(isValidBase58CheckAddress('zcnot-a-real-zcash-address'), false);
  assert.equal(
    isValidBase58CheckAddress(encodeBase58Check(Buffer.from('0000'.padEnd(44, '0'), 'hex'))),
    false,
    'a valid checksum with an unsupported version is not a Zcash address',
  );
});

// TEX/P2PKH pairs from zcash-test-vectors test-vectors/json/zip_0320.json
// (Mainnet) and librustzcash zcash_address tex_testnet (Testnet).
const TEX_PAIRS = [
  ['tex10wur2u9clts5dcpu2vc6qg93uzyj7cca2xm732', 't1V9mnyk5Z5cTNMCkLbaDwSskgJZucTLdgW'],
  ['tex1rkq7seu3cukjjtusde7q8xnjne93laluyvdxu7', 't1LZdE42PAt1wREUv1YMYRFwJDPHPW8toLL'],
  ['tex1w8clcm7kjdc0yds32d4nke88muwwhmmfunhkhd', 't1UG6FVxexmJRFXG4gvEmSF9HSTwHMFaSDT'],
  ['textest1qyqszqgpqyqszqgpqyqszqgpqyqszqgpfcjgfy', 'tm9ofD7kHR7AF8MsJomEzLqGcrLCBkD9gDj'],
];

test('maps ZIP 320 TEX addresses to the P2PKH address they re-encode', () => {
  for (const [tex, transparent] of TEX_PAIRS) assert.equal(texToTransparentAddress(tex), transparent, tex);
});

test('rejects TEX strings with a bad checksum, HRP, length, mixed case or Bech32 checksum', () => {
  const [tex] = TEX_PAIRS[0];
  const keyHash = Buffer.from('7bb83570b8fae146e03c5331a020b1e0892f631d', 'hex');
  for (const invalid of [
    `${tex.slice(0, -1)}q`,
    bech32m.encode('u', bech32m.toWords(keyHash)),
    bech32m.encode('tex', bech32m.toWords(keyHash.subarray(1))),
    bech32m.encode('tex', bech32m.toWords(Buffer.concat([keyHash, Buffer.alloc(1)]))),
    `${tex.slice(0, 4)}${tex.slice(4, 12).toUpperCase()}${tex.slice(12)}`,
    bech32.encode('tex', bech32.toWords(keyHash)),
    'tex1not-an-address',
  ]) {
    assert.equal(texToTransparentAddress(invalid), null, invalid);
  }
});
