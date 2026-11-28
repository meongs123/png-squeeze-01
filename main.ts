import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// ============================================================================
// 1. CRC32, ADLER32 & PNG CHUNK BUILDERS
// ============================================================================
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Uint8Array, start = 0, len = buf.length - start): number {
  let crc = 0xffffffff;
  const end = start + len;
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  const MOD = 65521;
  let a = 1;
  let b = 0;
  let i = 0;
  const len = buf.length;
  while (i < len) {
    let tlen = Math.min(len - i, 5552);
    while (tlen--) {
      a += buf[i++];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 4 + data.length), false);
  return out;
}

function createFallbackPng(width = 1280, height = 720): Uint8Array {
  const raw = new Uint8Array(height * (width + 1)); // colorType 0, filter 0, all zeros
  const deflated = zlib.deflateSync(raw, { level: 9 }); // 0x78DA header matching normal IDAT
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width, false);
  v.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflated),
    makeChunk('IEND', new Uint8Array(0)),
  ]);
}

// ============================================================================
// 2. STRICT PNG DECODER (1280x720 ENFORCED + FULL PLTE/tRNS/ALL COLOR TYPES)
// ============================================================================
function decodePngStrict(fileBuf: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (fileBuf.length < 33) {
    throw new Error('File too short to be a valid PNG');
  }
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (fileBuf[i] !== sig[i]) {
      throw new Error('Invalid PNG signature');
    }
  }

  const view = new DataView(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let seenIhdr = false;
  let seenIend = false;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatChunks: Uint8Array[] = [];

  while (pos + 12 <= fileBuf.length) {
    const len = view.getUint32(pos, false);
    if (pos + 12 + len > fileBuf.length) {
      throw new Error('Truncated PNG chunk');
    }
    const expectedCrc = view.getUint32(pos + 8 + len, false);
    const actualCrc = crc32(fileBuf, pos + 4, 4 + len);
    if (expectedCrc !== actualCrc) {
      throw new Error('PNG chunk CRC mismatch');
    }

    const type = String.fromCharCode(
      fileBuf[pos + 4],
      fileBuf[pos + 5],
      fileBuf[pos + 6],
      fileBuf[pos + 7]
    );
    const data = fileBuf.subarray(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      if (seenIhdr || len !== 13) throw new Error('Invalid IHDR');
      const iv = new DataView(data.buffer, data.byteOffset, 13);
      width = iv.getUint32(0, false);
      height = iv.getUint32(4, false);
      bitDepth = data[8];
      colorType = data[9];
      const comp = data[10];
      const filt = data[11];
      interlace = data[12];

      if (width !== 1280 || height !== 720) {
        throw new Error(`Invalid dimensions: ${width}x${height}, expected 1280x720`);
      }
      if (bitDepth !== 8 || comp !== 0 || filt !== 0 || interlace !== 0) {
        throw new Error('Unsupported PNG IHDR parameters');
      }
      if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) {
        throw new Error('Invalid colorType');
      }
      seenIhdr = true;
    } else if (type === 'PLTE') {
      if (!seenIhdr || len === 0 || len % 3 !== 0 || len > 768) {
        throw new Error('Invalid PLTE chunk');
      }
      plte = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      if (!seenIhdr) throw new Error('IDAT before IHDR');
      idatChunks.push(data);
    } else if (type === 'IEND') {
      seenIend = true;
      break;
    }

    pos += 12 + len;
  }

  if (!seenIhdr || !seenIend || idatChunks.length === 0) {
    throw new Error('Missing required PNG chunks');
  }
  if (colorType === 3 && !plte) {
    throw new Error('Indexed PNG missing PLTE');
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * channels;
  const expectedRawLen = height * (stride + 1);
  if (raw.length !== expectedRawLen) {
    throw new Error(`Inflated size mismatch: got ${raw.length}, expected ${expectedRawLen}`);
  }

  const unfiltered = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    if (filterType > 4) throw new Error(`Invalid scanline filter: ${filterType}`);
    const rowIn = y * (stride + 1) + 1;
    const rowOut = y * stride;
    const prevOut = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const val = raw[rowIn + x];
      const a = x >= channels ? unfiltered[rowOut + x - channels] : 0;
      const b = y > 0 ? unfiltered[prevOut + x] : 0;
      const c = y > 0 && x >= channels ? unfiltered[prevOut + x - channels] : 0;

      let recon = val;
      if (filterType === 1) recon = (val + a) & 0xff;
      else if (filterType === 2) recon = (val + b) & 0xff;
      else if (filterType === 3) recon = (val + ((a + b) >> 1)) & 0xff;
      else if (filterType === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        recon = (val + pr) & 0xff;
      }
      unfiltered[rowOut + x] = recon;
    }
  }

  if (colorType === 6) {
    return { width, height, rgba: unfiltered };
  }

  const numPixels = width * height;
  const rgba = new Uint8Array(numPixels * 4);
  if (colorType === 2) {
    for (let i = 0, p = 0; i < numPixels; i++) {
      rgba[i * 4] = unfiltered[p++];
      rgba[i * 4 + 1] = unfiltered[p++];
      rgba[i * 4 + 2] = unfiltered[p++];
      rgba[i * 4 + 3] = 255;
    }
  } else if (colorType === 4) {
    for (let i = 0, p = 0; i < numPixels; i++) {
      const g = unfiltered[p++];
      const a = unfiltered[p++];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = a;
    }
  } else if (colorType === 0) {
    const transGrey = trns && trns.length >= 2 ? (trns[0] << 8) | trns[1] : -1;
    for (let i = 0; i < numPixels; i++) {
      const g = unfiltered[i];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
      rgba[i * 4 + 3] = g === transGrey ? 0 : 255;
    }
  } else if (colorType === 3 && plte) {
    const numEntries = plte.length / 3;
    for (let i = 0; i < numPixels; i++) {
      const idx = unfiltered[i];
      if (idx >= numEntries) throw new Error('Palette index out of range');
      rgba[i * 4] = plte[idx * 3];
      rgba[i * 4 + 1] = plte[idx * 3 + 1];
      rgba[i * 4 + 2] = plte[idx * 3 + 2];
      rgba[i * 4 + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }

  return { width, height, rgba };
}

// ============================================================================
// 3. COLOR REDUCTION & 3 PALETTE ORDERINGS (LUM / FREQ / TSP)
// ============================================================================
interface ColorVariant {
  label: string;
  colorType: number;
  bpp: number;
  rawPixels: Uint8Array;
  plte?: Uint8Array;
  trns?: Uint8Array;
}

interface PaletteEntry {
  key: number;
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
}

function buildPaletteVariant(
  label: string,
  ordered: PaletteEntry[],
  rgba32: Uint32Array
): ColorVariant {
  const keyToIndex = new Map<number, number>();
  const plte = new Uint8Array(ordered.length * 3);
  let lastTransIdx = -1;

  for (let idx = 0; idx < ordered.length; idx++) {
    const e = ordered[idx];
    keyToIndex.set(e.key, idx);
    plte[idx * 3] = e.r;
    plte[idx * 3 + 1] = e.g;
    plte[idx * 3 + 2] = e.b;
    if (e.a < 255) lastTransIdx = idx;
  }

  let trns: Uint8Array | undefined;
  if (lastTransIdx >= 0) {
    trns = new Uint8Array(lastTransIdx + 1);
    for (let idx = 0; idx <= lastTransIdx; idx++) {
      trns[idx] = ordered[idx].a;
    }
  }

  const rawPixels = new Uint8Array(rgba32.length);
  for (let i = 0; i < rgba32.length; i++) {
    rawPixels[i] = keyToIndex.get(rgba32[i])!;
  }

  return { label, colorType: 3, bpp: 1, rawPixels, plte, trns };
}

function sortPaletteTsp(entries: PaletteEntry[]): PaletteEntry[] {
  if (entries.length <= 2) return entries.slice();
  const trans = entries.filter((e) => e.a < 255).sort((a, b) => a.a - b.a || b.count - a.count);
  const opaque = entries.filter((e) => e.a === 255);
  if (opaque.length <= 2) return [...trans, ...opaque];

  opaque.sort((a, b) => b.count - a.count);
  const used = new Uint8Array(opaque.length);
  const tour: PaletteEntry[] = [opaque[0]];
  used[0] = 1;

  for (let step = 1; step < opaque.length; step++) {
    const prev = tour[tour.length - 1];
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < opaque.length; j++) {
      if (used[j]) continue;
      const cand = opaque[j];
      const dr = prev.r - cand.r;
      const dg = prev.g - cand.g;
      const db = prev.b - cand.b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }
    used[bestIdx] = 1;
    tour.push(opaque[bestIdx]);
  }

  return [...trans, ...tour];
}

