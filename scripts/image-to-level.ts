/**
 * Turn any image into a playable puzzle.
 *
 *   npx vite-node scripts/image-to-level.ts -- art/apple.png --size 16 --colours 5
 *   npx vite-node scripts/image-to-level.ts -- art/*.png --out src/levels/pack.ts
 *
 * Decoding happens in headless Chromium — Playwright is already a dev
 * dependency for the e2e suite, so this handles PNG/JPEG/WebP/GIF without
 * adding an image library. Everything after that is shared with the game
 * itself: the same CIEDE2000, the same `buildLevel`, the same solver that
 * certifies a board is winnable. A level this script emits has been proven
 * solvable before it is ever written to disk.
 */
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { buildLevel, minimumPreMatched, playableCells, type ArtSpec } from '../src/gen/art';
import { deltaE2000, rgbToLab, type Lab } from '../src/gen/ciede2000';
import { staticDifficulty } from '../src/gen/difficulty';
import { generate } from '../src/gen/scramble';
import { mulberry32 } from '../src/core/rng';

/** Chars used for palette entries, in order. `.` is reserved for masked cells. */
const CHARS = 'abcdefghijklmnopqrstuvwxyz';

/** Below this the game force-enables symbol mode, so we merge instead. */
const MIN_DELTA_E = 22;

interface Options {
  size: number;
  colours: number;
  maxColours: number;
  minAlpha: number;
  denoise: boolean;
  dropBackground: boolean;
  out: string | null;
  files: string[];
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    size: 16,
    colours: 5,
    maxColours: 8,
    minAlpha: 128,
    denoise: true,
    dropBackground: true,
    out: null,
    files: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--size') opts.size = Number(argv[++i]);
    else if (a === '--colours' || a === '--colors') opts.colours = Number(argv[++i]);
    else if (a === '--max-colours' || a === '--max-colors') opts.maxColours = Number(argv[++i]);
    else if (a === '--min-alpha') opts.minAlpha = Number(argv[++i]);
    else if (a === '--no-denoise') opts.denoise = false;
    else if (a === '--keep-background') opts.dropBackground = false;
    else if (a === '--out') opts.out = argv[++i] as string;
    else if (!a.startsWith('--')) opts.files.push(a);
  }
  return opts;
}

interface Pixels {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: number[];
}

/**
 * Downscale in the browser. Box-averaging over each destination cell (rather
 * than nearest-neighbour) is what makes photographs survive the trip down to a
 * 16-wide grid — sampling single pixels picks up whichever speck happened to
 * land under the sample point.
 */
async function rasterise(file: string, maxSide: number, page: import('@playwright/test').Page): Promise<Pixels> {
  const bytes = await readFile(file);
  const ext = extname(file).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext === 'svg' ? 'svg+xml' : ext;
  const dataUrl = `data:image/${mime};base64,${bytes.toString('base64')}`;

  return page.evaluate(
    async ({ url, side }) => {
      const img = new Image();
      img.src = url;
      await img.decode();

      const scale = side / Math.max(img.naturalWidth, img.naturalHeight);
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, w, h);
      return { width: w, height: h, data: Array.from(ctx.getImageData(0, 0, w, h).data) };
    },
    { url: dataUrl, side: maxSide },
  );
}

interface Sample {
  index: number;
  lab: Lab;
  rgb: [number, number, number];
}

/**
 * k-means in Lab space, seeded deterministically.
 *
 * Lab rather than RGB because clustering is a perceptual question: in RGB two
 * greens a person cannot tell apart sit further apart than a blue and a purple
 * they can, so an RGB clusterer spends its colour budget in the wrong places.
 */
