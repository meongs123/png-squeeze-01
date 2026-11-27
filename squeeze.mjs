// squeeze.mjs — PNG re-encoder for png-squeeze-01.
//
// Strategy (three layers, cheapest first):
//   1. Format reduction: palette (type 3) when the image holds at most 256
//      colours, grey (type 0/4) when every pixel is grey, RGB (type 2) when
//      opaque, RGBA (type 6) otherwise; a single fully-transparent value
//      becomes a tRNS key instead of an alpha channel. Colours of fully
//      transparent pixels are preserved exactly — never "cleaned".
//   2. Per-row filter choice with cheap heuristics (fixed filters, minimum
//      signed sum, fewest distinct byte pairs, fewest distinct bytes).
//      Candidates are screened with zlib level 6; the best few are
//      re-encoded with zlib level 9 and the smallest file wins.
//   3. A custom DEFLATE encoder (see deflate.mjs) is tried on the winning
//      filtered stream and kept only when it is strictly smaller.
//
// Everything here is written from scratch for this entry. No clock, no
// randomness, no environment input: the same input always yields the same
// bytes. Only node:zlib / node:fs built-ins are used.

import { deflateSync, inflateSync, constants as zlibConstants } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG container: CRC-32, chunk assembly, IHDR.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const PNG_SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunkBytes(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(type, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdrData(width, height, colourType) {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

/** Assemble a PNG from chunk [type, data] pairs (types as 4-char strings). */
export function assemblePng(chunks) {
  const parts = [PNG_SIG];
  let total = PNG_SIG.length;
  for (const [type, data] of chunks) total += 12 + data.length;
  const out = new Uint8Array(total);
  let at = 0;
  out.set(PNG_SIG, at);
  at += PNG_SIG.length;
  for (const [type, data] of chunks) {
    const bytes = chunkBytes(Uint8Array.from(type, (ch) => ch.charCodeAt(0)), data);
    out.set(bytes, at);
    at += bytes.length;
  }
  return out;
}

/** Full PNG bytes for one form + one zlib stream. */
export function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrData(width, height, form.colourType)]];
  if (form.plte) chunks.push(['PLTE', form.plte]);
  if (form.trns) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return assemblePng(chunks);
}

// ---------------------------------------------------------------------------
// Decoder: any accepted PNG (bit depth 8, non-interlaced) -> RGBA.
// ---------------------------------------------------------------------------

function paethPredict(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('input is not bytes');
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idatParts = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk header');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} CRC mismatch`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (header) throw new Error('duplicate IHDR');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], interlace: data[12] };
      if (header.depth !== 8 || !(header.colourType in CHANNELS) || header.interlace !== 0) {
        throw new Error('unsupported IHDR');
      }
    } else if (type === 'PLTE') {
      if (header.colourType !== 3 || len === 0 || len % 3 !== 0 || len > 768) throw new Error('bad PLTE');
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      if (len !== 0) throw new Error('non-empty IEND');
      ended = true;
    } else {
      throw new Error(`unsupported chunk ${type}`);
    }
  }
  if (!ended || !header || idatParts.length === 0) throw new Error('incomplete PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to wrong length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error(`row ${y} filter ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredict(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns ? (trns[1] << 16) | (trns[3] << 8) | trns[5] : -1;
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns ? trns[1] : -1;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Filters.
// ---------------------------------------------------------------------------

/** Filter one row of `cur` (bpp samples per pixel) against `prev` into out. */
export function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredict(a, b, c);
    }
  }
}

/** Sum of |signed byte| over a filtered row. */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** Count of distinct neighbouring byte pairs in a row (stamp array avoids clearing). */
function pairsCost(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

/** Count of distinct byte values in a row. */
function distinctCost(row, seen, stamp) {
  let n = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i] + 256;
    if (seen[v] !== stamp) {
      seen[v] = stamp;
      n++;
    }
  }
  return n;
}

const FILTER_CHOICES = Object.freeze([0, 1, 2, 3, 4, 'minsum', 'pairs', 'distinct']);

/**
 * Filter every row of `samples` by `choice` into `raw` (allocated when omitted).
 * String choices pick per row: 'minsum' = least signed sum, 'pairs' = fewest
 * distinct byte pairs, 'distinct' = fewest distinct bytes. Lowest type wins ties.
 */