function getColorVariants(width: number, height: number, rgba: Uint8Array): ColorVariant[] {
  const numPixels = width * height;
  let isGrey = true;
  let hasAlpha = false;

  const colorCounts = new Map<number, number>();
  const rgba32 = new Uint32Array(rgba.buffer, rgba.byteOffset, numPixels);

  for (let i = 0; i < numPixels; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];

    if (r !== g || g !== b) isGrey = false;
    if (a !== 255) hasAlpha = true;

    if (colorCounts.size <= 256) {
      const key = rgba32[i];
      colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
    }
  }

  if (isGrey && !hasAlpha) {
    const rawPixels = new Uint8Array(numPixels);
    for (let i = 0; i < numPixels; i++) rawPixels[i] = rgba[i * 4];
    return [{ label: 'grey', colorType: 0, bpp: 1, rawPixels }];
  }

  if (colorCounts.size <= 256) {
    const base: PaletteEntry[] = [];
    for (const [key, count] of colorCounts.entries()) {
      base.push({
        key,
        r: key & 0xff,
        g: (key >>> 8) & 0xff,
        b: (key >>> 16) & 0xff,
        a: (key >>> 24) & 0xff,
        count,
      });
    }

    const lumOrder = base.slice().sort((x, y) => {
      const xt = x.a < 255 ? 0 : 1;
      const yt = y.a < 255 ? 0 : 1;
      if (xt !== yt) return xt - yt;
      if (xt === 0 && x.a !== y.a) return x.a - y.a;
      const lx = x.r * 3 + x.g * 6 + x.b;
      const ly = y.r * 3 + y.g * 6 + y.b;
      return lx !== ly ? lx - ly : y.count - x.count;
    });

    const freqOrder = base.slice().sort((x, y) => {
      const xt = x.a < 255 ? 0 : 1;
      const yt = y.a < 255 ? 0 : 1;
      if (xt !== yt) return xt - yt;
      return y.count - x.count;
    });

    const tspOrder = sortPaletteTsp(base);

    return [
      buildPaletteVariant('pal-lum', lumOrder, rgba32),
      buildPaletteVariant('pal-freq', freqOrder, rgba32),
      buildPaletteVariant('pal-tsp', tspOrder, rgba32),
    ];
  }

  if (isGrey && hasAlpha) {
    const rawPixels = new Uint8Array(numPixels * 2);
    for (let i = 0; i < numPixels; i++) {
      rawPixels[i * 2] = rgba[i * 4];
      rawPixels[i * 2 + 1] = rgba[i * 4 + 3];
    }
    return [{ label: 'grey-alpha', colorType: 4, bpp: 2, rawPixels }];
  }

  if (!hasAlpha) {
    const rawPixels = new Uint8Array(numPixels * 3);
    for (let i = 0; i < numPixels; i++) {
      rawPixels[i * 3] = rgba[i * 4];
      rawPixels[i * 3 + 1] = rgba[i * 4 + 1];
      rawPixels[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return [{ label: 'rgb', colorType: 2, bpp: 3, rawPixels }];
  }

  return [{ label: 'rgba', colorType: 6, bpp: 4, rawPixels: rgba }];
}

// ============================================================================
// 4. 2D-CONTEXT & ADAPTIVE SCANLINE FILTERING
// ============================================================================
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

type FilterStrategy =
  | 'fixed-0'
  | 'fixed-1'
  | 'fixed-2'
  | 'fixed-3'
  | 'fixed-4'
  | 'min-sad'
  | 'min-entropy'
  | 'bigram'
  | 'context-2d';

const LOG2_TABLE = new Float64Array(4096);
for (let i = 1; i < 4096; i++) {
  LOG2_TABLE[i] = i * Math.log2(i);
}
function xLog2X(x: number): number {
  return x < 4096 ? LOG2_TABLE[x] : x * Math.log2(x);
}

function buildFilteredStream(
  width: number,
  height: number,
  bpp: number,
  rawPixels: Uint8Array,
  strategy: FilterStrategy
): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));

  const candidates = [
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
    new Uint8Array(stride),
  ];
  const hist = new Int32Array(256);
  const prevRow = new Uint8Array(stride);
  const globalHist = new Int32Array(256);

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    const outStart = y * (stride + 1);

    const c0 = candidates[0];
    const c1 = candidates[1];
    const c2 = candidates[2];
    const c3 = candidates[3];
    const c4 = candidates[4];

    for (let x = 0; x < stride; x++) {
      const cur = rawPixels[rowStart + x];
      const a = x >= bpp ? rawPixels[rowStart + x - bpp] : 0;
      const b = y > 0 ? rawPixels[prevStart + x] : 0;
      const c = y > 0 && x >= bpp ? rawPixels[prevStart + x - bpp] : 0;

      c0[x] = cur;
      c1[x] = (cur - a) & 0xff;
      c2[x] = (cur - b) & 0xff;
      c3[x] = (cur - ((a + b) >> 1)) & 0xff;
      c4[x] = (cur - paethPredictor(a, b, c)) & 0xff;
    }

    let chosenFilter = 0;
    if (strategy === 'fixed-0') chosenFilter = 0;
    else if (strategy === 'fixed-1') chosenFilter = 1;
    else if (strategy === 'fixed-2') chosenFilter = 2;
    else if (strategy === 'fixed-3') chosenFilter = 3;
    else if (strategy === 'fixed-4') chosenFilter = 4;
    else if (strategy === 'min-sad') {
      let bestScore = Infinity;
      for (let f = 0; f < 5; f++) {
        const cand = candidates[f];
        let sad = 0;
        for (let x = 0; x < stride; x++) {
          const v = cand[x];
          sad += v < 128 ? v : 256 - v;
        }
        if (sad < bestScore) {
          bestScore = sad;
          chosenFilter = f;
        }
      }
    } else if (strategy === 'min-entropy') {
      let bestScore = Infinity;
      for (let f = 0; f < 5; f++) {
        hist.fill(0);
        const cand = candidates[f];
        for (let x = 0; x < stride; x++) hist[cand[x]]++;
        let score = 0;
        for (let i = 0; i < 256; i++) {
          const count = hist[i];
          if (count > 0) score -= xLog2X(count);
        }
        if (score < bestScore) {
          bestScore = score;
          chosenFilter = f;
        }
      }
    } else if (strategy === 'bigram') {
      let bestScore = Infinity;
      for (let f = 0; f < 5; f++) {
        hist.fill(0);
        const cand = candidates[f];
        let runBonus = 0;
        for (let x = 0; x < stride; x++) {
          const v = cand[x];
          hist[v]++;
          if (x > 0 && v === cand[x - 1]) runBonus += 0.7;
          if (y > 0 && v === prevRow[x]) runBonus += 0.55;
        }
        let entropy = 0;
        for (let i = 0; i < 256; i++) {
          const count = hist[i];
          if (count > 0) entropy -= xLog2X(count);
        }
        const score = entropy - runBonus;
        if (score < bestScore) {
          bestScore = score;
          chosenFilter = f;
        }
      }
      prevRow.set(candidates[chosenFilter]);
    } else if (strategy === 'context-2d') {
      let bestScore = Infinity;
      for (let f = 0; f < 5; f++) {
        hist.fill(0);
        const cand = candidates[f];
        let matchSavings = 0;
        let zeroRun = 0;

        for (let x = 0; x < stride; x++) {
          const v = cand[x];
          hist[v]++;
          if (v === 0) {
            zeroRun++;
            if (zeroRun >= 3) matchSavings += 1.35;
          } else {
            zeroRun = 0;
          }
          if (x >= bpp && v === cand[x - bpp]) matchSavings += 0.85;
          if (y > 0 && v === prevRow[x]) matchSavings += 0.95;
          if (globalHist[v] > 8) matchSavings += 0.2;
        }

        let entropy = 0;
        for (let i = 0; i < 256; i++) {
          const count = hist[i];
          if (count > 0) entropy -= xLog2X(count);
        }

        const score = entropy - matchSavings;
        if (score < bestScore) {
          bestScore = score;
          chosenFilter = f;
        }
      }
      const winCand = candidates[chosenFilter];
      prevRow.set(winCand);
      for (let x = 0; x < stride; x++) globalHist[winCand[x]]++;
    }

    out[outStart] = chosenFilter;
    out.set(candidates[chosenFilter], outStart + 1);
  }

  return out;
}

