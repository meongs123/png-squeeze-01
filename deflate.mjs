// deflate.mjs — custom DEFLATE encoder for png-squeeze-01 (written from scratch).
//
// Lazy LZ77 matching (hash chains + vertical-repeat seeds for screenshot
// rows, ties broken toward the shorter distance) + dynamic/fixed Huffman
// blocks of 2048/4096 tokens, the smaller kept. Every stream is validated
// by the caller against zlib level 9: the custom stream is used only when
// it is strictly smaller. No clock, no randomness, no environment input:
// fixed chain length and block sizes make the output deterministic.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenCodeOf(len) {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return lo;
}
function distCodeOf(d) {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= d) lo = mid; else hi = mid - 1; }
  return lo;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Huffman lengths via heap tree. A plain Huffman tree can exceed maxBits,
// so when it does, scale the frequencies down (halving, keeping positives
// at >= 1) and rebuild: flatter frequencies give a shallower tree, and
// with all frequencies equal the depth is <= ceil(log2(n)) <= 9 for n <= 286,
// so this always terminates with a valid (Kraft == 1) length-limited tree.
function huffmanLengths(freq, maxBits) {
  const n = freq.length;
  const lens = new Uint8Array(n);
  const active = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) active.push(i);
  if (active.length === 0) return lens;
  if (active.length === 1) { lens[active[0]] = 1; return lens; }
  const scaled = new Int32Array(n);
  for (let shift = 0; ; shift++) {
    for (let i = 0; i < n; i++) scaled[i] = freq[i] > 0 ? Math.max(1, freq[i] >> shift) : 0;
    buildLengths(scaled, lens);
    let maxLen = 0;
    for (const s of active) if (lens[s] > maxLen) maxLen = lens[s];
    if (maxLen <= maxBits) return lens;
  }
}

function buildLengths(freq, lens) {
  const n = freq.length;
  lens.fill(0);
  const f = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) f[i] = freq[i];
  const heap = [];
  const less = (a, b) => f[a] < f[b] || (f[a] === f[b] && a < b);
  const push = (node) => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (less(heap[p], heap[i])) break; const t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        const t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (freq[i] > 0) push(i);
  if (heap.length === 1) { lens[heap[0]] = 1; return; }
  const left = new Int32Array(n * 2);
  const right = new Int32Array(n * 2);
  let next = n;
  while (heap.length > 1) {
    const a = pop(), b = pop();
    f[next] = f[a] + f[b];
    left[next] = a; right[next] = b;
    push(next);
    next++;
  }
  const root = heap[0];
  const stack = [[root, 0]];
  while (stack.length) {
    const [node, d] = stack.pop();
    if (node < n) lens[node] = d;
    else { stack.push([left[node], d + 1]); stack.push([right[node], d + 1]); }
  }
}

