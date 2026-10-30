const { bech32, bech32m } = require('bech32');
const crypto = require('crypto');

const MAX_BECH32_LENGTH = 1_000;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function hasValidEncoding(address, codec, expectedPrefix) {
  try {
    const decoded = codec.decode(address, MAX_BECH32_LENGTH);
    return decoded.prefix === expectedPrefix && decoded.words.length > 0;
  } catch {
    return false;
  }
}

/**
 * Validate the checksummed envelope of a Unified Address.
 * Full receiver extraction remains in the canonical zcash_address WASM
 * decoder used by the frontend; this guard prevents prefix-only strings from
 * being treated as valid API resources.
 */
function isValidUnifiedAddress(address) {
  if (typeof address !== 'string') return false;
  const expectedPrefix = address.startsWith('utest1') ? 'utest'
    : address.startsWith('u1') ? 'u'
      : null;
  return expectedPrefix !== null
    && hasValidEncoding(address, bech32m, expectedPrefix);
}

function isValidSaplingAddress(address) {
  if (typeof address !== 'string') return false;
  const expectedPrefix = address.startsWith('ztestsapling1') ? 'ztestsapling'
    : address.startsWith('zs1') ? 'zs'
      : null;
  return expectedPrefix !== null
    && hasValidEncoding(address, bech32, expectedPrefix);
}

function decodeBase58(value) {
  let number = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }

  let hex = number.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const body = number === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return Buffer.concat([Buffer.alloc(leadingZeroes), body]);
}

const BASE58_VERSIONS = new Map([
  ['1cb8', 22], // mainnet P2PKH (t1)
  ['1cbd', 22], // mainnet P2SH (t3)
  ['1d25', 22], // testnet P2PKH (tm)
  ['1cba', 22], // testnet P2SH (t2)
  ['169a', 66], // mainnet Sprout payment address (zc)
]);

/** Validate a supported transparent or Sprout Base58Check address. */
function isValidBase58CheckAddress(address) {
  if (typeof address !== 'string' || address.length < 20 || address.length > 200) return false;
  const decoded = decodeBase58(address);
  if (!decoded || decoded.length < 7) return false;
  const payload = decoded.subarray(0, -4);
  const checksum = decoded.subarray(-4);
  const expected = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  const expectedPayloadLength = BASE58_VERSIONS.get(payload.subarray(0, 2).toString('hex'));
  return expectedPayloadLength === payload.length
    && crypto.timingSafeEqual(checksum, expected);
}

function encodeBase58Check(payload) {
  const checksum = crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  let number = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  while (number > 0n) {
    encoded = BASE58_ALPHABET[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) encoded = `1${encoded}`;
  return encoded;
}

// ZIP 320: TEX HRPs and the P2PKH lead bytes of the address they re-encode.
const TEX_P2PKH_VERSIONS = new Map([
  ['tex', '1cb8'], // mainnet P2PKH (t1)
  ['textest', '1d25'], // testnet P2PKH (tm)
]);

/**
 * Return the P2PKH address that a TEX address (ZIP 320) re-encodes, or null.
 * A TEX address is Bech32m with HRP tex or textest over a 20-byte key hash,
 * and payments to it are ordinary P2PKH outputs to that address.
 */
function texToTransparentAddress(address) {
  try {
    const { prefix, words } = bech32m.decode(address, MAX_BECH32_LENGTH);
    const version = TEX_P2PKH_VERSIONS.get(prefix);
    const keyHash = Buffer.from(bech32m.fromWords(words));
    if (!version || keyHash.length !== 20) return null;
    return encodeBase58Check(Buffer.concat([Buffer.from(version, 'hex'), keyHash]));
  } catch {
    return null;
  }
}

module.exports = { isValidUnifiedAddress, isValidSaplingAddress, isValidBase58CheckAddress, texToTransparentAddress };
