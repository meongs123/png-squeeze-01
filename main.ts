// png-squeeze-01: squeeze each screenshot in /input/<id>/image.png into the
// smallest lossless PNG we can write, at /output/<id>/image.png.
//
// The work lives in squeeze.mjs (decode, colour-form reduction, per-row
// filter choice, zlib screening, optimal-parsing DEFLATE) with the encoder
// core in zdeflate.mjs. This file only walks the set: one instance after
// another, in sorted order, so the run is deterministic and its memory
// stays one image at a time. It never writes to the repository: it reads
// the entry's own sources and the input files, and writes only under
// MAKEFUN_OUTPUT_DIR.
//
// If one instance fails to compress for any reason, its input file is
// copied through unchanged instead: the stored input is a valid PNG of
// the same image, so the instance stays answered (at 0 points) rather
// than unanswered.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, squeezePng } from './squeeze.mjs';

const inputRoot = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputRoot = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const ids = readdirSync(inputRoot).sort();
for (const id of ids) {
  // Only directories hold instances; a stray file in /input is skipped
  // rather than failing the whole run.
  let isDir = false;
  try {
    isDir = statSync(join(inputRoot, id)).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) continue;
  const source = join(inputRoot, id, 'image.png');
  const targetDir = join(outputRoot, id);
  const target = join(targetDir, 'image.png');
  mkdirSync(targetDir, { recursive: true });
  let written = false;
  const t0 = process.hrtime.bigint();
  try {
    const image = decodePng(readFileSync(source));
    const png = squeezePng(image.w, image.h, image.rgba);
    writeFileSync(target, png);
    written = true;
  } catch {
    written = false;
  }
  if (!written) copyFileSync(source, target);
  console.error(id, Number((process.hrtime.bigint() - t0) / 1000000n) + ' ms');
}