function quantise(samples: Sample[], k: number, seed = 1): Lab[] {
  const rand = mulberry32(seed);
  if (samples.length <= k) return samples.map((s) => s.lab);

  // k-means++ seeding: spread the initial centroids out, or a run can converge
  // with two centroids inside one colour and none in another.
  const centroids: Lab[] = [(samples[Math.floor(rand() * samples.length)] as Sample).lab];
  while (centroids.length < k) {
    const distances = samples.map((s) =>
      Math.min(...centroids.map((c) => deltaE2000(s.lab, c))) ** 2,
    );
    const total = distances.reduce((a, b) => a + b, 0);
    if (total === 0) break;
    let target = rand() * total;
    let pick = 0;
    for (let i = 0; i < distances.length; i++) {
      target -= distances[i] as number;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push((samples[pick] as Sample).lab);
  }

  for (let iter = 0; iter < 24; iter++) {
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = deltaE2000(s.lab, centroids[c] as Lab);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      const acc = sums[best] as number[];
      acc[0] = (acc[0] as number) + s.lab[0];
      acc[1] = (acc[1] as number) + s.lab[1];
      acc[2] = (acc[2] as number) + s.lab[2];
      acc[3] = (acc[3] as number) + 1;
    }
    let moved = 0;
    for (let c = 0; c < centroids.length; c++) {
      const acc = sums[c] as number[];
      const n = acc[3] as number;
      if (n === 0) continue;
      const next: Lab = [(acc[0] as number) / n, (acc[1] as number) / n, (acc[2] as number) / n];
      moved += deltaE2000(centroids[c] as Lab, next);
      centroids[c] = next;
    }
    if (moved < 0.4) break;
  }
  return centroids;
}

