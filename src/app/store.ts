import type { LevelSpec } from '../core/types';

const KEY = 'jewel-swap:v2';

export interface Completion {
  /** Fewest moves the player has finished this picture in. */
  readonly moves: number;
  /** Epoch millis of the most recent completion. */
  readonly at: number;
  readonly plays: number;
}

export interface Save {
  /** Keyed by level id, so reordering or inserting levels never loses progress. */
  completed: Record<string, Completion>;
  levelId: string | null;
  symbols: boolean;
  sound: boolean;
}

const DEFAULTS: Save = {
  completed: {},
  levelId: null,
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
