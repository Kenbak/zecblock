// Minimal animated GIF89a encoder for client-side chart exports. No
// dependencies: one global 256-color palette (popularity over 15-bit color
// buckets, with required colors always kept), LZW-compressed full frames and an
// infinite NETSCAPE loop. Good for flat chart graphics; not a photo encoder.

export interface GifPalette {
  /** 256 RGB triplets. */
  colors: Uint8Array;
  /** 15-bit (5:5:5) color bucket -> palette index. */
  lookup: Uint8Array;
}

const bucket = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Build a palette from sample frames; `required` colors (#rrggbb) are always present. */
export function buildPalette(samples: Uint8ClampedArray[], required: string[] = []): GifPalette {
  const counts = new Uint32Array(32768);
  for (const data of samples) for (let i = 0; i < data.length; i += 4) counts[bucket(data[i], data[i + 1], data[i + 2])]++;
  const chosen: number[] = [];
  const seen = new Set<number>();
  for (const hex of required) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) continue;
    const v = parseInt(m[1], 16);
    const key = bucket(v >> 16, (v >> 8) & 255, v & 255);
    if (!seen.has(key) && chosen.length < 64) { seen.add(key); chosen.push(key); }
  }
  const order = Array.from(counts.keys()).filter(k => counts[k] > 0 && !seen.has(k)).sort((a, b) => counts[b] - counts[a]);
  for (const k of order) { if (chosen.length >= 256) break; chosen.push(k); }
  while (chosen.length < 256) chosen.push(0);
  const colors = new Uint8Array(256 * 3);
  chosen.forEach((k, i) => {
    colors[i * 3] = ((k >> 10) & 31) * 8 + 4; colors[i * 3 + 1] = ((k >> 5) & 31) * 8 + 4; colors[i * 3 + 2] = (k & 31) * 8 + 4;
  });
  const lookup = new Uint8Array(32768);
  for (let k = 0; k < 32768; k++) {
    const r = ((k >> 10) & 31) * 8 + 4, g = ((k >> 5) & 31) * 8 + 4, b = (k & 31) * 8 + 4;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = r - colors[i * 3], dg = g - colors[i * 3 + 1], db = b - colors[i * 3 + 2];
      const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    lookup[k] = best;
  }
  return { colors, lookup };
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private buf = new Uint8Array(1 << 16);
  private pos = 0;
  byte(v: number) { if (this.pos === this.buf.length) this.flush(); this.buf[this.pos++] = v & 255; }
  word(v: number) { this.byte(v); this.byte(v >> 8); }
  bytes(a: ArrayLike<number>) { for (let i = 0; i < a.length; i++) this.byte(a[i]); }
  text(s: string) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  private flush() { this.chunks.push(this.buf.slice(0, this.pos)); this.buf = new Uint8Array(1 << 16); this.pos = 0; }
  blob(type: string) { this.flush(); return new Blob(this.chunks as BlobPart[], { type }); }
}

/** LZW-compress palette indices with an 8-bit minimum code size, written as GIF sub-blocks. */
function writeLzw(out: ByteWriter, indices: Uint8Array) {
  const MIN = 8, CLEAR = 1 << MIN, EOI = CLEAR + 1;
  let codeSize = MIN + 1, next = EOI + 1;
  let dict = new Map<number, number>();
  let block: number[] = [], acc = 0, bits = 0;
  const emit = (code: number) => {
    acc |= code << bits; bits += codeSize;
    while (bits >= 8) {
      block.push(acc & 255); acc >>>= 8; bits -= 8;
      if (block.length === 255) { out.byte(255); out.bytes(block); block = []; }
    }
  };
  out.byte(MIN);
  emit(CLEAR);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = (prefix << 8) | c;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(CLEAR); dict = new Map(); codeSize = MIN + 1; next = EOI + 1;
    }
    prefix = c;
  }
  emit(prefix);
  emit(EOI);
  if (bits > 0) block.push(acc & 255);
  if (block.length) { out.byte(block.length); out.bytes(block); }
  out.byte(0);
}

/** Encode RGBA frames (all width x height) as a looping GIF. delayMs is per frame. */
export function encodeGif(frames: Uint8ClampedArray[], width: number, height: number, palette: GifPalette, delayMs: number): Blob {
  const out = new ByteWriter();
  out.text('GIF89a'); out.word(width); out.word(height);
  out.byte(0xf7); out.byte(0); out.byte(0); // global table, 8-bit color resolution, 256 entries
  out.bytes(palette.colors);
  out.byte(0x21); out.byte(0xff); out.byte(11); out.text('NETSCAPE2.0'); out.byte(3); out.byte(1); out.word(0); out.byte(0);
  const delay = Math.max(2, Math.round(delayMs / 10));
  const indices = new Uint8Array(width * height);
  for (const data of frames) {
    for (let p = 0, i = 0; p < indices.length; p++, i += 4) indices[p] = palette.lookup[bucket(data[i], data[i + 1], data[i + 2])];
    out.byte(0x21); out.byte(0xf9); out.byte(4); out.byte(0); out.word(delay); out.byte(0); out.byte(0);
    out.byte(0x2c); out.word(0); out.word(0); out.word(width); out.word(height); out.byte(0);
    writeLzw(out, indices);
  }
  out.byte(0x3b);
  return out.blob('image/gif');
}
