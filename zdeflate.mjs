// zdeflate.mjs — zopfli-style DEFLATE encoder, pure JS, deterministic.
// No clock, no randomness, no environment reads: same input bytes give the
// same output bytes.
//
// Pipeline:
//   1. hash-chain match finder, keeping (length, smallest distance) pairs
//      per position in a pool;
//   2. cost-based optimal parsing (forward shortest-path DP), iterated
//      against an entropy cost model built from the current parse;
//   3. block splitting by bottom-up agglomerative merging of symbol
//      segments (merge neighbours while it saves bits);
//   4. exact package-merge length-limited Huffman codes, with the
//      code-length header tried in 8 RLE variants and the cheapest kept.
// zdeflate(data, { iters, chain }) returns a complete zlib stream.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const FULL = 48;
const NH = 316; // histogram: 0..285 lit/len, 286..315 dist

// Length symbol (0..28) for every match length 3..258.
const lenSym = new Uint8Array(259);
for (let i = 0; i < 29; i++) {
  const end = i === 28 ? 259 : i === 27 ? 258 : LEN_BASE[i + 1];
  for (let l = LEN_BASE[i]; l < end; l++) lenSym[l] = i;
}
lenSym[258] = 28;
// Distance symbol (0..29) for every distance 1..32768.
const distSym = new Uint8Array(32769);
for (let i = 0; i < 30; i++) {
  const end = i === 29 ? 32769 : DIST_BASE[i + 1];
  for (let d = DIST_BASE[i]; d < end; d++) distSym[d] = i;
}
const FIXED_LIT = new Uint8Array(286);
for (let i = 0; i < 286; i++) FIXED_LIT[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_DIST = new Uint8Array(30).fill(5);

// ---------- Length-limited Huffman (package-merge) ----------
// Returns one code length per symbol, each at most maxLen, optimal for the
// given frequencies. With a single used symbol, forceTwo adds a second
// length-1 code so the table is complete (Kraft sum 1).
function lengthLimited(freq, maxLen, forceTwo) {
  const n = freq.length;
  const lens = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lens;
  if (syms.length === 1) {
    lens[syms[0]] = 1;
    if (forceTwo) lens[syms[0] === 0 ? 1 : 0] = 1;
    return lens;
  }
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  const leaves = syms.map((s) => ({ w: freq[s], s, a: null, b: null }));
  let cur = leaves;
  for (let lvl = 1; lvl < maxLen; lvl++) {
    const pk = [];
    for (let i = 0; i + 1 < cur.length; i += 2) {
      pk.push({ w: cur[i].w + cur[i + 1].w, s: -1, a: cur[i], b: cur[i + 1] });
    }
    const m = [];
    let i = 0;
    let j = 0;
    while (i < leaves.length || j < pk.length) {
      if (j >= pk.length || (i < leaves.length && leaves[i].w <= pk[j].w)) m.push(leaves[i++]);
      else m.push(pk[j++]);
    }
    cur = m;
  }
  // Each leaf's code length is how many times it occurs in the first
  // 2n-2 entries of the final packaged list.
  const stack = [];
  for (let k = 0; k < 2 * syms.length - 2; k++) stack.push(cur[k]);
  while (stack.length) {
    const x = stack.pop();
    if (x.s >= 0) lens[x.s]++;
    else stack.push(x.a, x.b);
  }
  return lens;
}

// Canonical Huffman codes for `lens`, returned bit-reversed so they can be
// written LSB-first into the bit stream.
function makeCodes(lens) {
  const n = lens.length;
  const bl = new Int32Array(16);
  const next = new Int32Array(16);
  for (let i = 0; i < n; i++) bl[lens[i]]++;
  bl[0] = 0;
  let code = 0;
  for (let b = 1; b < 16; b++) {
    code = (code + bl[b - 1]) << 1;
    next[b] = code;
  }
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const l = lens[i];
    if (!l) continue;
    const c = next[l]++;
    let r = 0;
    for (let k = 0; k < l; k++) r = (r << 1) | ((c >> k) & 1);
    codes[i] = r;
  }
  return codes;
}

