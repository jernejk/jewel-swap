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
  /** 0–1; how evenly the picture divides between colours. Even is harder. */
  readonly balance: number;
  /** Cells in the smallest colour — the first shelf payout you can reach. */
  readonly rarestColour: number;
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

/**
 * How evenly the picture divides between its colours, as normalised Shannon
 * entropy (1 = every colour equally common).
 *
 * This is the least obvious difficulty term and one of the strongest. The shelf
 * only grows when a colour is *finished*, so a level split evenly between five
 * colours withholds every payout until late — you play the hardest part of the
 * puzzle with the smallest buffer. Give one colour just six cells and the
 * player clears it almost immediately, banks the extra slots, and coasts. Same
 * grid, same palette size, completely different game.
 */
export function colourBalance(level: LevelSpec): number {
  const counts: number[] = [];
  const hist = new Map<ColourId, number>();
  for (const t of level.target) {
    if (t == null) continue;
    hist.set(t, (hist.get(t) ?? 0) + 1);
  }
  let total = 0;
  for (const n of hist.values()) {
    counts.push(n);
    total += n;
  }
  if (counts.length < 2 || total === 0) return 0;

  let entropy = 0;
  for (const n of counts) {
    const p = n / total;
    if (p > 0) entropy -= p * Math.log(p);
  }
  return entropy / Math.log(counts.length);
}

/** Size of the smallest colour group — how soon the first payout can land. */
export function rarestColourSize(level: LevelSpec): number {
  const hist = new Map<ColourId, number>();
  for (const t of level.target) {
    if (t == null) continue;
    hist.set(t, (hist.get(t) ?? 0) + 1);
  }
  let min = Infinity;
  for (const n of hist.values()) min = Math.min(min, n);
  return Number.isFinite(min) ? min : 0;
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
  const balance = colourBalance(level);
  const rarest = rarestColourSize(level);

  // Scale matters too: the same structure over 400 cells is a longer, heavier
  // puzzle than over 100, even though every ratio above is identical.
  const scale = clamp(cellCount / 400, 0, 1);

  const score = clamp(
    100 *
      (0.3 * clamp(shelfTightness, 0, 1) +
        0.15 * clamp(fragmentation / 25, 0, 1) +
        0.08 * clamp(singletons / 12, 0, 1) +
        0.15 * clamp(cycles / 2, 0, 1) +
        0.08 * confusability +
        0.16 * balance +
        0.08 * scale),
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
    balance: round2(balance),
    rarestColour: rarest,
    colours: comps.size,
    cells: cellCount,
  };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * A difficulty estimate that needs no solver, so the gallery can rank and
 * label every level instantly. It omits the two strongest terms — shelf
 * tightness and cycle pressure — because both require actually solving a
 * scramble, which costs far too much to do for a whole grid of thumbnails.
 * Everything here is a property of the artwork alone, so it is stable across
 * seeds and safe to sort by.
 */
export function staticDifficulty(level: LevelSpec): number {
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
  const balance = colourBalance(level);
  const rarest = rarestColourSize(level);

  // A tiny colour is an early shelf payout, which makes the rest of the level
  // markedly easier — so it discounts the score rather than adding to it.
  const earlyPayout = clamp(1 - rarest / 24, 0, 1);

  return Math.round(
    clamp(
      100 *
        (0.26 * clamp(cellCount / 420, 0, 1) +
          0.22 * balance +
          0.18 * clamp(comps.size / 8, 0, 1) +
          0.16 * clamp(fragmentation / 25, 0, 1) +
          0.1 * clamp(singletons / 12, 0, 1) +
          0.08 * adjacentConfusability(level) -
          0.12 * (1 - earlyPayout)),
      0,
      100,
    ),
  );
}

/** 1–5, for a gallery tile that has no room for a number. */
export function difficultyStars(level: LevelSpec): number {
  const d = staticDifficulty(level);
  return Math.max(1, Math.min(5, Math.floor(d / 16) + 1));
}