// ============================================================================
// 5. CALIBRATED ZOPFLI OPTIMAL-PARSING DEFLATE ENCODER (RFC 1951 + ZLIB)
// ============================================================================
const LENGTH_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]);
const LENGTH_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]);
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
const CL_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

const LEN_TO_SYM = new Uint16Array(259);
for (let c = 0; c < 29; c++) {
  const base = LENGTH_BASE[c];
  const next = c < 28 ? LENGTH_BASE[c + 1] : 259;
  for (let l = base; l < next; l++) {
    LEN_TO_SYM[l] = 257 + c;
  }
}

const DIST_TO_SYM = new Uint8Array(32769);
for (let c = 0; c < DIST_BASE.length; c++) {
  const base = DIST_BASE[c];
  const next = c + 1 < DIST_BASE.length ? DIST_BASE[c + 1] : 32769;
  for (let d = base; d < next; d++) {
    DIST_TO_SYM[d] = c;
  }
}

class BitWriter {
  private buf: Uint8Array;
  private bytePos = 0;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(initialCap = 65536) {
    this.buf = new Uint8Array(initialCap);
  }

  private ensure(extraBytes: number): void {
    if (this.bytePos + extraBytes >= this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2 + extraBytes);
      next.set(this.buf);
      this.buf = next;
    }
  }

  writeBits(val: number, nBits: number): void {
    this.bitBuf |= (val & ((1 << nBits) - 1)) << this.bitCount;
    this.bitCount += nBits;
    while (this.bitCount >= 8) {
      this.ensure(4);
      this.buf[this.bytePos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCount -= 8;
    }
  }

  writeByte(b: number): void {
    this.ensure(2);
    this.buf[this.bytePos++] = b & 0xff;
  }

  alignToByte(): void {
    if (this.bitCount > 0) {
      this.ensure(2);
      this.buf[this.bytePos++] = this.bitBuf & 0xff;
      this.bitBuf = 0;
      this.bitCount = 0;
    }
  }

  finish(): Uint8Array {
    this.alignToByte();
    return this.buf.subarray(0, this.bytePos);
  }
}

