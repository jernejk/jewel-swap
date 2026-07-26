import { mulberry32, shuffleInPlace } from '../core/rng';
import { createState, reduce } from '../core/reducer';
import { pickupRegions, status } from '../core/moves';
import { solve, minimumCapacity } from '../solver/solver';
import type { Action, ColourId, GameState, LevelSpec } from '../core/types';
import { colourHistogram, playableCells } from './art';
import { neighbours8 } from '../core/grid';
import { scoreDifficulty, type DifficultyReport } from './difficulty';

/**
 * A colour-preserving permutation of the finished picture. The jewel multiset
 * is the target multiset by construction, so the board is always exactly
 * solvable in principle — the question is only whether it is solvable *within
 * the shelf*, which the solver settles.
 */
export function scramble(
  level: LevelSpec,
  seed: number,
  maxRepairPasses = 8,
): (ColourId | null)[] {
  const rand = mulberry32(seed);
  const cells = shuffleInPlace(playableCells(level), rand);
  const remaining = new Map<ColourId, number>(colourHistogram(level));
  const jewels: (ColourId | null)[] = new Array(level.target.length).fill(null);
  const scratch: number[] = [];

  // Clumped, not maximally dispersed — and not uniformly random either.
  //
  // Full dispersion scatters every colour evenly across the picture, which
  // reads as static and, worse, removes all strategy: when every colour is
  // everywhere, the order you tackle them in never matters. Aiming each jewel
  // at a *target* number of same-coloured neighbours instead produces workable
  // clumps, so batches are worth carrying and a scarce colour stays in a few
  // identifiable places — which is what makes "clear the rare one first" a real
  // decision rather than a slogan.
  const ideal = clumpTarget(remaining.size);

  for (const cell of cells) {
    const target = level.target[cell] as ColourId;
    neighbours8(cell, level.width, level.height, scratch);

    let best: ColourId | null = null;
    let bestScore = Infinity;
    for (const [colour, left] of remaining) {
      if (left <= 0) continue;
      let adjacent = 0;
      for (const nb of scratch) if (jewels[nb] === colour) adjacent++;
      // Landing on your own target is disqualifying; after that, prefer the
      // colour whose local density is furthest from ideal, and among equals
      // spend the most plentiful so none is stranded at the end.
      const score =
        (colour === target ? 1000 : 0) + Math.abs(adjacent - ideal) * 8 - left * 0.02;
      if (score < bestScore) {
        bestScore = score;
        best = colour;
      }
    }
    if (best == null) break;
    jewels[cell] = best;
    remaining.set(best, (remaining.get(best) as number) - 1);
  }

  // Repair accidental pre-matches. A perfect derangement can be impossible
  // (a colour covering >half the picture must sit on itself somewhere), so we
  // reduce matches rather than demand zero.
  for (let pass = 0; pass < maxRepairPasses; pass++) {
    const matched = cells.filter((c) => jewels[c] === level.target[c]);
    if (matched.length === 0) break;
    let fixed = 0;
    for (const i of matched) {
      if (jewels[i] !== level.target[i]) continue;
      const offset = Math.floor(rand() * cells.length);
      for (let k = 0; k < cells.length; k++) {
        const j = cells[(offset + k) % cells.length] as number;
        if (j === i) continue;
        const ji = jewels[i] as ColourId;
        const jj = jewels[j] as ColourId;
        if (jj === level.target[i] || ji === level.target[j]) continue;
        jewels[i] = jj;
        jewels[j] = ji;
        fixed++;
        break;
      }
    }
    if (fixed === 0) break;
  }

  return jewels;
}

/**
 * How many same-coloured neighbours a jewel should aim to sit beside. A cell
 * has 8 neighbours, so a uniformly random board averages 8/colours; asking for
 * a little more than that yields visible clumps without letting one colour
 * percolate across the whole picture.
 */
function clumpTarget(colours: number): number {
  return Math.min(4, 8 / Math.max(2, colours) + 1.5);
}

export interface GeneratedLevel {
  readonly level: LevelSpec;
  readonly jewels: readonly (ColourId | null)[];
  readonly seed: number;
  readonly attempts: number;
  /** A recorded winning line. Certifies solvability and seeds the e2e test. */
  readonly trace: readonly Action[];
  readonly difficulty: DifficultyReport;
}

/**
 * The largest batch a single tap can lift. Because jewels only ever leave the
 * board to the shelf or settle permanently into a correct socket, the set of
 * liftable jewels only shrinks — so the opening position is the worst case.
 */
export function maxPickupBatch(state: GameState): number {
  let max = 0;
  for (const r of pickupRegions(state)) max = Math.max(max, r.cells.length);
  return max;
}

/** No opening tap may leave the player with no legal move. */
export function everyOpeningTapSurvives(state: GameState): boolean {
  for (const region of pickupRegions(state)) {
    const step = reduce(state, { type: 'pickup', cell: region.rep });
    if (!step) continue;
    if (status(step.state) === 'stuck') return false;
  }
  return true;
}

export interface GenerateOptions {
  readonly seed?: number;
  readonly attempts?: number;
  readonly budget?: number;
  readonly allowLiftCorrect?: boolean;
  /** Skip the (expensive) binary search for minimum capacity. */
  readonly measureCapacity?: boolean;
}

/**
 * Scramble until the solver returns a winning trace. We ship no board without
 * one, so an unsolvable level cannot reach a player.
 */
export function generate(level: LevelSpec, opts: GenerateOptions = {}): GeneratedLevel {
  const baseSeed = opts.seed ?? 1;
  const attempts = opts.attempts ?? 24;
  const budget = opts.budget ?? 20_000;
  const measureCapacity = opts.measureCapacity ?? true;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const seed = baseSeed + attempt * 7919;
    const jewels = scramble(level, seed);
    const state = createState(level, jewels, {
      allowLiftCorrect: opts.allowLiftCorrect ?? false,
    });

    // Check the property we actually care about rather than a proxy for it:
    // a player taps before they understand the board, so no opening tap may
    // leave them with nothing to do.
    if (!everyOpeningTapSurvives(state)) continue;

    const result = solve(state, { budget });
    if (!result.solved) continue;

    const minCap = measureCapacity ? minimumCapacity(state) : level.initialCapacity;
    return {
      level,
      jewels,
      seed,
      attempts: attempt + 1,
      trace: result.trace,
      difficulty: scoreDifficulty(state, {
        minCapacity: minCap,
        peakShelf: result.peakShelf,
      }),
    };
  }

  throw new Error(
    `${level.id}: no solvable scramble in ${attempts} attempts — ` +
      `raise initialCapacity (${level.initialCapacity}) or simplify the art`,
  );
}

export function stateFrom(gen: GeneratedLevel, allowLiftCorrect = false): GameState {
  return createState(gen.level, gen.jewels, { allowLiftCorrect });
}
