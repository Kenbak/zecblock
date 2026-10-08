/** Display optional coinbase bytes as text, retaining UTF-8 miner messages.
 * Binary/control bytes become dots; raw hex remains the lossless source.
 * null means unavailable or malformed data, while "" is an observed empty tag.
 */
export function decodeCoinbaseMessage(hex: string | null | undefined): string | null {
  if (hex === '') return '';
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;

  const bytes = Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
    .replace(/[\p{Cc}\p{Cf}\uFFFD]/gu, '.');
}