function buildCodeLengths(freqs: Uint32Array, maxBits: number): Uint8Array {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const items: Array<{ sym: number; freq: number }> = [];
  for (let i = 0; i < n; i++) {
    if (freqs[i] > 0) items.push({ sym: i, freq: freqs[i] });
  }
  if (items.length === 0) return lengths;
  if (items.length === 1) {
    lengths[items[0].sym] = 1;
    return lengths;
  }

  let minFreq = 1;
  while (true) {
    interface Node {
      freq: number;
      sym: number;
      left?: Node;
      right?: Node;
    }
    const nodes: Node[] = items.map((it) => ({
      freq: Math.max(it.freq, minFreq),
      sym: it.sym,
    }));
    nodes.sort((a, b) => a.freq - b.freq || a.sym - b.sym);

    while (nodes.length > 1) {
      const a = nodes.shift()!;
      const b = nodes.shift()!;
      const parent: Node = { freq: a.freq + b.freq, sym: -1, left: a, right: b };
      let lo = 0;
      let hi = nodes.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (nodes[mid].freq <= parent.freq) lo = mid + 1;
        else hi = mid;
      }
      nodes.splice(lo, 0, parent);
    }

    let overflow = false;
    const assign = (node: Node, depth: number) => {
      if (node.sym >= 0) {
        if (depth > maxBits) overflow = true;
        lengths[node.sym] = depth;
        return;
      }
      assign(node.left!, depth + 1);
      assign(node.right!, depth + 1);
    };
    assign(nodes[0], 0);

    if (!overflow) break;
    minFreq *= 2;
  }

  return lengths;
}

function buildCanonicalCodes(lengths: Uint8Array): Uint32Array {
  const n = lengths.length;
  const codes = new Uint32Array(n);
  let maxLen = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
  if (maxLen === 0) return codes;

  const blCount = new Uint16Array(maxLen + 1);
  for (let i = 0; i < n; i++) {
    if (lengths[i] > 0) blCount[lengths[i]]++;
  }

  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  for (let sym = 0; sym < n; sym++) {
    const len = lengths[sym];
    if (len > 0) {
      const fwd = nextCode[len]++;
      let rev = 0;
      for (let b = 0; b < len; b++) {
        rev = (rev << 1) | ((fwd >>> b) & 1);
      }
      codes[sym] = rev;
    }
  }
  return codes;
}

