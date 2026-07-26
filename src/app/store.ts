import type { LevelSpec } from '../core/types';

const KEY = 'jewel-swap:v2';

export interface Completion {
  /** Fewest moves the player has finished this picture in. */
  readonly moves: number;
  /** Epoch millis of the most recent completion. */
  readonly at: number;
  readonly plays: number;
}

/**
 * A board mid-solve. Stored as plain arrays rather than a GameState so the
 * format survives refactors of the core — everything else is recomputed on
 * load. Keyed by level id and seed so a stale board is never restored onto a
 * different puzzle.
 */
export interface InProgress {
  readonly levelId: string;
  readonly seed: number;
  readonly jewels: (number | null)[];
  readonly shelf: number[];
  readonly moves: number;
}

export interface Save {
  /** Keyed by level id, so reordering or inserting levels never loses progress. */
  completed: Record<string, Completion>;
  levelId: string | null;
  inProgress: InProgress | null;
  symbols: boolean;
  sound: boolean;
}

const DEFAULTS: Save = {
  completed: {},
  levelId: null,
  inProgress: null,
  symbols: false,
  sound: true,
};

/**
 * Progress is keyed by level id rather than index. Levels are sorted by
 * measured difficulty and new ones get added over time, so an index would
 * silently reassign someone's finished pictures to the wrong artwork.
 */
export function load(): Save {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, completed: {} };
    const parsed = JSON.parse(raw) as Partial<Save>;
    return {
      ...DEFAULTS,
      ...parsed,
      completed: parsed.completed ?? {},
    };
  } catch {
    // Private mode, quota, or a corrupt value written by an older build.
    // Losing progress is bad; refusing to start is worse.
    return { ...DEFAULTS, completed: {} };
  }
}

export function save(state: Save): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* nothing we can do, and nothing that should stop play */
  }
}

/**
 * Write only the in-progress board, merged onto whatever is currently stored.
 *
 * This fires on `pagehide`, and the app's in-memory copy can be older than
 * storage by then — blindly writing it back wiped completed pictures. Re-reading
 * first means a snapshot can never cost someone their finished levels, which is
 * the one thing in here that is genuinely painful to lose.
 */
export function saveProgress(state: Save, snapshot: InProgress | null): Save {
  const stored = load();
  const next: Save = {
    ...state,
    completed: { ...state.completed, ...stored.completed },
    inProgress: snapshot,
  };
  save(next);
  return next;
}

export function recordWin(state: Save, level: LevelSpec, moves: number): Save {
  const prior = state.completed[level.id];
  const next: Save = {
    ...state,
    completed: {
      ...state.completed,
      [level.id]: {
        moves: prior ? Math.min(prior.moves, moves) : moves,
        at: Date.now(),
        plays: (prior?.plays ?? 0) + 1,
      },
    },
    // A finished board is not worth resuming.
    inProgress: null,
  };
  save(next);
  return next;
}

export function isComplete(state: Save, level: LevelSpec): boolean {
  return state.completed[level.id] !== undefined;
}

export function completedCount(state: Save): number {
  return Object.keys(state.completed).length;
}
