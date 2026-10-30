import { detectAddressType } from './zcash';

/**
 * Syntax-only address check shared by the proxy and the address route. It
 * decides malformed URLs before rendering; checksum and receiver validation
 * remain the API's responsibility.
 */
export function isValidAddressSyntax(address: string): boolean {
  const type = detectAddressType(address);

  if (type === 'transparent') {
    return address.length === 35 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(address);
  }

  if (type === 'shielded') {
    // Sapling: 78 characters on mainnet (zs1...), 88 on testnet (ztestsapling1...).
    return (address.length === 78 && /^zs1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(address))
      || (address.length === 88 && /^ztestsapling1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(address));
  }

  if (type === 'unified') {
    return address.length >= 16
      && address.length <= 512
      && /^(?:u|utest)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(address);
  }

  if (type === 'tex') {
    // ZIP 320: a 20-byte key hash in Bech32m is always 38 data characters.
    return /^(?:tex|textest)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/.test(address);
  }

  return false;
}