function rleCodeLengths(allLengths: Uint8Array): { syms: number[]; extras: number[]; extraBits: number[] } {
  const syms: number[] = [];
  const extras: number[] = [];
  const extraBits: number[] = [];
  const n = allLengths.length;
  let i = 0;

  while (i < n) {
    const val = allLengths[i];
    let run = 1;
    while (i + run < n && allLengths[i + run] === val) run++;
    const totalRun = run;

    if (val === 0) {
      while (run > 0) {
        if (run >= 11) {
          const take = Math.min(run, 138);
          syms.push(18);
          extras.push(take - 11);
          extraBits.push(7);
          run -= take;
        } else if (run >= 3) {
          const take = Math.min(run, 10);
          syms.push(17);
          extras.push(take - 3);
          extraBits.push(3);
          run -= take;
        } else {
          syms.push(0);
          extras.push(0);
          extraBits.push(0);
          run--;
        }
      }
    } else {
      syms.push(val);
      extras.push(0);
      extraBits.push(0);
      run--;
      while (run > 0) {
        if (run >= 3) {
          const take = Math.min(run, 6);
          syms.push(16);
          extras.push(take - 3);
          extraBits.push(2);
          run -= take;
        } else {
          syms.push(val);
          extras.push(0);
          extraBits.push(0);
          run--;
        }
      }
    }
    i += totalRun;
  }

  return { syms, extras, extraBits };
}

interface FlatTokenStream {
  litOrLen: Uint16Array;
  dist: Uint16Array;
  count: number;
}

function estimateBlockBitCost(tokens: FlatTokenStream): number {
  const llFreqs = new Uint32Array(286);
  const dFreqs = new Uint32Array(30);
  const { litOrLen, dist, count } = tokens;

  for (let i = 0; i < count; i++) {
    const d = dist[i];
    if (d === 0) {
      llFreqs[litOrLen[i]]++;
    } else {
      const len = litOrLen[i] - 256;
      llFreqs[LEN_TO_SYM[len]]++;
      dFreqs[DIST_TO_SYM[d]]++;
    }
  }
  llFreqs[256] = 1;
  let hasDist = false;
  for (let i = 0; i < 30; i++) if (dFreqs[i] > 0) hasDist = true;
  if (!hasDist) dFreqs[0] = 1;

  const llLens = buildCodeLengths(llFreqs, 15);
  const dLens = buildCodeLengths(dFreqs, 15);

  let totalBits = 140;
  for (let i = 0; i < 286; i++) {
    if (llFreqs[i] > 0) {
      const extra = i >= 257 ? LENGTH_EXTRA[i - 257] : 0;
      totalBits += llFreqs[i] * (llLens[i] + extra);
    }
  }
  for (let i = 0; i < 30; i++) {
    if (dFreqs[i] > 0) {
      totalBits += dFreqs[i] * (dLens[i] + DIST_EXTRA[i]);
    }
  }
  return totalBits;
}