// ---------- Code-length header ----------
// RLE-encode a code-length sequence into (symbol, extra value, extra bits)
// triples. u16/u17/u18 switch the repeat codes 16/17/18 on or off; the
// caller tries all 8 combinations and keeps the cheapest header.
function rleOps(seq, u16, u17, u18) {
  const ops = [];
  const n = seq.length;
  let i = 0;
  while (i < n) {
    const v = seq[i];
    let run = 1;
    while (i + run < n && seq[i + run] === v) run++;
    i += run;
    let r = run;
    if (v === 0) {
      while (r >= 3 && (u17 || u18)) {
        if (u18 && r >= 11) {
          const k = Math.min(r, 138);
          ops.push(18, k - 11, 7);
          r -= k;
        } else if (u17) {
          const k = Math.min(r, 10);
          ops.push(17, k - 3, 3);
          r -= k;
        } else break;
      }
      while (r-- > 0) ops.push(0, 0, 0);
    } else {
      ops.push(v, 0, 0);
      r--;
      if (u16) {
        while (r >= 3) {
          const k = Math.min(r, 6);
          ops.push(16, k - 3, 2);
          r -= k;
        }
      }
      while (r-- > 0) ops.push(v, 0, 0);
    }
  }
  return ops;
}

// Cost (in bits) and tables for one block with histogram `hist`:
// dynamic Huffman against fixed Huffman, the cheaper wins.
function planBlock(hist) {
  const lf = new Int32Array(286);
  for (let i = 0; i < 286; i++) lf[i] = hist[i];
  lf[256]++; // end-of-block
  const df = hist.subarray(286, NH);
  const litLens = lengthLimited(lf, 15, false);
  const distLens = lengthLimited(df, 15, false);
  let anyD = false;
  for (let i = 0; i < 30; i++) {
    if (distLens[i]) {
      anyD = true;
      break;
    }
  }
  if (!anyD) distLens[0] = 1;
  let dataDyn = 0;
  let dataFix = 0;
  let extra = 0;
  for (let i = 0; i < 286; i++) {
    const f = lf[i];
    if (f) {
      dataDyn += f * litLens[i];
      dataFix += f * FIXED_LIT[i];
      if (i >= 257) extra += f * LEN_EXTRA[i - 257];
    }
  }
  for (let i = 0; i < 30; i++) {
    const f = df[i];
    if (f) {
      dataDyn += f * distLens[i];
      dataFix += f * 5;
      extra += f * DIST_EXTRA[i];
    }
  }
  let hlit = 286;
  while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const seq = new Uint8Array(hlit + hdist);
  seq.set(litLens.subarray(0, hlit), 0);
  seq.set(distLens.subarray(0, hdist), hlit);
  let bestH = null;
  for (let v = 0; v < 8; v++) {
    const ops = rleOps(seq, !!(v & 1), !!(v & 2), !!(v & 4));
    const cf = new Int32Array(19);
    let ex = 0;
    for (let k = 0; k < ops.length; k += 3) {
      cf[ops[k]]++;
      ex += ops[k + 2];
    }
    const clLens = lengthLimited(cf, 7, true);
    let hb = ex;
    for (let s = 0; s < 19; s++) hb += cf[s] * clLens[s];
    let hclen = 19;
    while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
    hb += 3 * hclen;
    if (!bestH || hb < bestH.hb) bestH = { hb, ops, clLens, hclen };
  }
  const dynBits = 3 + 14 + bestH.hb + dataDyn + extra;
  const fixBits = 3 + dataFix + extra;
  if (fixBits <= dynBits) {
    return { fixed: true, bits: fixBits, litLens: FIXED_LIT, distLens: FIXED_DIST };
  }
  return {
    fixed: false,
    bits: dynBits,
    litLens,
    distLens,
    hlit,
    hdist,
    hclen: bestH.hclen,
    clLens: bestH.clLens,
    ops: bestH.ops,
  };
}

