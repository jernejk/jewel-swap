import {
  completedColours,
  countOnShelf,
  resolveMove,
  resolvePickup,
  resolvePlace,
} from './moves';
import type { Action, ColourId, GameState, LevelSpec, MoveEffect } from './types';

export interface CreateOptions {
  readonly allowLiftCorrect?: boolean;
}

export function createState(
  level: LevelSpec,
  jewels: readonly (ColourId | null)[],
  opts: CreateOptions = {},
): GameState {
  const base: GameState = {
    level,
    jewels,
    shelf: [],
    capacity: level.initialCapacity,
    completedColours: [],
    allowLiftCorrect: opts.allowLiftCorrect ?? false,
    moves: 0,
  };
  // A scramble may legitimately start with a colour already complete.
  return withDerived(base, base.shelf, base.jewels);
}

/**
 * Capacity is a pure function of how many colours are finished, so we always
 * recompute it rather than mutating a counter. That keeps it correct even when
 * `allowLiftCorrect` lets a completed colour come apart again.
 */
function withDerived(
  state: GameState,
  shelf: readonly ColourId[],
  jewels: readonly (ColourId | null)[],
): GameState {
  const next: GameState = { ...state, shelf, jewels };
  const done = completedColours(next);
  const grown =
    next.level.initialCapacity + done.length * next.level.growthPerColour;
  const capacity = Math.max(
    Math.min(grown, next.level.maxCapacity),
    shelf.length, // never strand jewels with nowhere to sit
  );
  return { ...next, completedColours: done, capacity };
}

/**
 * Rebuild a state from a stored board. Only the cells, the shelf and the move
 * count are persisted; capacity and completed colours are derived, so a save
 * cannot drift out of agreement with the rules that compute them.
 */
export function hydrate(
  level: LevelSpec,
  jewels: readonly (ColourId | null)[],
  shelf: readonly ColourId[],
  moves: number,
  opts: CreateOptions = {},
): GameState {
  const base: GameState = {
    level,
    jewels,
    shelf,
    capacity: level.initialCapacity,
    completedColours: [],
    allowLiftCorrect: opts.allowLiftCorrect ?? false,
    moves,
  };
  return withDerived(base, shelf, jewels);
}

export interface ReduceResult {
  readonly state: GameState;
  readonly effect: MoveEffect;
}

/**
 * Applies an action, or returns `null` if it is not legal. Pure and immutable —
 * state jumps instantly, and the renderer turns the returned effect into
 * animation. Nothing in here knows that time exists.
 */
export function reduce(state: GameState, action: Action): ReduceResult | null {
  switch (action.type) {
    case 'pickup':
      return pickup(state, action.cell);
    case 'place':
      return place(state, action.cell);
    case 'move':
      return carry(state, action.from, action.to);
  }
}

/** Board to board, bypassing the shelf entirely. */
function carry(state: GameState, from: number, to: number): ReduceResult | null {
  const { source, dest } = resolveMove(state, from, to);
  if (source.length === 0) return null;
  const colour = state.jewels[from] as ColourId;

  const jewels = state.jewels.slice();
  for (const c of source) jewels[c] = null;
  for (const c of dest) jewels[c] = colour;

  const next = withDerived({ ...state, moves: state.moves + 1 }, state.shelf, jewels);
  return {
    state: next,
    effect: {
      kind: 'move',
      colour,
      cells: dest,
      fromCells: source,
      slots: [],
      completed: newlyCompleted(state, next),
      capacityBefore: state.capacity,
      capacityAfter: next.capacity,
    },
  };
}

function pickup(state: GameState, cell: number): ReduceResult | null {
  const cells = resolvePickup(state, cell);
  if (cells.length === 0) return null;
  const colour = state.jewels[cell] as ColourId;

  const jewels = state.jewels.slice();
  for (const c of cells) jewels[c] = null;

  const shelf = state.shelf.slice();
  const slots: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    slots.push(shelf.length);
    shelf.push(colour);
  }

  const next = withDerived({ ...state, moves: state.moves + 1 }, shelf, jewels);
  return {
    state: next,
    effect: {
      kind: 'pickup',
      colour,
      cells,
      fromCells: [],
      slots,
      completed: newlyCompleted(state, next),
      capacityBefore: state.capacity,
      capacityAfter: next.capacity,
    },
  };
}

function place(state: GameState, cell: number): ReduceResult | null {
  const cells = resolvePlace(state, cell);
  if (cells.length === 0) return null;
  const colour = state.level.target[cell] as ColourId;
  if (countOnShelf(state, colour) < cells.length) return null;

  const jewels = state.jewels.slice();
  for (const c of cells) jewels[c] = colour;

  // Take from the shelf in slot order so the jewel that has waited longest
  // leaves first — the shelf visibly drains left-to-right.
  const slots: number[] = [];
  const shelf: ColourId[] = [];
  let taken = 0;
  for (let i = 0; i < state.shelf.length; i++) {
    const c = state.shelf[i] as ColourId;
    if (c === colour && taken < cells.length) {
      slots.push(i);
      taken++;
    } else {
      shelf.push(c);
    }
  }

  const next = withDerived({ ...state, moves: state.moves + 1 }, shelf, jewels);
  return {
    state: next,
    effect: {
      kind: 'place',
      colour,
      cells,
      fromCells: [],
      slots,
      completed: newlyCompleted(state, next),
      capacityBefore: state.capacity,
      capacityAfter: next.capacity,
    },
  };
}

function newlyCompleted(before: GameState, after: GameState): ColourId[] {
  const had = new Set(before.completedColours);
  return after.completedColours.filter((c) => !had.has(c));
}