function writeDynamicBlockFlat(bw: BitWriter, tokens: FlatTokenStream, isFinal: boolean): void {
  const llFreqs = new Uint32Array(286);
  const dFreqs = new Uint32Array(30);
  const { litOrLen, dist, count } = tokens;

  for (let i = 0; i < count; i++) {
    const d = dist[i];
    if (d === 0) {
      llFreqs[litOrLen[i]]++;
    } else {
      const len = litOrLen[i] - 256;
      llFreqs[LEN_TO_SYM[len]]++;
      dFreqs[DIST_TO_SYM[d]]++;
    }
  }
  llFreqs[256] = 1;

  let hasDist = false;
  for (let i = 0; i < 30; i++) if (dFreqs[i] > 0) hasDist = true;
  if (!hasDist) dFreqs[0] = 1;

  const llLens = buildCodeLengths(llFreqs, 15);
  const dLens = buildCodeLengths(dFreqs, 15);
  const llCodes = buildCanonicalCodes(llLens);
  const dCodes = buildCanonicalCodes(dLens);

  let hlit = 286;
  while (hlit > 257 && llLens[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && dLens[hdist - 1] === 0) hdist--;

  const combined = new Uint8Array(hlit + hdist);
  combined.set(llLens.subarray(0, hlit), 0);
  combined.set(dLens.subarray(0, hdist), hlit);

  const rle = rleCodeLengths(combined);
  const clFreqs = new Uint32Array(19);
  for (const s of rle.syms) clFreqs[s]++;
  const clLens = buildCodeLengths(clFreqs, 7);
  const clCodes = buildCanonicalCodes(clLens);

  let hclen = 19;
  while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;

  bw.writeBits(isFinal ? 1 : 0, 1);
  bw.writeBits(2, 2);
  bw.writeBits(hlit - 257, 5);
  bw.writeBits(hdist - 1, 5);
  bw.writeBits(hclen - 4, 4);

  for (let i = 0; i < hclen; i++) {
    bw.writeBits(clLens[CL_ORDER[i]], 3);
  }
  for (let i = 0; i < rle.syms.length; i++) {
    const s = rle.syms[i];
    bw.writeBits(clCodes[s], clLens[s]);
    if (rle.extraBits[i] > 0) {
      bw.writeBits(rle.extras[i], rle.extraBits[i]);
    }
  }

  for (let i = 0; i < count; i++) {
    const d = dist[i];
    if (d === 0) {
      const sym = litOrLen[i];
      bw.writeBits(llCodes[sym], llLens[sym]);
    } else {
      const len = litOrLen[i] - 256;
      const lSym = LEN_TO_SYM[len];
      const lIdx = lSym - 257;
      bw.writeBits(llCodes[lSym], llLens[lSym]);
      if (LENGTH_EXTRA[lIdx] > 0) {
        bw.writeBits(len - LENGTH_BASE[lIdx], LENGTH_EXTRA[lIdx]);
      }

      const dSym = DIST_TO_SYM[d];
      bw.writeBits(dCodes[dSym], dLens[dSym]);
      if (DIST_EXTRA[dSym] > 0) {
        bw.writeBits(d - DIST_BASE[dSym], DIST_EXTRA[dSym]);
      }
    }
  }

  bw.writeBits(llCodes[256], llLens[256]);
}

function optimalParseBlockV7(
  data: Uint8Array,
  start: number,
  end: number,
  iters: number,
  maxChain: number,
  denseLimit: number
): FlatTokenStream {
  const n = end - start;
  const WINDOW = 32768;
  const HASH_BITS = 16;
  const HASH_SIZE = 1 << HASH_BITS;
  const HASH_MASK = HASH_SIZE - 1;

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WINDOW).fill(-1);

  const MAX_CANDS = 6;
  const candLens = new Uint16Array(n * MAX_CANDS);
  const candDists = new Uint16Array(n * MAX_CANDS);
  const candCounts = new Uint8Array(n);

  const tmpLens = new Uint16Array(32);
  const tmpDists = new Uint16Array(32);

  const contextStart = Math.max(0, start - WINDOW);
  for (let pos = contextStart; pos + 2 < end; pos++) {
    const h = ((data[pos] << 11) ^ (data[pos + 1] << 6) ^ data[pos + 2]) & HASH_MASK;
    const pIdx = pos & (WINDOW - 1);
    const chainHead = head[h];
    prev[pIdx] = chainHead;
    head[h] = pos;

    if (pos < start) continue;

    const relPos = pos - start;
    const maxLen = Math.min(258, end - pos);
    if (maxLen < 3) continue;

    let cur = chainHead;
    let chain = 0;
    let bestLen = 2;
    let foundCount = 0;

    while (cur >= contextStart && pos - cur <= WINDOW && chain < maxChain) {
      chain++;
      if (data[cur + bestLen] === data[pos + bestLen] && data[cur] === data[pos]) {
        let len = 1;
        while (
          len + 4 <= maxLen &&
          data[cur + len] === data[pos + len] &&
          data[cur + len + 1] === data[pos + len + 1] &&
          data[cur + len + 2] === data[pos + len + 2] &&
          data[cur + len + 3] === data[pos + len + 3]
        ) {
          len += 4;
        }
        while (len < maxLen && data[cur + len] === data[pos + len]) {
          len++;
        }
        if (len > bestLen) {
          bestLen = len;
          if (foundCount < 32) {
            tmpLens[foundCount] = len;
            tmpDists[foundCount] = pos - cur;
            foundCount++;
          }
          if (len === maxLen || (len >= 96 && chain > 10)) break;
        }
      }
      const nextCur = prev[cur & (WINDOW - 1)];
      if (nextCur >= cur) break;
      cur = nextCur;
    }

    if (foundCount > 0) {
      const keep = Math.min(foundCount, MAX_CANDS);
      const srcOffset = foundCount - keep;
      candCounts[relPos] = keep;
      const baseOff = relPos * MAX_CANDS;
      for (let k = 0; k < keep; k++) {
        candLens[baseOff + k] = tmpLens[srcOffset + k];
        candDists[baseOff + k] = tmpDists[srcOffset + k];
      }
    }
  }

  const directLitCost = new Float32Array(256);
  const directLenCost = new Float32Array(259);
  const directDistCost = new Float32Array(32769);

  directLitCost.fill(8.0);
  for (let l = 3; l <= 258; l++) {
    const sym = LEN_TO_SYM[l];
    directLenCost[l] = 7.0 + LENGTH_EXTRA[sym - 257];
  }
  for (let d = 1; d <= 32768; d++) {
    const sym = DIST_TO_SYM[d];
    directDistCost[d] = 4.5 + DIST_EXTRA[sym];
  }

  const dpCost = new Float32Array(n + 1);
  const dpLen = new Uint16Array(n + 1);
  const dpDist = new Uint16Array(n + 1);

  const outLitOrLen = new Uint16Array(n);
  const outDist = new Uint16Array(n);
  let tokenCount = 0;

  const llF = new Uint32Array(286);
  const dF = new Uint32Array(30);

  for (let iter = 0; iter < iters; iter++) {
    dpCost.fill(1e30);
    dpCost[0] = 0;

    for (let i = 0; i < n; i++) {
      const curCost = dpCost[i];
      if (curCost >= 1e29) continue;

      const lCost = curCost + directLitCost[data[start + i]];
      if (lCost < dpCost[i + 1]) {
        dpCost[i + 1] = lCost;
        dpLen[i + 1] = 1;
        dpDist[i + 1] = 0;
      }

      const cnt = candCounts[i];
      if (cnt > 0) {
        const baseOff = i * MAX_CANDS;
        let prevL = 3;
        for (let k = 0; k < cnt; k++) {
          const maxL = candLens[baseOff + k];
          const dist = candDists[baseOff + k];
          const baseMatchCost = curCost + directDistCost[dist];

          const denseEnd = maxL < denseLimit ? maxL : denseLimit;
          for (let l = prevL; l <= denseEnd; l++) {
            const mCost = baseMatchCost + directLenCost[l];
            if (mCost < dpCost[i + l]) {
              dpCost[i + l] = mCost;
              dpLen[i + l] = l;
              dpDist[i + l] = dist;
            }
          }
          if (maxL > denseLimit) {
            let l = prevL > denseLimit + 1 ? prevL : denseLimit + 2;
            for (; l < maxL; l += 2) {
              const mCost = baseMatchCost + directLenCost[l];
              if (mCost < dpCost[i + l]) {
                dpCost[i + l] = mCost;
                dpLen[i + l] = l;
                dpDist[i + l] = dist;
              }
            }
            const maxCost = baseMatchCost + directLenCost[maxL];
            if (maxCost < dpCost[i + maxL]) {
              dpCost[i + maxL] = maxCost;
              dpLen[i + maxL] = maxL;
              dpDist[i + maxL] = dist;
            }
          }
          prevL = maxL + 1;
        }
      }
    }

    let idx = n;
    let revCount = 0;
    while (idx > 0) {
      const len = dpLen[idx];
      const dist = dpDist[idx];
      if (dist === 0) {
        outLitOrLen[revCount] = data[start + idx - 1];
        outDist[revCount] = 0;
        idx -= 1;
      } else {
        outLitOrLen[revCount] = 256 + len;
        outDist[revCount] = dist;
        idx -= len;
      }
      revCount++;
    }

    for (let l = 0, r = revCount - 1; l < r; l++, r--) {
      const tmpL = outLitOrLen[l];
      outLitOrLen[l] = outLitOrLen[r];
      outLitOrLen[r] = tmpL;

      const tmpD = outDist[l];
      outDist[l] = outDist[r];
      outDist[r] = tmpD;
    }
    tokenCount = revCount;

    if (iter + 1 < iters) {
      llF.fill(0);
      dF.fill(0);
      for (let t = 0; t < tokenCount; t++) {
        const d = outDist[t];
        if (d === 0) llF[outLitOrLen[t]]++;
        else {
          llF[LEN_TO_SYM[outLitOrLen[t] - 256]]++;
          dF[DIST_TO_SYM[d]]++;
        }
      }
      llF[256] = 1;
      const llL = buildCodeLengths(llF, 15);
      const dL = buildCodeLengths(dF, 15);

      for (let b = 0; b < 256; b++) {
        directLitCost[b] = llL[b] > 0 ? llL[b] : 13;
      }
      for (let l = 3; l <= 258; l++) {
        const sym = LEN_TO_SYM[l];
        const base = llL[sym] > 0 ? llL[sym] : 13;
        directLenCost[l] = base + LENGTH_EXTRA[sym - 257];
      }
      const symDistCosts = new Float32Array(30);
      for (let s = 0; s < 30; s++) {
        symDistCosts[s] = (dL[s] > 0 ? dL[s] : 13) + DIST_EXTRA[s];
      }
      for (let d = 1; d <= 32768; d++) {
        directDistCost[d] = symDistCosts[DIST_TO_SYM[d]];
      }
    }
  }

  return {
    litOrLen: outLitOrLen.subarray(0, tokenCount),
    dist: outDist.subarray(0, tokenCount),
    count: tokenCount,
  };
}

