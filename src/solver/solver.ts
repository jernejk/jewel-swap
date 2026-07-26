import {
  legalMoves,
  isWon,
  freeCapacity,
  moveRegions,
  placeRegions,
  pickupRegions,
} from '../core/moves';
import { reduce } from '../core/reducer';
import type { Action, GameState } from '../core/types';

export interface SolveOptions {
  /** Hard ceiling on states expanded. A miss costs one regeneration; it is never wrong. */
  readonly budget?: number;
}

export interface SolveResult {
  readonly solved: boolean;
  readonly trace: readonly Action[];
  readonly nodes: number;
  /** Highest shelf occupancy reached along the winning line. Feeds difficulty. */
  readonly peakShelf: number;
}

/**
 * Greedy + bounded backtracking, deliberately not an exact search.
 *
 * A permutation of hundreds of cells against a 12-slot buffer is far too large
 * for BFS/IDA*, and we do not need optimality: we control generation, so the
 * solver's only job is to emit a *certificate* that a board is completable.
 * A false negative costs one rescramble; a false positive is impossible,
 * because we ship no board without a recorded winning trace.
 *
 * The search is small because only one decision genuinely branches. Placements
 * are unconditionally safe — every jewel poured lands on a socket that had to
 * receive that colour eventually, and (with `allowLiftCorrect` off) it can
 * never be disturbed again — so they are applied greedily with no branching.
 * The only real choice is *which region to lift next*.
 */
export function solve(initial: GameState, opts: SolveOptions = {}): SolveResult {
  const budget = opts.budget ?? 20_000;
  const seen = new Set<string>();
  let nodes = 0;
  let peakShelf = 0;

  /**
   * Apply every action that is unconditionally good, with no branching.
   *
   * Both pours and direct board-to-board moves land jewels on sockets that had
   * to receive that colour eventually, and (with `allowLiftCorrect` off) they
   * can never be disturbed again — so each strictly raises the number of
   * correctly-seated jewels and the loop must terminate. The only decision that
   * genuinely branches is which batch to send to the shelf.
   */
  function drainProgress(state: GameState, trace: Action[]): GameState {
    let cur = state;
    for (;;) {
      const pours = placeRegions(cur);
      if (pours.length > 0) {
        // Largest first: fewest actions, and it frees the most shelf soonest.
        let best = pours[0]!;
        for (const r of pours) if (r.cells.length > best.cells.length) best = r;
        const step = reduce(cur, { type: 'place', cell: best.rep });
        if (step) {
          trace.push({ type: 'place', cell: best.rep });
          cur = step.state;
          continue;
        }
      }

      const carries = moveRegions(cur);
      if (carries.length > 0) {
        const pick = carries[0]!;
        const action: Action = { type: 'move', from: pick.from.rep, to: pick.to.rep };
        const step = reduce(cur, action);
        if (step) {
          trace.push(action);
          cur = step.state;
          continue;
        }
      }
      return cur;
    }
  }

  function signature(state: GameState): string {
    return `${state.jewels.join(',')}|${[...state.shelf].sort((a, b) => a - b).join(',')}`;
  }

  function dfs(state: GameState, trace: Action[]): Action[] | null {
    if (nodes++ > budget) return null;
    const settled = drainProgress(state, trace);
    peakShelf = Math.max(peakShelf, settled.shelf.length);
    if (isWon(settled)) return trace;

    const key = signature(settled);
    if (seen.has(key)) return null;
    seen.add(key);

    if (freeCapacity(settled) <= 0) return null; // shelf jammed, dead end

    for (const cand of rankPickups(settled)) {
      const step = reduce(settled, { type: 'pickup', cell: cand });
      if (!step) continue;
      const branch = trace.slice();
      branch.push({ type: 'pickup', cell: cand });
      const won = dfs(step.state, branch);
      if (won) return won;
      if (nodes > budget) return null;
    }
    return null;
  }

  /**
   * One-ply lookahead: prefer the lift that opens the most immediately
   * pourable sockets, breaking ties toward smaller regions so shelf room is
   * spent sparingly.
   */
  function rankPickups(state: GameState): number[] {
    const scored = pickupRegions(state).map((r) => {
      const step = reduce(state, { type: 'pickup', cell: r.rep });
      let opened = 0;
      if (step) for (const p of placeRegions(step.state)) opened += p.cells.length;
      return { rep: r.rep, size: r.cells.length, opened };
    });
    scored.sort((a, b) => b.opened - a.opened || a.size - b.size || a.rep - b.rep);
    return scored.map((s) => s.rep);
  }

  const trace = dfs(initial, []);
  return {
    solved: trace !== null,
    trace: trace ?? [],
    nodes,
    peakShelf,
  };
}

/**
 * The next move on a winning line from wherever the player currently is.
 * Re-planned from live state rather than replayed from the stored trace, so it
 * stays correct after undo or after the player takes a different route.
 */
export function findHint(state: GameState, budget = 8_000): Action | null {
  if (isWon(state)) return null;
  const result = solve(state, { budget });
  if (result.solved && result.trace.length > 0) return result.trace[0] ?? null;
  // No proven line left — fall back to any legal move so the player is never stranded.
  return legalMoves(state)[0] ?? null;
}

/**
 * Smallest starting shelf capacity that still admits a solution, by binary
 * search over the solver. This is the dominant difficulty term: how close a
 * level runs to its own buffer limit.
 */
export function minimumCapacity(
  state: GameState,
  lo = 2,
  hi = state.level.initialCapacity,
): number {
  let best = hi + 1;
  let a = lo;
  let b = hi;
  while (a <= b) {
    const mid = (a + b) >> 1;
    const probe: GameState = {
      ...state,
      capacity: mid,
      level: { ...state.level, initialCapacity: mid },
    };
    if (solve(probe, { budget: 8_000 }).solved) {
      best = mid;
      b = mid - 1;
    } else {
      a = mid + 1;
    }
  }
  return best;
}