// ---------- Match finder ----------
// For every position, the pool holds (length, smallest distance) pairs for
// the matches found there, best length last. A match is only recorded when
// it beats the best length seen so far at that position, so the pool stays
// short. Distances are stored minus 1, lengths minus 3, packed in one word.
function buildMatches(data, n, maxChain) {
  const head = new Int32Array(1 << 16).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const offs = new Uint32Array(n + 1);
  let pool = new Uint32Array(Math.max(1 << 16, n));
  let pn = 0;
  for (let i = 0; i < n; i++) {
    offs[i] = pn;
    if (i + 2 < n) {
      const h = Math.imul((data[i] << 16) | (data[i + 1] << 8) | data[i + 2], 2654435761) >>> 16;
      const maxL = Math.min(258, n - i);
      let best = 2;
      let p = head[h];
      let chain = maxChain;
      while (p >= 0 && chain-- > 0) {
        const d = i - p;
        if (d > 32768) break;
        if (data[p + best] === data[i + best]) {
          let l = 0;
          while (l < maxL && data[p + l] === data[i + l]) l++;
          if (l > best) {
            if (pn >= pool.length) {
              const np = new Uint32Array(pool.length * 2);
              np.set(pool);
              pool = np;
            }
            pool[pn++] = ((l - 3) << 15) | (d - 1);
            best = l;
            if (best >= maxL) break;
          }
        }
        p = prev[p];
      }
      prev[i] = head[h];
      head[h] = i;
    }
  }
  offs[n] = pn;
  return { offs, pool };
}

// ---------- Parses ----------
function packParse(sl, sd, count) {
  return { sl, sd, nsym: count };
}

// Greedy: at each position take the longest match in the pool, else a literal.
function greedyParse(data, n, m) {
  const tmpL = new Uint16Array(n);
  const tmpD = new Uint16Array(n);
  let c = 0;
  let i = 0;
  while (i < n) {
    const s = m.offs[i];
    const e = m.offs[i + 1];
    if (s < e) {
      const v = m.pool[e - 1];
      const L = (v >>> 15) + 3;
      tmpL[c] = L;
      tmpD[c] = (v & 32767) + 1;
      c++;
      i += L;
    } else {
      tmpL[c] = data[i];
      tmpD[c] = 0;
      c++;
      i++;
    }
  }
  return packParse(tmpL.slice(0, c), tmpD.slice(0, c), c);
}

// Optimal parsing: forward shortest-path DP over the match pool, with the
// per-block entropy cost tables T. Lengths above FULL are thinned (every
// 4th length plus the pair's end) to keep long-repeat data fast.
function optimalParse(data, n, m, T) {
  const { offs, pool } = m;
  const { nb, bstart, litC, lenC, distC } = T;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const lenOut = new Uint16Array(n + 1);
  const distOut = new Uint16Array(n + 1);
  cost[0] = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    while (b + 1 < nb && i >= bstart[b + 1]) b++;
    const ci = cost[i];
    const lo = b * 256;
    const lno = b * 259;
    const dso = b * 30;
    const cl = ci + litC[lo + data[i]];
    if (cl < cost[i + 1]) {
      cost[i + 1] = cl;
      lenOut[i + 1] = 1;
      distOut[i + 1] = 0;
    }
    const e = offs[i + 1];
    let L = 3;
    for (let k = offs[i]; k < e; k++) {
      const v = pool[k];
      const maxL = (v >>> 15) + 3;
      const d = (v & 32767) + 1;
      const base = ci + distC[dso + distSym[d]];
      for (; L <= maxL; L++) {
        if (L > FULL && maxL - L > 1 && (L & 3) !== 0) {
          L = Math.min(maxL - 1, L | 3);
          continue;
        }
        const c = base + lenC[lno + L];
        if (c < cost[i + L]) {
          cost[i + L] = c;
          lenOut[i + L] = L;
          distOut[i + L] = d;
        }
      }
    }
  }
  let pos = n;
  let cnt = 0;
  while (pos > 0) {
    pos -= lenOut[pos];
    cnt++;
  }
  const sl = new Uint16Array(cnt);
  const sd = new Uint16Array(cnt);
  pos = n;
  for (let k = cnt - 1; k >= 0; k--) {
    const L = lenOut[pos];
    if (L === 1) {
      sl[k] = data[pos - 1];
      sd[k] = 0;
    } else {
      sl[k] = L;
      sd[k] = distOut[pos];
    }
    pos -= L;
  }
  return packParse(sl, sd, cnt);
}

