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
   holds at most 256 colours, grey (type 0/4) when every pixel is grey, RGB
   (type 2) when opaque, RGBA (type 6) otherwise; a single fully-transparent
   value becomes a tRNS key instead of an alpha channel. Colours behind
   fully transparent pixels are preserved exactly.
2. **Per-row filter choice**: fixed filters 0–4 plus minimum-signed-sum,
   fewest-distinct-byte-pairs and fewest-distinct-bytes heuristics, screened
   with zlib level 6; the best few candidates are re-encoded at level 9
   (default and filtered strategies, memLevel 8 and 9) and the smallest file
   wins.
3. **Custom DEFLATE** (`deflate.mjs`, written from scratch): lazy LZ77
   matching over hash chains, seeded with the same column one and two rows
   above (screenshots repeat vertically), ties broken toward the shorter
   distance, then dynamic/fixed Huffman blocks of 2048/4096 tokens — the
   smaller stream wins, and only when it is strictly smaller than zlib
   level 9 for that image.

Everything is deterministic: fixed chain length and block sizes, no clock,
no randomness, no environment reads, no network. One run over the practice
set takes ~25 s on one CPU, well inside the 60 s wall.

## Results (practice set, kit checker)

| instance | bytes | points |
|----------|------:|-------:|
| i001 | 12,425 | 721.9 |
| i002 | 50,759 | 718.8 |
| i003 | 105,572 | 681.0 |
| i004 | 109,665 | 671.8 |
| i005 | 16,498 | 744.2 |
| i006 | 178,606 | 690.7 |
| i007 | 60,890 | 701.9 |
| i008 | 24,637 | 720.6 |
| **total** | **559,052** | **score 706,359** |

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
  zlib screening.
- `deflate.mjs` — custom DEFLATE encoder (lazy LZ77 + Huffman blocks).
- `package.json` — marks the package as ESM so Node runs the sources
  without a module-type warning.