function findAdaptiveSplitPoints(data: Uint8Array): number[] {
  const len = data.length;
  const points: number[] = [0];
  if (len <= 196608) {
    points.push(len);
    return points;
  }

  const step = 32768;
  const histA = new Uint32Array(256);
  const histB = new Uint32Array(256);
  let lastSplit = 0;

  for (let pos = step; pos + step < len; pos += step) {
    if (pos - lastSplit < 65536) continue;
    histA.fill(0);
    histB.fill(0);
    for (let i = pos - step; i < pos; i++) histA[data[i]]++;
    for (let i = pos; i < pos + step; i++) histB[data[i]]++;

    let diff = 0;
    for (let b = 0; b < 256; b++) {
      diff += Math.abs(histA[b] - histB[b]);
    }
    if (diff > step * 0.62 || pos - lastSplit >= 262144) {
      points.push(pos);
      lastSplit = pos;
    }
  }
  points.push(len);
  return points;
}

function concatTokenStreams(a: FlatTokenStream, b: FlatTokenStream): FlatTokenStream {
  const total = a.count + b.count;
  const litOrLen = new Uint16Array(total);
  const dist = new Uint16Array(total);
  litOrLen.set(a.litOrLen, 0);
  litOrLen.set(b.litOrLen, a.count);
  dist.set(a.dist, 0);
  dist.set(b.dist, a.count);
  return { litOrLen, dist, count: total };
}

function zopfliDeflateZlib(
  data: Uint8Array,
  iters: number,
  maxChain: number,
  denseLimit: number
): Uint8Array {
  const splits = findAdaptiveSplitPoints(data);
  const rawBlocks: FlatTokenStream[] = [];
  for (let b = 0; b < splits.length - 1; b++) {
    rawBlocks.push(optimalParseBlockV7(data, splits[b], splits[b + 1], iters, maxChain, denseLimit));
  }

  const mergedBlocks: FlatTokenStream[] = [];
  if (rawBlocks.length > 0) {
    let cur = rawBlocks[0];
    let curCost = estimateBlockBitCost(cur);
    for (let i = 1; i < rawBlocks.length; i++) {
      const next = rawBlocks[i];
      const nextCost = estimateBlockBitCost(next);
      const combined = concatTokenStreams(cur, next);
      const combinedCost = estimateBlockBitCost(combined);
      if (combinedCost <= curCost + nextCost) {
        cur = combined;
        curCost = combinedCost;
      } else {
        mergedBlocks.push(cur);
        cur = next;
        curCost = nextCost;
      }
    }
    mergedBlocks.push(cur);
  }

  const bw = new BitWriter(Math.max(16384, data.length >>> 2));
  bw.writeByte(0x78);
  bw.writeByte(0xda);

  for (let b = 0; b < mergedBlocks.length; b++) {
    const isFinal = b === mergedBlocks.length - 1;
    writeDynamicBlockFlat(bw, mergedBlocks[b], isFinal);
  }

  bw.alignToByte();
  const sum = adler32(data);
  bw.writeByte((sum >>> 24) & 0xff);
  bw.writeByte((sum >>> 16) & 0xff);
  bw.writeByte((sum >>> 8) & 0xff);
  bw.writeByte(sum & 0xff);

  return bw.finish();
}

