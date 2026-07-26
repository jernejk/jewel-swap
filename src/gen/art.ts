import type { ColourId, LevelSpec } from '../core/types';

/**
 * Levels are authored as ASCII pixel art with a char→colour map. `.` is a
 * masked cell — outside the picture, holds nothing, renders as nothing.
 * Row widths are validated at build time so a miscounted row fails loudly
 * instead of quietly shearing the image.
 */
export interface ArtSpec {
  readonly id: string;
  readonly name: string;
  readonly rows: readonly string[];
  readonly colours: Readonly<Record<string, string>>;
  readonly initialCapacity?: number;
  readonly growthPerColour?: number;
  readonly maxCapacity?: number;
}

export const MASK_CHAR = '.';

/** Slots per tray row. The renderer lays the shelf out in rows of this width. */
export const SHELF_ROW = 12;

export function buildLevel(art: ArtSpec): LevelSpec {
  const height = art.rows.length;
  if (height === 0) throw new Error(`${art.id}: no rows`);
  const width = (art.rows[0] as string).length;
  art.rows.forEach((row, y) => {
    if (row.length !== width) {
      throw new Error(
        `${art.id}: row ${y} is ${row.length} chars, expected ${width} — "${row}"`,
      );
    }
  });

  // Trim fully-masked border rows and columns. Authored art is padded for
  // legibility in source, but every empty border column is screen the picture
  // does not get — and on a phone the board is width-limited, so those columns
  // come straight out of the cell size.
  const rows = trimMask(art.rows);

  const chars = Object.keys(art.colours);
  const palette = chars.map((c) => art.colours[c] as string);
  const indexOf = new Map<string, ColourId>(chars.map((c, i) => [c, i]));

  const target: (ColourId | null)[] = [];
  for (const row of rows) {
    for (const ch of row) {
      if (ch === MASK_CHAR) {
        target.push(null);
        continue;
      }
      const id = indexOf.get(ch);
      if (id === undefined) throw new Error(`${art.id}: no colour for char "${ch}"`);
      target.push(id);
    }
  }

  const coloursUsed = new Set(target.filter((t): t is ColourId => t != null)).size;

  // The tray is exactly two full rows: one unlocked to start, one to earn.
  // A ragged part-row reads as a layout bug, so rather than let the numbers
  // fall where they may we fix the shape and derive the payout from it —
  // finishing every colour always fills the tray exactly, and every locked
  // slot on screen is a promise the level can keep.
  const initialCapacity = art.initialCapacity ?? SHELF_ROW;
  const maxCapacity = art.maxCapacity ?? SHELF_ROW * 2;
  const growthPerColour =
    art.growthPerColour ?? Math.ceil((maxCapacity - initialCapacity) / Math.max(1, coloursUsed));

  return {
    id: art.id,
    name: art.name,
    width: (rows[0] as string).length,
    height: rows.length,
    palette,
    target,
    initialCapacity,
    growthPerColour,
    maxCapacity,
  };
}

function trimMask(rows: readonly string[]): string[] {
  const width = (rows[0] as string).length;
  const isBlank = (s: string): boolean => [...s].every((c) => c === MASK_CHAR);

  let top = 0;
  let bottom = rows.length;
  while (top < bottom && isBlank(rows[top] as string)) top++;
  while (bottom > top && isBlank(rows[bottom - 1] as string)) bottom--;

  let left = 0;
  let right = width;
  const colBlank = (x: number): boolean => rows.every((r) => r[x] === MASK_CHAR);
  while (left < right && colBlank(left)) left++;
  while (right > left && colBlank(right - 1)) right--;

  return rows.slice(top, bottom).map((r) => r.slice(left, right));
}

/** Cells that are part of the picture. */
export function playableCells(level: LevelSpec): number[] {
  const out: number[] = [];
  for (let i = 0; i < level.target.length; i++) if (level.target[i] != null) out.push(i);
  return out;
}

/** How many jewels of each colour the finished picture needs. */
export function colourHistogram(level: LevelSpec): Map<ColourId, number> {
  const hist = new Map<ColourId, number>();
  for (const t of level.target) {
    if (t == null) continue;
    hist.set(t, (hist.get(t) ?? 0) + 1);
  }
  return hist;
}

/**
 * The pigeonhole floor on pre-matched cells. A colour covering `m` of `n` cells
 * has only `n - m` foreign sockets to hide in, so at least `2m - n` of its
 * jewels must start on their own colour. No scramble can beat this, which makes
 * it the honest yardstick for judging one — and a warning at authoring time
 * that a picture is too dominated by a single colour to make a good puzzle.
 */
export function minimumPreMatched(level: LevelSpec): number {
  const hist = colourHistogram(level);
  let total = 0;
  for (const n of hist.values()) total += n;
  let floor = 0;
  for (const m of hist.values()) floor = Math.max(floor, 2 * m - total);
  return Math.max(0, floor);
}
