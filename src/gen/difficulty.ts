import { components, neighbours8 } from '../core/grid';
import type { ColourId, GameState, LevelSpec } from '../core/types';
import { paletteDistance } from './ciede2000';

export interface DifficultyReport {
  /** 0–100 composite. Weights are a calibration knob; components are reported raw. */
  readonly score: number;
  /** minCapacity ÷ initialCapacity — how close the level runs to its own buffer limit. */
  readonly shelfTightness: number;
  readonly minCapacity: number;
  readonly peakShelf: number;
  /** Extra colour components beyond one-per-colour, per 100 cells. */
  readonly fragmentation: number;
  /** Single-cell components — each costs a dedicated shelf visit. */
  readonly singletons: number;
  /** How much of the misplacement lies on long permutation cycles. */
  readonly cyclePressure: number;
  /** 0–1; higher means adjacent colours are harder to tell apart. */
  readonly confusability: number;
  readonly colours: number;
  readonly cells: number;
}

/** Per-colour 8-connected components of the *target* image. */
export function targetComponents(level: LevelSpec): Map<ColourId, number[]> {
  const byColour = new Map<ColourId, number[]>();
  const colours = new Set<ColourId>();
  for (const t of level.target) if (t != null) colours.add(t);
  for (const colour of colours) {
    const { sizes } = components(
      level.width,
      level.height,
      (c) => level.target[c] === colour,
    );
    byColour.set(colour, sizes);
  }
  return byColour;
}

/**
 * Permutation structure lifted to colour classes, where it actually binds the
 * shelf: build the digraph "jewels of colour A are sitting in sockets of
 * colour B", decompose it greedily into cycles, and score Σ weight×(len−1).
 * A 2-cycle (A in B's seat, B in A's) needs one buffered jewel; a 5-cycle
 * needs four. That is exactly the pressure the shelf exists to absorb.
 */
export function cyclePressure(level: LevelSpec, jewels: readonly (ColourId | null)[]): number {
  const edges = new Map<string, number>();
  const nodes = new Set<ColourId>();
  let misplaced = 0;
  for (let i = 0; i < level.target.length; i++) {
    const t = level.target[i];
    const j = jewels[i];
    if (t == null || j == null || t === j) continue;
    misplaced++;
    nodes.add(t);
    nodes.add(j);
    const key = `${j}>${t}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  if (misplaced === 0) return 0;

  const weight = (a: ColourId, b: ColourId): number => edges.get(`${a}>${b}`) ?? 0;
  const setWeight = (a: ColourId, b: ColourId, w: number): void => {
    if (w <= 0) edges.delete(`${a}>${b}`);
    else edges.set(`${a}>${b}`, w);
  };

  let total = 0;
  const list = [...nodes];
  for (;;) {
    const cycle = findCycle(list, weight);
    if (!cycle) break;
    let min = Infinity;
    for (let i = 0; i < cycle.length; i++) {
      const a = cycle[i] as ColourId;
      const b = cycle[(i + 1) % cycle.length] as ColourId;
      min = Math.min(min, weight(a, b));
    }
    for (let i = 0; i < cycle.length; i++) {
      const a = cycle[i] as ColourId;
      const b = cycle[(i + 1) % cycle.length] as ColourId;
      setWeight(a, b, weight(a, b) - min);
    }
    total += min * (cycle.length - 1);
  }
  return total / misplaced;
}

function findCycle(
  nodes: readonly ColourId[],
  weight: (a: ColourId, b: ColourId) => number,
): ColourId[] | null {
  for (const start of nodes) {
    const path: ColourId[] = [];
    const onPath = new Map<ColourId, number>();
    const visited = new Set<ColourId>();
    // Simple DFS for any cycle reachable from `start`.
    const walk = (node: ColourId): ColourId[] | null => {
      const at = onPath.get(node);
      if (at !== undefined) return path.slice(at);
      if (visited.has(node)) return null;
      visited.add(node);
      onPath.set(node, path.length);
      path.push(node);
      for (const next of nodes) {
        if (weight(node, next) <= 0) continue;
        const found = walk(next);
        if (found) return found;
      }
      path.pop();
      onPath.delete(node);
      return null;
    };
    const found = walk(start);
    if (found && found.length > 0) return found;
  }
  return null;
}

/**
 * Confusability weighted by *spatial adjacency* — two similar colours on
 * opposite sides of the picture never cause a misread, but two similar colours
 * that touch cause them constantly.
 */
export function adjacentConfusability(level: LevelSpec): number {
  const pairs = new Map<string, number>();
  const scratch: number[] = [];
  for (let i = 0; i < level.target.length; i++) {
    const a = level.target[i];
    if (a == null) continue;
    neighbours8(i, level.width, level.height, scratch);
    for (const n of scratch) {
      if (n <= i) continue;
      const b = level.target[n];
      if (b == null || b === a) continue;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  if (pairs.size === 0) return 0;

  let weighted = 0;
  let total = 0;
  for (const [key, count] of pairs) {
    const [a, b] = key.split(':').map(Number) as [number, number];
    const hexA = level.palette[a];
    const hexB = level.palette[b];
    if (hexA == null || hexB == null) continue;
    const dE = paletteDistance(hexA, hexB);
    // ΔE 20 is the confusability floor; 60+ is unmistakably distinct.
    const risk = Math.max(0, Math.min(1, (60 - dE) / 40));
    weighted += risk * count;
    total += count;
  }
  return total === 0 ? 0 : weighted / total;
}

export interface DifficultyInputs {
  readonly minCapacity: number;
  readonly peakShelf: number;
}

export function scoreDifficulty(
  state: GameState,
  inputs: DifficultyInputs,
): DifficultyReport {
  const { level } = state;
  const comps = targetComponents(level);
  let cellCount = 0;
  for (const t of level.target) if (t != null) cellCount++;

  let extraComponents = 0;
  let singletons = 0;
  for (const sizes of comps.values()) {
    extraComponents += Math.max(0, sizes.length - 1);
    for (const s of sizes) if (s === 1) singletons++;
  }

  const fragmentation = (extraComponents / Math.max(1, cellCount)) * 100;
  const cycles = cyclePressure(level, state.jewels);
  const confusability = adjacentConfusability(level);
  const shelfTightness = inputs.minCapacity / Math.max(1, level.initialCapacity);

  const score = clamp(
    100 *
      (0.4 * clamp(shelfTightness, 0, 1) +
        0.2 * clamp(fragmentation / 25, 0, 1) +
        0.1 * clamp(singletons / 12, 0, 1) +
        0.2 * clamp(cycles / 2, 0, 1) +
        0.1 * confusability),
    0,
    100,
  );

  return {
    score: Math.round(score),
    shelfTightness: round2(shelfTightness),
    minCapacity: inputs.minCapacity,
    peakShelf: inputs.peakShelf,
    fragmentation: round2(fragmentation),
    singletons,
    cyclePressure: round2(cycles),
    confusability: round2(confusability),
    colours: comps.size,
    cells: cellCount,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;
