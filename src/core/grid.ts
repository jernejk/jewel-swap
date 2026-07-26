import type { CellIndex } from './types';

/**
 * 8-connectivity (H/V/diagonal) is the observed rule in the original: a pour
 * flows through cells that touch at corners as well as edges. It is the single
 * most consequential constant in the game — it decides how the target image
 * decomposes into regions, which is the real difficulty dial.
 */
export const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

export function neighbours8(
  index: CellIndex,
  width: number,
  height: number,
  out: CellIndex[],
): CellIndex[] {
  out.length = 0;
  const x = index % width;
  const y = (index / width) | 0;
  for (const off of NEIGHBOUR_OFFSETS) {
    const nx = x + (off[0] as number);
    const ny = y + (off[1] as number);
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    out.push(ny * width + nx);
  }
  return out;
}

/**
 * Breadth-first flood from `start` through cells satisfying `include`.
 * Returns cells in wavefront order — the renderer replays exactly this order to
 * stagger the animation, so the visual ripple matches the logical spread.
 */
export function bfsRegion(
  start: CellIndex,
  width: number,
  height: number,
  include: (cell: CellIndex) => boolean,
  limit = Infinity,
): CellIndex[] {
  if (!include(start) || limit <= 0) return [];
  const seen = new Set<CellIndex>([start]);
  const order: CellIndex[] = [start];
  const scratch: CellIndex[] = [];
  for (let head = 0; head < order.length && order.length < limit; head++) {
    const cell = order[head] as CellIndex;
    neighbours8(cell, width, height, scratch);
    for (const n of scratch) {
      if (order.length >= limit) break;
      if (seen.has(n) || !include(n)) continue;
      seen.add(n);
      order.push(n);
    }
  }
  return order;
}

/**
 * Every 8-connected component of cells satisfying `include`, as a component-id
 * per cell (-1 where excluded) plus the component sizes.
 */
export function components(
  width: number,
  height: number,
  include: (cell: CellIndex) => boolean,
): { ids: Int32Array; sizes: number[] } {
  const total = width * height;
  const ids = new Int32Array(total).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < total; i++) {
    if (ids[i] !== -1 || !include(i)) continue;
    const id = sizes.length;
    const region = bfsRegion(i, width, height, (c) => ids[c] === -1 && include(c));
    for (const c of region) ids[c] = id;
    sizes.push(region.length);
  }
  return { ids, sizes };
}