function labToHex(lab: Lab): string {
  // Lab -> XYZ -> linear sRGB -> gamma. Kept local because the game only ever
  // needs the forward direction.
  const [L, a, bb] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;
  const inv = (t: number): number => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const x = inv(fx) * 95.047;
  const y = inv(fy) * 100;
  const z = inv(fz) * 108.883;

  const lin = [
    (x * 3.2406 + y * -1.5372 + z * -0.4986) / 100,
    (x * -0.9689 + y * 1.8758 + z * 0.0415) / 100,
    (x * 0.0557 + y * -0.204 + z * 1.057) / 100,
  ];
  const channel = (v: number): string => {
    const g = v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v;
    return Math.max(0, Math.min(255, Math.round(g * 255)))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(lin[0] as number)}${channel(lin[1] as number)}${channel(lin[2] as number)}`;
}

function assign(samples: Sample[], palette: Lab[]): number[] {
  return samples.map((s) => {
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < palette.length; c++) {
      const d = deltaE2000(s.lab, palette[c] as Lab);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  });
}

/**
 * Spend extra palette slots on whichever colour dominates, splitting it into
 * shades until nothing owns more than `maxShare` of the picture.
 *
 * Almost every real image has a large flat region — sky, backdrop, a character's
 * body — and a plain k-means gives it a single swatch. That makes a *terrible*
 * puzzle: a colour covering over half the cells cannot be fully scrambled (see
 * `minimumPreMatched`), so a big slice of the board starts already solved. It is
 * also exactly what physical diamond painting does with a large area — three
 * shades of sky, not one — so the fix improves the picture and the puzzle at once.
 */
function balancePalette(
  samples: Sample[],
  palette: Lab[],
  maxColours: number,
  maxShare = 0.34,
): Lab[] {
  let current = palette;
  for (let guard = 0; guard < 12 && current.length < maxColours; guard++) {
    const owners = assign(samples, current);
    const counts = new Array<number>(current.length).fill(0);
    for (const o of owners) counts[o] = (counts[o] as number) + 1;

    let biggest = 0;
    for (let i = 1; i < counts.length; i++) {
      if ((counts[i] as number) > (counts[biggest] as number)) biggest = i;
    }
    if ((counts[biggest] as number) / samples.length <= maxShare) break;

    const members = samples.filter((_, i) => owners[i] === biggest);
    if (members.length < 8) break;

    const halves = quantise(members, 2, 7 + guard);
    // Refuse a split the player could not see — better one honest colour than
    // two that look identical.
    if (halves.length < 2 || deltaE2000(halves[0] as Lab, halves[1] as Lab) < MIN_DELTA_E) break;

    current = [...current.slice(0, biggest), ...halves, ...current.slice(biggest + 1)];
  }
  return current;
}

/** Collapse palette entries a player could not tell apart. */
function mergeClose(palette: Lab[]): Lab[] {
  const kept: Lab[] = [];
  for (const colour of palette) {
    if (kept.every((k) => deltaE2000(k, colour) >= MIN_DELTA_E)) kept.push(colour);
  }
  return kept;
}

/**
 * Mask out the backdrop: flood-fill inward from the border and drop every cell
 * that matches the dominant edge colour.
 *
 * This is the single most important step for real images, and it took a failing
 * conversion to see why. A photo or illustration is a subject sitting on a large
 * flat backdrop, and that backdrop is routinely two thirds of the pixels — far
 * past the point where a colour can even be scrambled (`minimumPreMatched`), so
 * a huge slice of the board would start already solved. Splitting it into shades
 * cannot rescue it either: a *flat* region has no shades, and any split lands
 * under the visibility threshold.
 *
 * Masking it is also simply what the original game does. Its boards are shaped
 * like the subject — a circle, a heart, a rocket — never a filled rectangle.
 * Flood-filling rather than removing the colour everywhere is deliberate: a
 * white backdrop should vanish while white *eyes* on the subject stay.
 */
function dropBackground(
  cells: (number | null)[],
  w: number,
  h: number,
): (number | null)[] {
  const border: number[] = [];
  for (let x = 0; x < w; x++) {
    border.push(x, (h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    border.push(y * w, y * w + w - 1);
  }

  const tally = new Map<number, number>();
  for (const i of border) {
    const c = cells[i];
    if (c != null) tally.set(c, (tally.get(c) ?? 0) + 1);
  }
  let backdrop: number | null = null;
  let best = 0;
  for (const [colour, n] of tally) {
    if (n > best) {
      best = n;
      backdrop = colour;
    }
  }
  // Only treat it as a backdrop if it actually dominates the edge.
  if (backdrop == null || best / border.length < 0.6) return cells;

  const out = cells.slice();
  const queue = border.filter((i) => cells[i] === backdrop);
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const i = queue.pop() as number;
    out[i] = null;
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (seen.has(n) || cells[n] !== backdrop) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return out;
}

/** Drop palette entries no longer used, and renumber what remains. */
function compactPalette(
  cells: (number | null)[],
  palette: Lab[],
): { cells: (number | null)[]; palette: Lab[] } {
  const used = [...new Set(cells.filter((c): c is number => c != null))].sort((a, b) => a - b);
  const remap = new Map(used.map((old, i) => [old, i]));
  return {
    cells: cells.map((c) => (c == null ? null : (remap.get(c) as number))),
    palette: used.map((i) => palette[i] as Lab),
  };
}

/** Reassign lone cells to the surrounding majority — one-pixel speckle is noise, not art. */
function denoise(cells: (number | null)[], w: number, h: number): (number | null)[] {
  const out = cells.slice();
  for (let i = 0; i < cells.length; i++) {
    const here = cells[i];
    if (here == null) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const tally = new Map<number, number>();
    let same = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = cells[ny * w + nx];
        if (n == null) continue;
        if (n === here) same++;
        tally.set(n, (tally.get(n) ?? 0) + 1);
      }
    }
    if (same > 0) continue;
    let best: number | null = null;
    let bestN = 0;
    for (const [colour, n] of tally) {
      if (n > bestN) {
        bestN = n;
        best = colour;
      }
    }
    if (best != null && bestN >= 3) out[i] = best;
  }
  return out;
}

async function convert(file: string, opts: Options, page: import('@playwright/test').Page): Promise<ArtSpec> {
  const px = await rasterise(file, opts.size, page);

  const samples: Sample[] = [];
  const masked = new Set<number>();
  for (let i = 0; i < px.width * px.height; i++) {
    const r = px.data[i * 4] as number;
    const g = px.data[i * 4 + 1] as number;
    const b = px.data[i * 4 + 2] as number;
    const a = px.data[i * 4 + 3] as number;
    if (a < opts.minAlpha) {
      masked.add(i);
      continue;
    }
    samples.push({ index: i, lab: rgbToLab(r, g, b), rgb: [r, g, b] });
  }
  if (samples.length === 0) throw new Error(`${file}: every pixel is transparent`);

  const palette = mergeClose(
    balancePalette(samples, quantise(samples, opts.colours), opts.maxColours),
  );
  if (palette.length < 2) {
    throw new Error(
      `${file}: only ${palette.length} distinguishable colour(s) survived — the source is too flat`,
    );
  }

  let cells: (number | null)[] = new Array(px.width * px.height).fill(null);
  for (const s of samples) {
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < palette.length; c++) {
      const d = deltaE2000(s.lab, palette[c] as Lab);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    cells[s.index] = best;
  }
  if (opts.dropBackground) cells = dropBackground(cells, px.width, px.height);
  if (opts.denoise) cells = denoise(cells, px.width, px.height);

  const compacted = compactPalette(cells, palette);
  cells = compacted.cells;
  const finalPalette = compacted.palette;
  if (finalPalette.length < 2) {
    throw new Error(`${file}: only ${finalPalette.length} colour(s) left after masking the backdrop`);
  }

  const rows: string[] = [];
  for (let y = 0; y < px.height; y++) {
    let row = '';
    for (let x = 0; x < px.width; x++) {
      const c = cells[y * px.width + x];
      row += c == null ? '.' : (CHARS[c] as string);
    }
    rows.push(row);
  }

  const id = basename(file, extname(file))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const colours: Record<string, string> = {};
  finalPalette.forEach((lab, i) => {
    colours[CHARS[i] as string] = labToHex(lab);
  });

  return {
    id,
    name: id.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()),
    colours,
    rows,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const opts = parseArgs(argv);
  if (opts.files.length === 0) {
    console.error(
      'usage: vite-node scripts/image-to-level.ts -- <image...> [--size 16] [--colours 5] [--out FILE]',
    );
    process.exit(1);
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const accepted: ArtSpec[] = [];

  try {
    for (const file of opts.files) {
      const path = resolve(file);
      try {
        const art = await convert(path, opts, page);
        const level = buildLevel(art);

        // Refuse anything the game itself would reject, here rather than at
        // runtime: an unsolvable or unbalanced level is a bug the player finds.
        const cells = playableCells(level).length;
        const floor = minimumPreMatched(level);
        if (floor / cells > 0.15) {
          throw new Error(
            `too dominated by one colour (${Math.round((floor / cells) * 100)}% must start correct) — try more --colours`,
          );
        }
        const gen = generate(level, { seed: 1 });

        accepted.push(art);
        console.log(
          `✓ ${art.id.padEnd(18)} ${level.width}x${level.height}  ` +
            `${level.palette.length} colours  ${cells} cells  ` +
            `difficulty ${staticDifficulty(level)}  (solved in ${gen.trace.length} moves)`,
        );
      } catch (err) {
        console.log(`✗ ${basename(path).padEnd(18)} ${(err as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }

  if (accepted.length === 0) {
    console.error('\nnothing converted');
    process.exit(1);
  }

  const body = accepted
    .map((a) => {
      const colours = Object.entries(a.colours)
        .map(([ch, hex]) => `      ${ch}: '${hex}'`)
        .join(',\n');
      const rows = a.rows.map((r) => `      '${r}'`).join(',\n');
      return `  {\n    id: '${a.id}',\n    name: '${a.name}',\n    colours: {\n${colours},\n    },\n    rows: [\n${rows},\n    ],\n  }`;
    })
    .join(',\n');

  const source = `import type { ArtSpec } from '../src/gen/art';\n\n/** Generated by scripts/image-to-level.ts — every level here is solver-certified. */\nexport const PACK: readonly ArtSpec[] = [\n${body},\n];\n`;

  if (opts.out) {
    await writeFile(resolve(opts.out), source.replace("'../src/gen/art'", "'../gen/art'"));
    console.log(`\nwrote ${accepted.length} level(s) to ${opts.out}`);
  } else {
    console.log(`\n${source}`);
  }
}

await main();