export function filterImage(samples, width, height, bpp, choice, raw = null) {
  const stride = width * bpp;
  if (raw === null) raw = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536 + 512);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trials[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trials[t]);
      else if (choice === 'pairs') cost = pairsCost(trials[t], seen, ++stamp);
      else cost = distinctCost(trials[t], seen, ++stamp);
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trials[type], at + 1);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Analysis + forms.
// ---------------------------------------------------------------------------

/** Scan RGBA once: opaque? all grey? colours (up to 256)? */
export function analyse(rgba) {
  const n = rgba.length >>> 2;
  const words = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, n)
    : new Uint32Array(rgba.slice().buffer, 0, n);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = words[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours = null;
  if (!many) {
    colours = [...counts.keys()].map((word) => {
      const b = new Uint8Array(Uint32Array.of(word).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word, count: counts.get(word) };
    });
  }
  return { opaque, grey, colours };
}

/**
 * The single fully-transparent value usable as a tRNS key, or null: every
 * non-opaque pixel is exactly that value at alpha 0, and no opaque pixel
 * shares the value.
 */
export function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const words = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, n)
    : new Uint32Array(rgba.slice().buffer, 0, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(words[i]);
  return { plte, trns, indices };
}

/** Every lossless form an image can be written in, each with its filter trials. */
export function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns,
        filters: [0, 'minsum', 'pairs'],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  forms.push({
    colourType: ct, bpp: { 0: 1, 2: 3, 4: 2, 6: 4 }[ct],
    samples: samplesOf(rgba, ct), plte: null, trns,
    filters: FILTER_CHOICES,
  });
  return forms;
}

const chunkOverhead = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------------------------------------------------------------------------
// Compression driver.
// ---------------------------------------------------------------------------

const SCREEN_OPTS = { level: 6, memLevel: 8 };

/**
 * Compress one RGBA image to a complete PNG.
 * Screen every (form, filter) at zlib level 6, re-encode the best few at
 * level 9 (plus a Z_FILTERED trial on the winner), keep the smallest file.
 * `deflate` is an optional custom encoder: (raw, stride) => Uint8Array|null.
 * It is used only when its stream is strictly smaller than zlib's.
 */
export function squeezePng(rgba, width, height, deflate = null) {
  const forms = formsOf(rgba);
  // Screen: one deflate per (form, filter) at level 6.
  const screened = [];
  for (const form of forms) {
    const size = height * (width * form.bpp + 1);
    const overhead = chunkOverhead(form);
    for (const choice of form.filters) {
      const data = filterImage(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, SCREEN_OPTS);
      screened.push({ form, choice, data, bytes: z.length + overhead });
    }
  }
  screened.sort((a, b) => a.bytes - b.bytes);
  // Re-encode the best few at level 9. Keep distinct forms among them.
  const finalists = [];
  const seenForms = new Set();
  for (const cand of screened) {
    if (finalists.length >= 3) break;
    if (seenForms.has(cand.form) && finalists.length >= 2) continue;
    seenForms.add(cand.form);
    finalists.push(cand);
  }
  let best = null;
  // Level-9 trials: default and Z_FILTERED strategies at memLevel 8 and 9.
  // memLevel 8 repeatedly beats 9 here (smaller hash window matches better
  // on filtered screenshot data), so both are weighed and the smallest wins.
  const FINAL_TRIALS = [
    { level: 9, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 8, strategy: zlibConstants.Z_FILTERED },
    { level: 9, memLevel: 9, strategy: zlibConstants.Z_DEFAULT_STRATEGY },
    { level: 9, memLevel: 9, strategy: zlibConstants.Z_FILTERED },
  ];
  for (const cand of finalists) {
    const overhead = chunkOverhead(cand.form);
    for (const opts of FINAL_TRIALS) {
      const z = deflateSync(cand.data, opts);
      const total = z.length + overhead;
      if (best === null || total < best.total) best = { form: cand.form, data: cand.data, zlib: z, total };
    }
  }
  // Custom DEFLATE: strictly smaller wins, otherwise zlib stands.
  // `stride` (one filtered row's bytes) seeds the match finder's vertical
  // repeats; it is derived from this image's geometry, never hardcoded.
  if (deflate !== null) {
    let custom = null;
    try {
      custom = deflate(best.data, width * best.form.bpp + 1);
    } catch {
      custom = null;
    }
    if (custom !== null && custom.length + chunkOverhead(best.form) < best.total) {
      best = { form: best.form, data: best.data, zlib: custom, total: custom.length + chunkOverhead(best.form) };
    }
  }
  return pngOfForm(width, height, best.form, best.zlib);
}