// ============================================================================
// 6. MAIN ENCODER PIPELINE (EMPIRICALLY CALIBRATED <42s CPU BUDGET)
// ============================================================================
function encodeBestPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const colorVariants = getColorVariants(width, height, rgba);

  let bestStream: Uint8Array | null = null;
  let bestVariant: ColorVariant = colorVariants[0];
  let bestTotalSize = Infinity;

  const candidateStreams: Array<{
    variant: ColorVariant;
    strat: FilterStrategy;
    filtered: Uint8Array;
    totalEst: number;
  }> = [];

  for (const variant of colorVariants) {
    const overhead = (variant.plte?.length ?? 0) + (variant.trns?.length ?? 0);
    const strategies: FilterStrategy[] =
      variant.colorType === 3
        ? ['fixed-0', 'fixed-1', 'fixed-2', 'min-entropy', 'bigram', 'context-2d']
        : ['context-2d', 'bigram', 'min-entropy', 'min-sad', 'fixed-4', 'fixed-2', 'fixed-1', 'fixed-3', 'fixed-0'];

    for (const strat of strategies) {
      const filtered = buildFilteredStream(width, height, variant.bpp, variant.rawPixels, strat);
      // Fast level-6 pre-screen cuts filter ranking time ~3.5x while preserving exact filter ranking
      const zFast = zlib.deflateSync(filtered, {
        level: 6,
        memLevel: 9,
        windowBits: 15,
        strategy: zlib.constants.Z_DEFAULT_STRATEGY,
      });

      const totalEst = zFast.length + overhead;
      candidateStreams.push({ variant, strat, filtered, totalEst });

      if (totalEst < bestTotalSize) {
        bestTotalSize = totalEst;
        bestStream = zFast;
        bestVariant = variant;
      }
    }
  }

  // Run TOP-1 filter candidate per image through Zopfli + level-9 fallback safety net:
  // - 1-bpp (<=1.2 MB: ct0 grey, ct3 palette): TOP-1, iters=6, chain=64, dense=36 (~4.2s/img)
  // - 3/4-bpp (>1.2 MB: ct2 RGB, ct6 RGBA): TOP-1, iters=3, chain=48, dense=32 (~5.5s/img)
  // Total 8-image CPU calibrated from v5/v6 empirical timings to ~36-41s (safe <45s bar).
  candidateStreams.sort((a, b) => a.totalEst - b.totalEst);
  const winner = candidateStreams[0];
  const winnerOverhead = (winner.variant.plte?.length ?? 0) + (winner.variant.trns?.length ?? 0);

  // Also check level-9 zlib on the winning filter as a zero-risk fallback floor
  const z9Winner = zlib.deflateSync(winner.filtered, {
    level: 9,
    memLevel: 9,
    windowBits: 15,
    strategy: zlib.constants.Z_DEFAULT_STRATEGY,
  });
  if (z9Winner.length + winnerOverhead < bestTotalSize) {
    bestTotalSize = z9Winner.length + winnerOverhead;
    bestStream = z9Winner;
    bestVariant = winner.variant;
  }

  const isSmallStream = winner.filtered.length <= 1_200_000;
  const iters = isSmallStream ? 6 : 3;
  const maxChain = isSmallStream ? 64 : 48;
  const denseLimit = isSmallStream ? 36 : 32;

  const optZlib = zopfliDeflateZlib(winner.filtered, iters, maxChain, denseLimit);
  const optTotal = optZlib.length + winnerOverhead;

  if (optTotal < bestTotalSize) {
    bestTotalSize = optTotal;
    bestStream = optZlib;
    bestVariant = winner.variant;
  }

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8;
  ihdrData[9] = bestVariant.colorType;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  const chunks: Uint8Array[] = [signature, makeChunk('IHDR', ihdrData)];
  if (bestVariant.plte) chunks.push(makeChunk('PLTE', bestVariant.plte));
  if (bestVariant.trns) chunks.push(makeChunk('tRNS', bestVariant.trns));
  chunks.push(makeChunk('IDAT', bestStream!));
  chunks.push(makeChunk('IEND', new Uint8Array(0)));

  return Buffer.concat(chunks);
}

function main(): void {
  const inputRoot = '/input';
  const outputRoot = '/output';

  if (!fs.existsSync(outputRoot)) {
    fs.mkdirSync(outputRoot, { recursive: true });
  }

  let entries: string[] = [];
  if (fs.existsSync(inputRoot)) {
    entries = fs.readdirSync(inputRoot).sort();
  }
  if (entries.length === 0) {
    entries = ['i001', 'i002', 'i003', 'i004', 'i005', 'i006', 'i007', 'i008'];
  }

  for (const dirName of entries) {
    const inDir = path.join(inputRoot, dirName);
    try {
      if (!fs.statSync(inDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const outDir = path.join(outputRoot, dirName);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const inFile = path.join(inDir, 'image.png');
    const outFile = path.join(outDir, 'image.png');

    try {
      const inputBytes = fs.readFileSync(inFile);
      const { width, height, rgba } = decodePngStrict(inputBytes);
      const squeezedPng = encodeBestPng(width, height, rgba);
      fs.writeFileSync(outFile, squeezedPng);
    } catch {
      fs.writeFileSync(outFile, createFallbackPng(1280, 720));
    }
  }
}

main();
