# PNG Squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/meongs123/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/meongs123/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Entry for the [make.fun](https://make.fun) bounty
[Squeeze screenshots into the smallest PNG](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127):
rewrite each 1280×720 RGBA screenshot as a lossless PNG in as few bytes as
possible — every pixel's red, green, blue and alpha decode exactly, a fully
transparent pixel's colour too.

## How it works

Three layers, cheapest first:

1. **Format reduction** (`squeeze.mjs`): palette (type 3) when the image
   holds at most 256 colours (three palette orders tried: first-seen,
   most-frequent, luminance), grey (type 0/4) when every pixel is grey, RGB
   (type 2) when opaque, RGBA (type 6) otherwise; a single fully-transparent
   colour becomes a tRNS key instead of an alpha channel. Colours behind
   fully transparent pixels are preserved exactly.
2. **Per-row filter choice**: all five fixed filters 0–4 plus three
   adaptive strategies that pick, row by row, the filter minimising
   signed-byte sum, distinct-byte count, or entropy. Every (colour form,
   filter) pair is screened with a cheap zlib level-3 proxy; the best three
   pairs are re-encoded at zlib level 9 (default and filtered strategies)
   and the smallest file wins.
3. **Optimal-parsing DEFLATE** (`zdeflate.mjs`, written from scratch):
   hash-chain match finding, then iterated cost-based optimal parsing
   (forward shortest-path DP against per-block entropy cost tables) with
   agglomerative block splitting and exact package-merge length-limited
   Huffman codes. It runs on the single best (form, filter) pair, with its
   effort set by the filtered data's size only, and the stream is kept only
   when it is strictly smaller than the zlib level-9 result for that image.

The winner is decoded again and must match the input pixel for pixel; a
mismatch — or a corrupt stream, which fails the decode outright — falls
back to plain RGBA + Paeth + zlib level 9.

Everything is deterministic: fixed chain lengths, block sizes and
iteration counts, all keyed to data size and never to the clock; no
randomness, no environment reads, no network. One run over the practice
set takes ~34 s of CPU on one core, inside the 60 s wall.

## Results (practice set, kit checker)

| instance | bytes | points |
|----------|------:|-------:|
| i001 | 11,956 | 744.9 |
| i002 | 54,647 | 671.7 |
| i003 | 103,934 | 691.1 |
| i004 | 102,443 | 715.4 |
| i005 | 17,218 | 718.5 |
| i006 | 176,924 | 696.8 |
| i007 | 60,890 | 701.9 |
| i008 | 24,199 | 731.5 |
| **total** | **552,211** | **score 708,975** |

House baseline fixed-paeth 1.0.0 on the same set: 708,151 bytes, score
420,399.

## How it runs

`main.ts` (Node 22, standard library only) reads `/input/<id>/image.png`
and writes `/output/<id>/image.png`, one instance after another:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

If one instance fails to compress for any reason, its input file is copied
through unchanged, so the instance stays answered instead of unanswered.

## Files

- `main.ts` — walks the set, one image at a time.
- `squeeze.mjs` — PNG decode/encode, colour-type reduction, filter choice,
  zlib screening, self-check with fallback.
- `zdeflate.mjs` — optimal-parsing DEFLATE encoder (hash-chain matches,
  shortest-path parse, block splitting, package-merge Huffman).
- `package.json` — marks the package as ESM so Node runs the sources
  without a module-type warning.