// ---------- Block splitting ----------
// Start from ~500 equal symbol segments, then repeatedly merge the adjacent
// pair whose merge saves the most bits, until no merge saves anything.
function splitBlocks(P) {
  const { sl, sd, nsym } = P;
  const segSyms = Math.max(512, Math.ceil(nsym / 500));
  const nseg = Math.max(1, Math.ceil(nsym / segSyms));
  const hist = [];
  for (let s = 0; s < nseg; s++) {
    const h = new Int32Array(NH);
    const a = s * segSyms;
    const e = Math.min(nsym, a + segSyms);
    for (let i = a; i < e; i++) {
      if (sd[i] === 0) h[sl[i]]++;
      else {
        h[257 + lenSym[sl[i]]]++;
        h[286 + distSym[sd[i]]]++;
      }
    }
    hist.push(h);
  }
  const cost = new Float64Array(nseg);
  const nxt = new Int32Array(nseg);
  const prv = new Int32Array(nseg);
  const delta = new Float64Array(nseg).fill(Infinity);
  const alive = new Uint8Array(nseg).fill(1);
  const startSym = new Int32Array(nseg);
  const tmp = new Int32Array(NH);
  const mergedCost = (x, y) => {
    for (let i = 0; i < NH; i++) tmp[i] = hist[x][i] + hist[y][i];
    return planBlock(tmp).bits;
  };
  for (let b = 0; b < nseg; b++) {
    cost[b] = planBlock(hist[b]).bits;
    nxt[b] = b + 1 < nseg ? b + 1 : -1;
    prv[b] = b - 1;
    startSym[b] = b * segSyms;
  }
  for (let b = 0; b + 1 < nseg; b++) delta[b] = mergedCost(b, b + 1) - cost[b] - cost[b + 1];
  for (;;) {
    let bi = -1;
    let bd = 0;
    for (let b = 0; b < nseg; b++) {
      if (alive[b] && nxt[b] !== -1 && delta[b] < bd) {
        bd = delta[b];
        bi = b;
      }
    }
    if (bi === -1) break;
    const x = nxt[bi];
    for (let i = 0; i < NH; i++) hist[bi][i] += hist[x][i];
    cost[bi] = cost[bi] + cost[x] + bd;
    alive[x] = 0;
    nxt[bi] = nxt[x];
    if (nxt[x] !== -1) prv[nxt[x]] = bi;
    delta[bi] = nxt[bi] !== -1 ? mergedCost(bi, nxt[bi]) - cost[bi] - cost[nxt[bi]] : Infinity;
    const p = prv[bi];
    if (p >= 0 && alive[p]) delta[p] = mergedCost(p, bi) - cost[p] - cost[bi];
  }
  const blocks = [];
  let total = 0;
  for (let b = 0; b < nseg; b++) {
    if (!alive[b]) continue;
    const s = startSym[b];
    blocks.push({ s, e: 0, hist: hist[b] });
    total += cost[b];
  }
  for (let k = 0; k < blocks.length; k++) {
    blocks[k].e = k + 1 < blocks.length ? blocks[k + 1].s : nsym;
  }
  return { blocks, bits: total };
}

// Entropy cost tables for the optimal parser, one set per block: the
// per-symbol bit cost is -log2(freq/total), i.e. the Shannon estimate.
function tablesFor(data, P, blocks) {
  const nb = blocks.length;
  const bstart = new Int32Array(nb);
  const litC = new Float32Array(nb * 256);
  const lenC = new Float32Array(nb * 259);
  const distC = new Float32Array(nb * 30);
  let bytePos = 0;
  let bi = 0;
  for (let i = 0; i < P.nsym; i++) {
    while (bi < nb && blocks[bi].s === i) {
      bstart[bi] = bytePos;
      bi++;
    }
    bytePos += P.sd[i] === 0 ? 1 : P.sl[i];
  }
  for (let b = 0; b < nb; b++) {
    const h = blocks[b].hist;
    let tl = 1;
    for (let i = 0; i < 286; i++) tl += h[i];
    const l2 = Math.log2(tl);
    const lb = (i) => {
      const f = i === 256 ? h[i] + 1 : h[i];
      return f ? Math.log2(tl / f) : l2;
    };
    for (let i = 0; i < 256; i++) litC[b * 256 + i] = lb(i);
    for (let L = 3; L <= 258; L++) {
      const s = lenSym[L];
      lenC[b * 259 + L] = lb(257 + s) + LEN_EXTRA[s];
    }
    let td = 0;
    for (let i = 286; i < NH; i++) td += h[i];
    for (let i = 0; i < 30; i++) {
      const f = h[286 + i];
      distC[b * 30 + i] = (td === 0 ? 5 : f ? Math.log2(td / f) : Math.log2(td)) + DIST_EXTRA[i];
    }
  }
  return { nb, bstart, litC, lenC, distC };
}

