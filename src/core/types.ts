/** Index into a level's palette. */
export type ColourId = number;

/** A cell index into the flat row-major arrays. */
export type CellIndex = number;

export interface LevelSpec {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** Hex colours, indexed by ColourId. */
  readonly palette: readonly string[];
  /**
   * Target colour per cell, row-major. `null` means the cell is masked out —
   * it is not part of the picture and holds nothing, ever.
   */
  readonly target: readonly (ColourId | null)[];
  readonly initialCapacity: number;
  readonly growthPerColour: number;
  readonly maxCapacity: number;
}

export interface GameState {
  readonly level: LevelSpec;
  /**
   * Current occupant per cell, row-major and parallel to `level.target`.
   * `null` means an empty socket (or a masked cell, which is always null).
   */
  readonly jewels: readonly (ColourId | null)[];
  readonly shelf: readonly ColourId[];
  readonly capacity: number;
  /** Colours whose every target cell is correctly filled. Drives capacity growth. */
  readonly completedColours: readonly ColourId[];
  /**
   * When false, correctly-seated jewels can never be lifted, so progress is
   * monotone. Load-bearing enough to playtest both ways — see PLAN.md §8.
   */
  readonly allowLiftCorrect: boolean;
  readonly moves: number;
}

export type Action =
  /** Send a selected batch to the shelf. */
  | { readonly type: 'pickup'; readonly cell: CellIndex }
  /** Pour a colour off the shelf into an empty matching region. */
  | { readonly type: 'place'; readonly cell: CellIndex }
  /**
   * Carry a batch straight from one part of the board to its matching empty
   * sockets, never touching the shelf. This is what makes the buffer a choice
   * rather than a toll: once you have opened any hole, you can route around it.
   */
  | { readonly type: 'move'; readonly from: CellIndex; readonly to: CellIndex };

export type Status = 'playing' | 'won' | 'stuck';

/**
 * What a single action actually did. The renderer turns this into animation;
 * the core never mentions time.
 */
export interface MoveEffect {
  readonly kind: 'pickup' | 'place' | 'move';
  readonly colour: ColourId;
  /**
   * Cells affected, in BFS wavefront order from the tapped cell: the source
   * for a pickup, the destination for a place or a move.
   */
  readonly cells: readonly CellIndex[];
  /** Board cells the jewels departed from. Only populated for a move. */
  readonly fromCells: readonly CellIndex[];
  /** Shelf slot index each cell's jewel occupied / came to occupy. Empty for a move. */
  readonly slots: readonly number[];
  /** Colours completed by this move (may be empty). */
  readonly completed: readonly ColourId[];
  readonly capacityBefore: number;
  readonly capacityAfter: number;
}
