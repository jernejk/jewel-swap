import { bfsRegion } from './grid';
import type { Action, CellIndex, ColourId, GameState, Status } from './types';

export interface Region {
  readonly colour: ColourId;
  /** Canonical representative — the lowest cell index in the region. */
  readonly rep: CellIndex;
  readonly cells: readonly CellIndex[];
}

export function freeCapacity(state: GameState): number {
  return state.capacity - state.shelf.length;
}

export function isMismatched(state: GameState, cell: CellIndex): boolean {
  const jewel = state.jewels[cell];
  return jewel != null && jewel !== state.level.target[cell];
}

/** A jewel may be lifted if it is present, and mismatched unless we allow lifting correct ones. */
export function isLiftable(state: GameState, cell: CellIndex): boolean {
  const jewel = state.jewels[cell];
  if (jewel == null) return false;
  return state.allowLiftCorrect || jewel !== state.level.target[cell];
}

/**
 * The batch a pickup tap actually lifts: the 8-connected run of same-coloured
 * liftable jewels containing `cell`, in BFS order from the tap, truncated to
 * the shelf room available.
 *
 * Truncating rather than refusing an oversized region is deliberate — a tap
 * that visibly does *something* beats a tap that silently no-ops. On a
 * scrambled board those regions are enormous (diagonal adjacency lets one
 * colour percolate across the whole picture), so in practice almost every
 * early batch is truncated, and the shelf — not the artwork — sets its size.
 */
export function resolvePickup(state: GameState, cell: CellIndex): readonly CellIndex[] {
  const room = freeCapacity(state);
  if (room <= 0 || !isLiftable(state, cell)) return [];
  return selectedBatch(state, cell, room);
}

/**
 * The batch a tap selects: the 8-connected run of same-coloured liftable jewels
 * containing `cell`, in BFS order from the tap. Uncapped by default, because a
 * batch bound for the board rather than the shelf is limited only by how many
 * matching sockets are open.
 */
export function selectedBatch(
  state: GameState,
  cell: CellIndex,
  limit = Infinity,
): readonly CellIndex[] {
  if (!isLiftable(state, cell)) return [];
  const colour = state.jewels[cell] as ColourId;
  return bfsRegion(
    cell,
    state.level.width,
    state.level.height,
    (c) => state.jewels[c] === colour && isLiftable(state, c),
    limit,
  );
}

/**
 * A batch carried straight across the board. Both ends are capped by the other:
 * you move as many jewels as there are sockets waiting, and no more.
 */
export function resolveMove(
  state: GameState,
  from: CellIndex,
  to: CellIndex,
): { readonly source: readonly CellIndex[]; readonly dest: readonly CellIndex[] } {
  const empty = { source: [] as CellIndex[], dest: [] as CellIndex[] };
  if (!isLiftable(state, from)) return empty;
  const colour = state.jewels[from] as ColourId;
  if (state.jewels[to] != null || state.level.target[to] !== colour) return empty;

  const source = selectedBatch(state, from);
  const dest = emptyRun(state, to, colour);
  const n = Math.min(source.length, dest.length);
  if (n === 0) return empty;
  return { source: source.slice(0, n), dest: dest.slice(0, n) };
}

/** The 8-connected run of empty sockets of `colour` reachable from `cell`. */
export function emptyRun(
  state: GameState,
  cell: CellIndex,
  colour: ColourId,
  limit = Infinity,
): readonly CellIndex[] {
  return bfsRegion(
    cell,
    state.level.width,
    state.level.height,
    (c) => state.jewels[c] == null && state.level.target[c] === colour,
    limit,
  );
}

/**
 * The sockets a pour tap actually fills: the 8-connected run of empty sockets
 * whose target matches `cell`'s, limited by how many of that colour are on the
 * shelf. Placement is only ever onto empty matching sockets — to fix a wrong
 * cell you must lift its occupant first, which is the whole game.
 */
export function resolvePlace(state: GameState, cell: CellIndex): readonly CellIndex[] {
  const colour = state.level.target[cell];
  if (colour == null || state.jewels[cell] != null) return [];
  const available = countOnShelf(state, colour);
  if (available <= 0) return [];
  return emptyRun(state, cell, colour, available);
}

export function countOnShelf(state: GameState, colour: ColourId): number {
  let n = 0;
  for (const c of state.shelf) if (c === colour) n++;
  return n;
}

function regionsWhere(
  state: GameState,
  eligible: (cell: CellIndex) => boolean,
  colourOf: (cell: CellIndex) => ColourId | null,
): Region[] {
  const { width, height } = state.level;
  const total = width * height;
  const seen = new Uint8Array(total);
  const out: Region[] = [];
  for (let i = 0; i < total; i++) {
    if (seen[i] || !eligible(i)) continue;
    const colour = colourOf(i);
    if (colour == null) continue;
    const cells = bfsRegion(i, width, height, (c) => !seen[c] && eligible(c) && colourOf(c) === colour);
    for (const c of cells) seen[c] = 1;
    out.push({ colour, rep: i, cells });
  }
  return out;
}

/** Every distinct liftable batch on the board, uncapped by shelf room. */
export function pickupRegions(state: GameState): Region[] {
  return regionsWhere(
    state,
    (c) => isLiftable(state, c),
    (c) => state.jewels[c] ?? null,
  );
}

/** Every distinct region of empty sockets, grouped by the colour it is waiting for. */
export function emptyRegions(state: GameState): Region[] {
  return regionsWhere(
    state,
    (c) => state.jewels[c] == null && state.level.target[c] != null,
    (c) => state.level.target[c] ?? null,
  );
}

/** Empty regions whose colour is currently sitting on the shelf. */
export function placeRegions(state: GameState): Region[] {
  return emptyRegions(state).filter((r) => countOnShelf(state, r.colour) > 0);
}

/** Board batches that have somewhere to go without the shelf. */
export function moveRegions(state: GameState): { from: Region; to: Region }[] {
  const empties = emptyRegions(state);
  const out: { from: Region; to: Region }[] = [];
  for (const from of pickupRegions(state)) {
    const to = empties.find((e) => e.colour === from.colour);
    if (to) out.push({ from, to });
  }
  return out;
}

/**
 * The single source of truth for legality. The solver, the hint system, the
 * stuck detector and the input highlighter all read through this one function.
 */
export function legalMoves(state: GameState): Action[] {
  const moves: Action[] = [];
  for (const r of placeRegions(state)) moves.push({ type: 'place', cell: r.rep });
  for (const m of moveRegions(state)) {
    moves.push({ type: 'move', from: m.from.rep, to: m.to.rep });
  }
  if (freeCapacity(state) > 0) {
    for (const r of pickupRegions(state)) moves.push({ type: 'pickup', cell: r.rep });
  }
  return moves;
}

export function isWon(state: GameState): boolean {
  const { target } = state.level;
  for (let i = 0; i < target.length; i++) {
    const t = target[i];
    if (t == null) continue;
    if (state.jewels[i] !== t) return false;
  }
  return true;
}

export function status(state: GameState): Status {
  if (isWon(state)) return 'won';
  return legalMoves(state).length === 0 ? 'stuck' : 'playing';
}

/** Colours whose every target cell is correctly filled. */
export function completedColours(state: GameState): ColourId[] {
  const remaining = new Set<ColourId>();
  const present = new Set<ColourId>();
  const { target } = state.level;
  for (let i = 0; i < target.length; i++) {
    const t = target[i];
    if (t == null) continue;
    present.add(t);
    if (state.jewels[i] !== t) remaining.add(t);
  }
  return [...present].filter((c) => !remaining.has(c)).sort((a, b) => a - b);
}