function canonicalCodes(lens) {
  const n = lens.length;
  let maxLen = 0;
  for (let i = 0; i < n; i++) if (lens[i] > maxLen) maxLen = lens[i];
  const blCount = new Int32Array(maxLen + 1);
  for (let i = 0; i < n; i++) if (lens[i]) blCount[lens[i]]++;
  const nextCode = new Int32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) if (lens[i]) codes[i] = nextCode[lens[i]]++;
  return codes;
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>>= 1; }
  return r;
}

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.bitBuf = 0; this.bitCnt = 0; }
  grow() { const nb = new Uint8Array(this.buf.length * 2); nb.set(this.buf); this.buf = nb; }
  write(code, len) {
    this.bitBuf |= code << this.bitCnt;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  writeCode(code, len) { this.write(reverseBits(code, len), len); }
  flush() {
    if (this.bitCnt > 0) {
      if (this.pos >= this.buf.length) this.grow();
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf = 0; this.bitCnt = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
  bits() { return this.pos * 8 + this.bitCnt; }
}

// Encode one dynamic-Huffman block from token arrays.
// toks: Int32Array of symbols (0-255 literal, 257-285 length code, 256 end);
// lens: actual match length per token (0 for literals); dists: distance per token.
function emitDynamicBlock(w, toks, lens, dists, litLen, distLen, isFinal) {
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  let hlit = 286, hdist = 30;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const allLens = new Uint8Array(hlit + hdist);
  allLens.set(litLen.subarray(0, hlit), 0);
  allLens.set(distLen.subarray(0, hdist), hlit);
  const clFreq = new Int32Array(19);
  const clSyms = [];
  {
    let i = 0;
    while (i < allLens.length) {
      const v = allLens[i];
      let run = 1;
      while (i + run < allLens.length && allLens[i + run] === v) run++;
      let left = run;
      if (v === 0) {
        while (left >= 11) { const take = Math.min(left, 138); clSyms.push([18, take]); clFreq[18]++; left -= take; }
        if (left >= 3) { clSyms.push([17, left]); clFreq[17]++; left = 0; }
        while (left > 0) { clSyms.push([0, 0]); clFreq[0]++; left--; }
      } else {
        clSyms.push([v, 0]); clFreq[v]++;
        left--;
        while (left >= 3) { const take = Math.min(left, 6); clSyms.push([16, take]); clFreq[16]++; left -= take; }
        while (left > 0) { clSyms.push([v, 0]); clFreq[v]++; left--; }
      }
      i += run;
    }
  }
  const clLen = (() => {
    let cl = huffmanLengths(clFreq, 7);
    let active = 0;
    for (let i = 0; i < 19; i++) if (clFreq[i] > 0) active++;
    if (active < 2) {
      // A one-code Huffman table is incomplete (Kraft 1/2): add a dummy
      // second code so the table is valid. It is never used in the data.
      clFreq[clFreq[0] === 0 ? 0 : 1] = 1;
      cl = huffmanLengths(clFreq, 7);
    }
    return cl;
  })();
  const clCode = canonicalCodes(clLen);
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  w.write(isFinal ? 1 : 0, 1); // BFINAL
  w.write(2, 2); // dynamic
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.write(clLen[CL_ORDER[i]], 3);
  for (const [s, rep] of clSyms) {
    w.writeCode(clCode[s], clLen[s]);
    if (s === 16) w.write(rep - 3, 2);
    else if (s === 17) w.write(rep - 3, 3);
    else if (s === 18) w.write(rep - 11, 7);
  }
  for (let i = 0; i < toks.length; i++) {
    const s = toks[i];
    w.writeCode(litCode[s], litLen[s]);
    if (s >= 257 && s < 286) {
      const lc = s - 257;
      w.write(lens[i] - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCodeOf(dists[i]);
      w.writeCode(distCode[dc], distLen[dc]);
      w.write(dists[i] - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
}

// Fixed Huffman tables (RFC 1951).
const FIXED_LIT_LEN = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();
const FIXED_DIST_LEN = new Uint8Array(30).fill(5);

// One fixed-Huffman block (BTYPE 01) from token arrays.
function emitFixedBlock(w, toks, lens, dists, isFinal) {
  const litCode = canonicalCodes(FIXED_LIT_LEN);
  const distCode = canonicalCodes(FIXED_DIST_LEN);
  w.write(isFinal ? 1 : 0, 1);
  w.write(1, 2); // fixed
  for (let i = 0; i < toks.length; i++) {
    const s = toks[i];
    w.writeCode(litCode[s], FIXED_LIT_LEN[s]);
    if (s >= 257 && s < 286) {
      const lc = s - 257;
      w.write(lens[i] - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = distCodeOf(dists[i]);
      w.writeCode(distCode[dc], 5);
      w.write(dists[i] - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
}

// Encode the whole token stream in blocks of at most `blockTokens` tokens,
// each block written with the smaller of a dynamic or a fixed Huffman table.
// All blocks share one bit writer: DEFLATE blocks are bit-packed back to
// back, so flushing per block would insert padding bits mid-stream.
function encodeBlocks(toks, lens, dists, blockTokens) {
  const main = new BitWriter(Math.max(1024, toks.length * 4));
  for (let start = 0; start < toks.length; start += blockTokens) {
    const end = Math.min(toks.length, start + blockTokens);
    const isFinal = end === toks.length;
    // Every block, final or not, ends with the end-of-block symbol 256:
    // the decoder reads tokens until it sees it. The final block's 256 is
    // already the stream's last token; intermediate blocks need one added.
    let bt = toks.subarray(start, end);
    let bl = lens.slice(start, end);
    let bd = dists.slice(start, end);
    if (!isFinal) {
      const bt2 = new Int32Array(bt.length + 1);
      bt2.set(bt, 0);
      bt2[bt.length] = 256;
      bt = bt2;
      bl = [...bl, 0];
      bd = [...bd, 0];
    }
    const litFreq = new Int32Array(286);
    const distFreq = new Int32Array(30);
    for (let i = 0; i < bt.length; i++) {
      litFreq[bt[i]]++;
      if (bt[i] >= 257 && bt[i] < 286) distFreq[distCodeOf(bd[i])]++;
    }
    // Every alphabet needs at least two codes for a complete (Kraft == 1)
    // Huffman table; pad with a dummy frequency-1 symbol when short.
    let litUsed = 0;
    for (let i = 0; i < 286; i++) if (litFreq[i] > 0) litUsed++;
    if (litUsed < 2) litFreq[litFreq[0] === 0 ? 0 : 1] = 1;
    let distUsed = 0;
    for (let i = 0; i < 30; i++) if (distFreq[i] > 0) distUsed++;
    if (distUsed < 2) {
      if (distFreq[0] === 0) distFreq[0] = 1;
      if (distFreq[1] === 0) distFreq[1] = 1;
    }
    const litLen = huffmanLengths(litFreq, 15);
    const distLen = huffmanLengths(distFreq, 15);
    const cap = Math.max(1024, (end - start) * 4);
    const wd = new BitWriter(cap);
    emitDynamicBlock(wd, bt, bl, bd, litLen, distLen, isFinal);
    const wf = new BitWriter(cap);
    emitFixedBlock(wf, bt, bl, bd, isFinal);
    if (wd.bits() <= wf.bits()) emitDynamicBlock(main, bt, bl, bd, litLen, distLen, isFinal);
    else emitFixedBlock(main, bt, bl, bd, isFinal);
  }
  return main.flush();
}

const MAX_CHAIN = 4096;

/** Parse raw into DEFLATE tokens (lazy LZ77). Returns { toks, lens, dists }. */
function parseTokens(raw, stride) {
  const maxChain = MAX_CHAIN;
  const n = raw.length;
  const HASH_BITS = 15;
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hashAt = (p) => (((raw[p] << 10) ^ (raw[p + 1] << 5) ^ raw[p + 2]) & ((1 << HASH_BITS) - 1));
  const matchLen = (a, b, maxL) => {
    let len = 0;
    while (len < maxL && raw[a + len] === raw[b + len]) len++;
    return len;
  };
  const toks = [];
  const lens = [];
  const dists = [];
  const findMatch = (pos) => {
    if (pos + 3 > n) return { len: 0, dist: 0 };
    const maxL = Math.min(258, n - pos);
    let bestLen = 2, bestDist = 0;
    // Seeds: the same column one and two rows above, and its neighbours.
    // Screenshots repeat vertically; one cheap check each recovers matches
    // a short hash chain would walk thousands of candidates to reach.
    if (stride > 0) {
      for (const d of [stride, stride * 2, stride - 1, stride + 1]) {
        if (d > 0 && pos >= d) {
          const len = matchLen(pos - d, pos, maxL);
          if (len > bestLen || (len === bestLen && d < bestDist)) { bestLen = len; bestDist = d; }
        }
      }
    }
    const h = hashAt(pos);
    let cand = head[h];
    // A long seeded match makes a long chain walk pointless.
    let chain = bestLen >= 32 ? 8 : maxChain;
    const limit = pos > 32768 ? pos - 32768 : 0;
    while (cand >= limit && chain-- > 0) {
      const len = matchLen(cand, pos, maxL);
      // A tie in length goes to the shorter distance: same length code,
      // but a cheaper distance code and fewer extra bits.
      if (len > bestLen || (len === bestLen && pos - cand < bestDist)) {
        bestLen = len; bestDist = pos - cand;
        if (len >= maxL) break;
      }
      cand = prev[cand];
    }
    return { len: bestLen, dist: bestDist };
  };
  const insertPos = (p) => {
    if (p + 3 > n) return;
    const h = hashAt(p);
    prev[p] = head[h];
    head[h] = p;
  };
  let pos = 0;
  while (pos < n) {
    const m0 = findMatch(pos);
    insertPos(pos);
    if (m0.len >= 3) {
      let useMatch = true;
      if (pos + 1 < n) {
        const m1 = findMatch(pos + 1);
        if (m1.len > m0.len) useMatch = false;
      }
      if (useMatch) {
        const lc = lenCodeOf(m0.len);
        toks.push(257 + lc); lens.push(m0.len); dists.push(m0.dist);
        const end = pos + m0.len;
        for (let p = pos + 1; p < end; p++) insertPos(p);
        pos = end;
        continue;
      }
    }
    toks.push(raw[pos]); lens.push(0); dists.push(0);
    pos++;
  }
  toks.push(256); lens.push(0); dists.push(0);
  return { toks: Int32Array.from(toks), lens, dists };
}

/** One whole zlib stream of raw from already-parsed tokens. */
function encodeZlib(raw, parsed, blockTokens) {
  const body = encodeBlocks(parsed.toks, parsed.lens, parsed.dists, blockTokens);
  const out = new Uint8Array(body.length + 6);
  out[0] = 0x78; out[1] = 0xda;
  out.set(body, 2);
  const a = adler32(raw);
  out[out.length - 4] = (a >>> 24) & 0xff;
  out[out.length - 3] = (a >>> 16) & 0xff;
  out[out.length - 2] = (a >>> 8) & 0xff;
  out[out.length - 1] = a & 0xff;
  return out;
}

/**
 * Custom DEFLATE for one filtered image: parse once, encode at two block
 * sizes, keep the smaller stream. Returns null on any failure, so the
 * caller keeps zlib level 9.
 */
export function squeezeDeflate(raw, stride = 0) {
  try {
    const parsed = parseTokens(raw, stride);
    const a = encodeZlib(raw, parsed, 2048);
    const b = encodeZlib(raw, parsed, 4096);
    return a.length <= b.length ? a : b;
  } catch {
    return null;
  }
}

