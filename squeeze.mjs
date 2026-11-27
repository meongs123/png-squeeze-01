// squeeze.mjs — lossless PNG squeezer. Node 22, no dependencies, deterministic.
// Same input bytes give the same output bytes: no clock, no randomness, no
// environment reads anywhere in the pipeline.
//
// Per image: enumerate every lossless colour form (palette / grey / RGB /
// RGBA, plus tRNS-key forms), filter each form five ways plus three
// per-row adaptive strategies, screen every (form, filter) pair with a
// cheap zlib level-3 proxy, re-encode the best few at zlib level 9, then
// run the optimal-parsing DEFLATE in zdeflate.mjs on the best pair. The
// winner must decode back pixel-exact; anything else falls back to plain
// RGBA + Paeth + zlib level 9, and if even that fails the caller (main.ts)
// copies the input through unchanged.

import { deflateSync, inflateSync, constants as zlibConstants } from 'node:zlib';
import { zdeflate } from './zdeflate.mjs';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ---------- CRC-32 and chunk writing ----------
const CRC_T = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_T[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// ---------- Decoder (8-bit, non-interlaced; input and self-verification) ----------
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');
  let pos = 8;
  let w = 0;
  let h = 0;
  let bd = 0;
  let ct = 0;
  let il = 0;
  let plte = null;
  let trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bd = data[8];
      ct = data[9];
      il = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (bd !== 8 || il !== 0) throw new Error('only 8-bit non-interlaced supported');
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const pix = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const rs = y * (stride + 1) + 1;
    const os = y * stride;
    const ps = os - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[rs + i];
      const a = i >= bpp ? pix[os + i - bpp] : 0;
      const b = y ? pix[ps + i] : 0;
      const c = y && i >= bpp ? pix[ps + i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        default: v = x + paeth(a, b, c);
      }
      pix[os + i] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    let r;
    let g;
    let b;
    let a = 255;
    if (ct === 6) {
      r = pix[p * 4];
      g = pix[p * 4 + 1];
      b = pix[p * 4 + 2];
      a = pix[p * 4 + 3];
    } else if (ct === 2) {
      r = pix[p * 3];
      g = pix[p * 3 + 1];
      b = pix[p * 3 + 2];
      if (trns && trns[1] === r && trns[3] === g && trns[5] === b) a = 0;
    } else if (ct === 0) {
      r = g = b = pix[p];
      if (trns && trns[1] === r) a = 0;
    } else if (ct === 4) {
      r = g = b = pix[p * 2];
      a = pix[p * 2 + 1];
    } else {
      const i = pix[p];
      r = plte[i * 3];
      g = plte[i * 3 + 1];
      b = plte[i * 3 + 2];
      if (trns && i < trns.length) a = trns[i];
    }
    rgba[p * 4] = r;
    rgba[p * 4 + 1] = g;
    rgba[p * 4 + 2] = b;
    rgba[p * 4 + 3] = a;
  }
  return { w, h, rgba };
}

// ---------- Filtering ----------
// All five PNG filters over the whole image, one buffer per filter.
function filterAll(data, w, h, bpp) {
  const stride = w * bpp;
  const rl = stride + 1;
  const outs = [];
  for (let f = 0; f < 5; f++) {
    const out = Buffer.alloc(h * rl);
    for (let y = 0; y < h; y++) {
      const rs = y * stride;
      const ps = rs - stride;
      const os = y * rl;
      out[os] = f;
      for (let i = 0; i < stride; i++) {
        const x = data[rs + i];
        const a = i >= bpp ? data[rs + i - bpp] : 0;
        const b = y ? data[ps + i] : 0;
        let v;
        if (f === 0) v = x;
        else if (f === 1) v = x - a;
        else if (f === 2) v = x - b;
        else if (f === 3) v = x - ((a + b) >> 1);
        else v = x - paeth(a, b, y && i >= bpp ? data[ps + i - bpp] : 0);
        out[os + 1 + i] = v & 255;
      }
    }
    outs.push(out);
  }
  return outs;
}

// Per-row, per-filter scores: signed-byte sum, distinct byte count, and
// entropy (bits). The adaptive strategies pick, row by row, the filter
// that minimises one of these.
function rowScores(allF, h, stride) {
  const rl = stride + 1;
  const sum = [];
  const dist = [];
  const ent = [];
  const hist = new Int32Array(256);
  for (let f = 0; f < 5; f++) {
    const s = new Float64Array(h);
    const d = new Float64Array(h);
    const e = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      let sa = 0;
      const o = y * rl + 1;
      for (let i = 0; i < stride; i++) {
        const v = allF[f][o + i];
        hist[v]++;
        sa += v > 127 ? 256 - v : v;
      }
      let dc = 0;
      let en = 0;
      for (let k = 0; k < 256; k++) {
        if (hist[k]) {
          dc++;
          en += hist[k] * Math.log2(stride / hist[k]);
        }
      }
      s[y] = sa;
      d[y] = dc;
      e[y] = en;
    }
    sum.push(s);
    dist.push(d);
    ent.push(e);
  }
  return { sum, dist, ent };
}