// ---------- Bit writer and emission ----------
function adler32(buf) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length;) {
    const e = Math.min(buf.length, i + 5552);
    for (; i < e; i++) {
      a += buf[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Write the parse as a zlib stream: header, one DEFLATE block per split
// block (each ending with its own end-of-block symbol), Adler-32 trailer.
function emit(data, P, blocks) {
  let out = Buffer.alloc(Math.max(1024, (data.length >> 1) + 1024));
  let pos = 0;
  let acc = 0;
  let nacc = 0;
  const put = (v, n) => {
    acc |= v << nacc;
    nacc += n;
    while (nacc >= 8) {
      if (pos >= out.length) {
        const nb = Buffer.alloc(out.length * 2);
        out.copy(nb);
        out = nb;
      }
      out[pos++] = acc & 255;
      acc >>>= 8;
      nacc -= 8;
    }
  };
  out[pos++] = 0x78;
  out[pos++] = 0xda;
  for (let k = 0; k < blocks.length; k++) {
    const B = blocks[k];
    const plan = planBlock(B.hist);
    const last = k === blocks.length - 1;
    put(last ? 1 : 0, 1);
    put(plan.fixed ? 1 : 2, 2);
    const litCodes = makeCodes(plan.litLens);
    const distCodes = makeCodes(plan.distLens);
    if (!plan.fixed) {
      put(plan.hlit - 257, 5);
      put(plan.hdist - 1, 5);
      put(plan.hclen - 4, 4);
      for (let i = 0; i < plan.hclen; i++) put(plan.clLens[CL_ORDER[i]], 3);
      const clCodes = makeCodes(plan.clLens);
      for (let i = 0; i < plan.ops.length; i += 3) {
        const s = plan.ops[i];
        put(clCodes[s], plan.clLens[s]);
        if (plan.ops[i + 2]) put(plan.ops[i + 1], plan.ops[i + 2]);
      }
    }
    for (let i = B.s; i < B.e; i++) {
      if (P.sd[i] === 0) {
        const s = P.sl[i];
        put(litCodes[s], plan.litLens[s]);
      } else {
        const L = P.sl[i];
        const d = P.sd[i];
        const ls = lenSym[L];
        const ds = distSym[d];
        put(litCodes[257 + ls], plan.litLens[257 + ls]);
        if (LEN_EXTRA[ls]) put(L - LEN_BASE[ls], LEN_EXTRA[ls]);
        put(distCodes[ds], plan.distLens[ds]);
        if (DIST_EXTRA[ds]) put(d - DIST_BASE[ds], DIST_EXTRA[ds]);
      }
    }
    put(litCodes[256], plan.litLens[256]);
  }
  if (nacc > 0) put(0, 8 - nacc);
  const ad = adler32(data);
  const res = Buffer.alloc(pos + 4);
  out.copy(res, 0, 0, pos);
  res.writeUInt32BE(ad, pos);
  return res;
}

// ---------- Driver ----------
// Greedy parse first, then `iters` rounds of (split blocks -> optimal parse
// against the split's cost tables), keeping the cheapest split seen.
export function zdeflate(data, opts) {
  const iters = (opts && opts.iters) || 8;
  const chain = (opts && opts.chain) || 48;
  const n = data.length;
  const m = buildMatches(data, n, chain);
  let P = greedyParse(data, n, m);
  let best = null;
  for (let it = 0; it <= iters; it++) {
    const sp = splitBlocks(P);
    if (!best || sp.bits < best.bits) best = { P, blocks: sp.blocks, bits: sp.bits };
    if (it === iters) break;
    P = optimalParse(data, n, m, tablesFor(data, P, sp.blocks));
  }
  return emit(data, best.P, best.blocks);
}