// Reassemble one filtered image by picking, per row, the filter whose
// score function is smallest.
function assemble(allF, h, stride, score) {
  const rl = stride + 1;
  const out = Buffer.alloc(h * rl);
  for (let y = 0; y < h; y++) {
    let best = 0;
    let bs = Infinity;
    for (let f = 0; f < 5; f++) {
      const v = score(f, y);
      if (v < bs) {
        bs = v;
        best = f;
      }
    }
    allF[best].copy(out, y * rl, y * rl, y * rl + rl);
  }
  return out;
}

// ---------- Candidate construction ----------
// One scan of the pixels answers every structural question: alpha present,
// all grey, only 0/255 alpha, a single transparent colour, palette size.
function buildCandidates(w, h, rgbaIn) {
  const rgba = new Uint8Array(rgbaIn); // own ArrayBuffer, offset 0
  const n = w * h;
  const u32 = new Uint32Array(rgba.buffer, 0, n);
  let hasAlpha = false;
  let notGray = false;
  let nonBinary = false;
  let multiTrans = false;
  let tooMany = false;
  let tkey = -1;
  const pal = new Map(); // word -> {key,r,g,b,a,count,i}
  for (let p = 0; p < n; p++) {
    const r = rgba[p * 4];
    const g = rgba[p * 4 + 1];
    const b = rgba[p * 4 + 2];
    const a = rgba[p * 4 + 3];
    if (a !== 255) hasAlpha = true;
    if (r !== g || g !== b) notGray = true;
    if (a !== 0 && a !== 255) nonBinary = true;
    if (a === 0) {
      const k = (r << 16) | (g << 8) | b;
      if (tkey === -1) tkey = k;
      else if (tkey !== k) multiTrans = true;
    }
    if (!tooMany) {
      const key = u32[p];
      const e = pal.get(key);
      if (e) e.count++;
      else if (pal.size >= 256) tooMany = true;
      else pal.set(key, { key, r, g, b, a, count: 1, i: pal.size });
    }
  }
  const cands = [];
  const extract = (bpp, fn) => {
    const d = Buffer.alloc(n * bpp);
    for (let p = 0; p < n; p++) fn(d, p * bpp, p * 4);
    return d;
  };
  // RGBA is always valid.
  cands.push({ name: 'rgba', ct: 6, bpp: 4, data: Buffer.from(rgba), plte: null, trns: null });

  const keyColorFree = () => {
    if (hasAlpha && !nonBinary && !multiTrans && tkey !== -1) {
      for (let p = 0; p < n; p++) {
        if (rgba[p * 4 + 3] === 255 && ((rgba[p * 4] << 16) | (rgba[p * 4 + 1] << 8) | rgba[p * 4 + 2]) === tkey) return false;
      }
      return true;
    }
    return false;
  };

  if (!hasAlpha) {
    cands.push({ name: 'rgb', ct: 2, bpp: 3, data: extract(3, (d, o, s) => { d[o] = rgba[s]; d[o + 1] = rgba[s + 1]; d[o + 2] = rgba[s + 2]; }), plte: null, trns: null });
    if (!notGray) cands.push({ name: 'gray', ct: 0, bpp: 1, data: extract(1, (d, o, s) => { d[o] = rgba[s]; }), plte: null, trns: null });
  } else if (keyColorFree()) {
    const r = (tkey >> 16) & 255;
    const g = (tkey >> 8) & 255;
    const b = tkey & 255;
    cands.push({ name: 'rgb+trns', ct: 2, bpp: 3, data: extract(3, (d, o, s) => { d[o] = rgba[s]; d[o + 1] = rgba[s + 1]; d[o + 2] = rgba[s + 2]; }), plte: null, trns: Buffer.from([0, r, 0, g, 0, b]) });
    if (!notGray) cands.push({ name: 'gray+trns', ct: 0, bpp: 1, data: extract(1, (d, o, s) => { d[o] = rgba[s]; }), plte: null, trns: Buffer.from([0, r]) });
  }
  if (hasAlpha && !notGray) {
    cands.push({ name: 'gray+alpha', ct: 4, bpp: 2, data: extract(2, (d, o, s) => { d[o] = rgba[s]; d[o + 1] = rgba[s + 3]; }), plte: null, trns: null });
  }
  if (!tooMany) {
    const ents = [...pal.values()];
    const grp = (e) => (e.a === 255 ? 1 : 0); // non-opaque first => shortest tRNS
    const lum = (e) => 0.299 * e.r + 0.587 * e.g + 0.114 * e.b;
    const orders = {
      first: (x, y) => 0,
      freq: (x, y) => y.count - x.count,
      lum: (x, y) => lum(x) - lum(y),
    };
    for (const [oname, cmp] of Object.entries(orders)) {
      const sorted = ents.slice().sort((x, y) => grp(x) - grp(y) || cmp(x, y) || x.i - y.i);
      const idx = new Map();
      sorted.forEach((e, i) => idx.set(e.key, i));
      const plte = Buffer.alloc(sorted.length * 3);
      sorted.forEach((e, i) => {
        plte[i * 3] = e.r;
        plte[i * 3 + 1] = e.g;
        plte[i * 3 + 2] = e.b;
      });
      let tl = 0;
      sorted.forEach((e, i) => {
        if (e.a !== 255) tl = i + 1;
      });
      const trns = tl ? Buffer.from(sorted.slice(0, tl).map((e) => e.a)) : null;
      const data = Buffer.alloc(n);
      for (let p = 0; p < n; p++) data[p] = idx.get(u32[p]);
      cands.push({ name: 'pal-' + oname, ct: 3, bpp: 1, data, plte, trns });
    }
  }
  return cands;
}

function buildPng(w, h, c, idatData) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = c.ct;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const parts = [SIG, chunk('IHDR', ihdr)];
  if (c.plte) parts.push(chunk('PLTE', c.plte));
  if (c.trns) parts.push(chunk('tRNS', c.trns));
  parts.push(chunk('IDAT', idatData), chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const deflate = (buf, level, strategy) =>
  deflateSync(buf, { level, memLevel: 9, windowBits: 15, strategy });

// ---------- Main per-image optimiser ----------
const TOP_K = 3;
const ZOP_K = 1;
// Effort by data size only (never by wall-clock) so the output stays
// deterministic: big filtered streams get fewer optimal-parsing iterations
// and a shorter match chain.
const effort = (sz) =>
  sz > 2000000 ? { iters: 1, chain: 16 }
  : sz > 800000 ? { iters: 4, chain: 48 }
  : { iters: 8, chain: 96 };

// Plain RGBA + Paeth + zlib level 9, the always-valid fallback.
function fallbackPng(w, h, rgba) {
  const c = { name: 'rgba', ct: 6, bpp: 4, data: Buffer.from(rgba), plte: null, trns: null };
  return buildPng(w, h, c, deflate(filterAll(c.data, w, h, 4)[4], 9, zlibConstants.Z_DEFAULT_STRATEGY));
}

export function squeezePng(w, h, rgba) {
  const cands = buildCandidates(w, h, rgba);
  const trials = [];
  for (const c of cands) {
    const stride = w * c.bpp;
    const allF = filterAll(c.data, w, h, c.bpp);
    const sc = rowScores(allF, h, stride);
    const strategies = [];
    for (let f = 0; f < 5; f++) strategies.push(['fix' + f, allF[f]]);
    strategies.push(['sum', assemble(allF, h, stride, (f, y) => sc.sum[f][y])]);
    strategies.push(['dist', assemble(allF, h, stride, (f, y) => sc.dist[f][y] * 1e7 + sc.sum[f][y])]);
    strategies.push(['ent', assemble(allF, h, stride, (f, y) => sc.ent[f][y])]);
    for (const [sname, buf] of strategies) {
      const proxy = deflate(buf, 3, zlibConstants.Z_DEFAULT_STRATEGY).length
        + (c.plte ? c.plte.length : 0) + (c.trns ? c.trns.length : 0);
      trials.push({ c, sname, buf, proxy });
    }
  }
  trials.sort((a, b) => a.proxy - b.proxy || (a.c.name + a.sname < b.c.name + b.sname ? -1 : 1));
  let best = null;
  const consider = (t, z) => {
    const png = buildPng(w, h, t.c, z);
    if (!best || png.length < best.length) best = png;
  };
  for (const t of trials.slice(0, TOP_K)) {
    for (const strat of [zlibConstants.Z_DEFAULT_STRATEGY, zlibConstants.Z_FILTERED]) {
      consider(t, deflate(t.buf, 9, strat));
    }
  }
  // Optimal-parsing pass on the best pair only; effort depends on data size.
  for (const t of trials.slice(0, ZOP_K)) {
    consider(t, zdeflate(t.buf, effort(t.buf.length)));
  }
  // Self-check: the winner must decode to the exact same RGBA. A corrupt
  // DEFLATE stream throws here instead of returning a mismatch — either
  // way the fallback below runs, so one bad stream can never sink the run.
  try {
    const back = decodePng(best);
    if (back.w !== w || back.h !== h || !back.rgba.equals(Buffer.from(rgba))) {
      throw new Error('pixel mismatch in self-check');
    }
  } catch {
    best = fallbackPng(w, h, rgba);
  }
  return best;
}
