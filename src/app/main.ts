import {
  countOnShelf,
  emptyRegions,
  isLiftable,
  legalMoves,
  selectedBatch,
  status,
} from '../core/moves';
import { hydrate, reduce } from '../core/reducer';
import type { Action, GameState } from '../core/types';
import { generate, stateFrom, type GeneratedLevel } from '../gen/scramble';
import { LEVELS } from '../levels';
import { Sfx } from '../render/audio';
import { Renderer } from '../render/renderer';
import { findHint } from '../solver/solver';
import { Gallery } from './gallery';
import { isComplete, load, recordWin, save, saveProgress, type Save } from './store';

/** The cell an action points at, for shake feedback and hint highlighting. */
function anchorCell(action: Action): number {
  return action.type === 'move' ? action.from : action.cell;
}

class Game {
  private canvas = document.getElementById('canvas') as HTMLCanvasElement;
  private renderer: Renderer;
  private sfx = new Sfx();
  private prefs: Save = load();
  private gallery!: Gallery;
  private generated: GeneratedLevel;
  private state: GameState;
  private history: GameState[] = [];
  private levelIndex: number;
  private seed = 1;
  /** A win fires from refresh(), which runs on every action — record it once. */
  private recorded = false;
  private selection: {
    cells: ReadonlySet<number>;
    colour: number;
    onShelf: boolean;
    origin: number;
  } | null = null;

  constructor() {
    const saved = LEVELS.findIndex((l) => l.id === this.prefs.levelId);
    this.levelIndex = saved >= 0 ? saved : this.firstUnsolvedIndex();
    this.generated = this.build(this.levelIndex, this.seed);
    this.state = this.restoreOrFresh();
    this.renderer = new Renderer(this.canvas, this.state, {
      onLand: (kind, i, total) => {
        if (!this.prefs.sound) return;
        // Pitch climbs through the batch — the "counting" is half the reward.
        const pitch = 1 + (i / Math.max(1, total)) * 0.45;
        if (kind === 'pickup') this.sfx.tick(pitch);
        else {
          this.sfx.plop(pitch * (0.96 + Math.random() * 0.08));
          if (navigator.vibrate) navigator.vibrate(8);
        }
      },
    });
    this.renderer.symbols = this.prefs.symbols ? 'on' : 'off';
    this.gallery = new Gallery({
      levels: LEVELS,
      onPick: (id) => {
        const index = LEVELS.findIndex((l) => l.id === id);
        if (index >= 0) {
          this.gallery.hide();
          this.loadLevel(index, this.seed);
        }
      },
      onClose: () => this.gallery.hide(),
    });
    this.wire();
    this.refresh();
    requestAnimationFrame(this.frame);
  }

  /**
   * Resume the board exactly where it was left, if the save still refers to
   * this level and seed. Anything mismatched or malformed is ignored rather
   * than repaired — a wrong board is far worse than a fresh one.
   */
  private restoreOrFresh(): GameState {
    const saved = this.prefs.inProgress;
    const level = this.currentLevel;
    if (
      saved &&
      saved.levelId === level.id &&
      saved.seed === this.seed &&
      Array.isArray(saved.jewels) &&
      saved.jewels.length === level.target.length
    ) {
      try {
        return hydrate(level, saved.jewels, saved.shelf ?? [], saved.moves ?? 0);
      } catch {
        /* fall through to a fresh board */
      }
    }
    return stateFrom(this.generated);
  }

  /** Snapshot the live board so a crash or a swipe-away costs nothing. */
  private persistBoard(): void {
    const s = this.state;
    const finished = status(s) === 'won';
    this.prefs = saveProgress(
      this.prefs,
      finished || s.moves === 0
        ? null
        : {
            levelId: s.level.id,
            seed: this.seed,
            jewels: [...s.jewels],
            shelf: [...s.shelf],
            moves: s.moves,
          },
    );
  }

  private build(index: number, seed: number): GeneratedLevel {
    const level = LEVELS[index] as (typeof LEVELS)[number];
    return generate(level, { seed });
  }

  private wire(): void {
    const on = (id: string, fn: () => void): void => {
      const el = document.getElementById(id);
      el?.addEventListener('click', () => {
        this.sfx.unlock();
        fn();
      });
    };

    on('gallery-open', () => this.gallery.show(this.prefs, this.currentLevel.id));
    on('undo', () => this.undo());
    on('hint', () => this.hint());
    on('restart', () => this.restart());
    on('next', () => this.nextLevel());
    on('win-again', () => this.restart());
    on('win-next', () => this.nextLevel());
    on('win-gallery', () => {
      this.hideOverlay();
      this.gallery.show(this.prefs, this.currentLevel.id);
    });
    on('symbols', () => {
      this.prefs.symbols = !this.prefs.symbols;
      this.renderer.symbols = this.prefs.symbols ? 'on' : 'off';
      document
        .getElementById('symbols')
        ?.setAttribute('aria-pressed', String(this.prefs.symbols));
      save(this.prefs);
    });

    // Pointer, not touch/mouse: one path covers finger, pencil and trackpad.
    let downAt: { x: number; y: number } | null = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      this.sfx.unlock();
      downAt = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 12) return; // a drag, not a tap
      const rect = this.canvas.getBoundingClientRect();
      this.tap(e.clientX - rect.left, e.clientY - rect.top);
    });
    this.canvas.addEventListener('pointercancel', () => {
      downAt = null;
    });

    // Returning from another app can leave cached canvas pixels blank, and can
    // also suspend audio. Rebuild both on the way back in.
    const revive = (): void => {
      if (document.visibilityState !== 'visible') return;
      this.renderer.invalidateSprites();
      if (this.prefs.sound) this.sfx.unlock();
    };
    // Backgrounding is the most likely moment to be killed, so snapshot there
    // too — not only after each move.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.persistBoard();
    });
    window.addEventListener('pagehide', () => this.persistBoard());
    document.addEventListener('visibilitychange', revive);
    window.addEventListener('pageshow', revive);
    window.addEventListener('focus', revive);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'z' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.undo();
      } else if (e.key === 'h') this.hint();
      else if (e.key === 'r') this.restart();
    });
  }

  /**
   * Two taps: pick a batch up, then say where it goes. The destination can be
   * the shelf *or* matching sockets on the board, which is what makes the
   * buffer a tactical choice rather than a mandatory stop on every journey.
   */
  private tap(x: number, y: number): void {
    if (status(this.state) === 'won') return;

    const slot = this.renderer.hitTestShelf(x, y);
    if (slot !== null) {
      this.tapShelf(slot);
      return;
    }

    const cell = this.renderer.hitTestCell(x, y);
    if (cell == null) {
      // A tap that lands on nothing keeps the batch in hand. The board is
      // centred with dead space above and below it, and on a phone a thumb
      // clips those edges constantly — dropping the selection there felt like
      // the game letting go of something you were still holding.
      return;
    }

    const sel = this.selection;
    if (sel && this.state.jewels[cell] == null && this.state.level.target[cell] === sel.colour) {
      const action: Action = sel.onShelf
        ? { type: 'place', cell }
        : { type: 'move', from: sel.origin, to: cell };
      if (this.dispatch(action)) this.keepSelectionAlive(sel);
      return;
    }

    if (isLiftable(this.state, cell)) {
      // Tapping the same batch again puts it back down.
      if (sel && !sel.onShelf && sel.cells.has(cell)) this.clearSelection();
      else this.selectBoard(cell);
      return;
    }

    // A settled jewel, or an empty socket of the wrong colour: nothing to do,
    // and nothing to give up either.
    this.renderer.rejectTap(cell);
  }

  private tapShelf(slot: number): void {
    const sel = this.selection;
    // A batch in hand, tapped over the tray: that is where it wants to go.
    if (sel && !sel.onShelf) {
      if (this.dispatch({ type: 'pickup', cell: sel.origin })) this.clearSelection();
      return;
    }
    const colour = slot >= 0 ? this.state.shelf[slot] : undefined;
    // Empty slots and the tray's own background are not a "deselect" gesture.
    // Only tapping the same batch again puts it down.
    if (colour == null) return;
    if (sel && sel.onShelf && sel.colour === colour) this.clearSelection();
    else this.selectShelf(colour);
  }

  private selectBoard(cell: number, chime = true): void {
    const cells = new Set(selectedBatch(this.state, cell));
    const colour = this.state.jewels[cell] as number;
    this.selection = { cells, colour, onShelf: false, origin: cell };
    this.renderer.setSelection({ cells, colour, onShelf: false }, this.destinationsFor(colour));
    if (chime && this.prefs.sound) this.sfx.tick(1.2);
  }

  private selectShelf(colour: number, chime = true): void {
    this.selection = { cells: new Set(), colour, onShelf: true, origin: -1 };
    this.renderer.setSelection(
      { cells: new Set(), colour, onShelf: true },
      this.destinationsFor(colour),
    );
    if (chime && this.prefs.sound) this.sfx.tick(1.2);
  }

  /** Every empty socket waiting for this colour. */
  private destinationsFor(colour: number): Set<number> {
    const out = new Set<number>();
    for (const region of emptyRegions(this.state)) {
      if (region.colour !== colour) continue;
      for (const c of region.cells) out.add(c);
    }
    return out;
  }

  /**
   * A destination rarely swallows a whole batch, so hold on to what is left
   * rather than making the player re-select between every drop. Feeding one
   * pickup into four different regions should be four taps, not eight.
   */
  private keepSelectionAlive(previous: NonNullable<Game['selection']>): void {
    if (previous.onShelf) {
      if (countOnShelf(this.state, previous.colour) > 0) this.selectShelf(previous.colour, false);
      else this.clearSelection();
      return;
    }
    // Whatever survived of the original batch is still in hand.
    for (const cell of previous.cells) {
      if (this.state.jewels[cell] === previous.colour && isLiftable(this.state, cell)) {
        this.selectBoard(cell, false);
        return;
      }
    }
    this.clearSelection();
  }

  private clearSelection(): void {
    this.selection = null;
    this.renderer.setSelection(null);
  }

  dispatch(action: Action): boolean {
    const before = this.state;
    const step = reduce(before, action);
    if (!step) {
      this.renderer.rejectTap(anchorCell(action));
      if (this.prefs.sound) this.sfx.thud();
      return false;
    }
    this.history.push(before);
    this.state = step.state;
    this.renderer.setState(this.state);
    this.renderer.setHint(null);
    this.renderer.applyEffect(step.effect, before.shelf);
    if (step.effect.completed.length > 0 && this.prefs.sound) {
      setTimeout(() => this.sfx.chime(), 220);
    }
    this.refresh();
    this.persistBoard();
    return true;
  }

  private undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.renderer.finishAnimations();
    this.state = prev;
    this.renderer.reset(this.state);
    this.selection = null;
    this.hideOverlay();
    this.refresh();
    this.persistBoard();
  }

  private hint(): void {
    const move = findHint(this.state);
    if (!move) return;
    this.renderer.setHint(anchorCell(move));
    setTimeout(() => this.renderer.setHint(null), 2600);
  }

  private restart(): void {
    this.recorded = false;
    this.state = stateFrom(this.generated);
    this.history = [];
    this.selection = null;
    this.renderer.reset(this.state);
    this.hideOverlay();
    this.refresh();
  }

  private get currentLevel() {
    return LEVELS[this.levelIndex] as (typeof LEVELS)[number];
  }

  /** Levels are ordered by difficulty, so the first unsolved one is the next step up. */
  private firstUnsolvedIndex(): number {
    const i = LEVELS.findIndex((l) => !isComplete(this.prefs, l));
    return i >= 0 ? i : 0;
  }

  /**
   * Prefer the next picture the player has not finished, wrapping around, and
   * only fall back to the plain next index once everything is done.
   */
  private nextLevel(): void {
    for (let step = 1; step <= LEVELS.length; step++) {
      const candidate = (this.levelIndex + step) % LEVELS.length;
      if (!isComplete(this.prefs, LEVELS[candidate] as (typeof LEVELS)[number])) {
        this.loadLevel(candidate, this.seed);
        return;
      }
    }
    this.loadLevel((this.levelIndex + 1) % LEVELS.length, this.seed);
  }

  loadLevel(index: number, seed = 1): void {
    this.levelIndex = ((index % LEVELS.length) + LEVELS.length) % LEVELS.length;
    this.seed = seed;
    this.recorded = false;
    this.generated = this.build(this.levelIndex, seed);
    this.state = stateFrom(this.generated);
    this.history = [];
    this.selection = null;
    this.renderer.reset(this.state);
    this.prefs.levelId = this.currentLevel.id;
    save(this.prefs);
    this.hideOverlay();
    this.refresh();
    // Switching pictures abandons the old board deliberately; do not leave a
    // stale snapshot that would resurrect it later.
    this.persistBoard();
  }

  private refresh(): void {
    const s = status(this.state);
    const level = this.state.level;
    const title = document.getElementById('title');
    if (title) title.textContent = level.name;

    // Colours solved, not jewels remaining. Finishing a colour is the only
    // thing the game actually rewards — it is what grows the shelf — so that is
    // the number worth showing. "N left" also invited the reading that shelving
    // a jewel was progress, which it is not.
    const palette = new Set(level.target.filter((t) => t != null));
    const stats = document.getElementById('stats');
    if (stats) {
      stats.textContent = `${this.state.completedColours.length}/${palette.size} colours solved`;
    }

    (document.getElementById('undo') as HTMLButtonElement).disabled = this.history.length === 0;

    if (s === 'won') this.showWin();
  }

  private showWin(): void {
    if (this.recorded) return;
    this.recorded = true;
    this.renderer.triggerWin();
    if (this.prefs.sound) this.sfx.win();

    const previous = this.prefs.completed[this.currentLevel.id];
    this.prefs = recordWin(this.prefs, this.currentLevel, this.state.moves);
    const best = this.prefs.completed[this.currentLevel.id];
    const beatIt = previous !== undefined && best !== undefined && best.moves < previous.moves;

    const done = LEVELS.filter((l) => isComplete(this.prefs, l)).length;
    const sub = beatIt
      ? `${this.state.moves} moves — a new best. ${done}/${LEVELS.length} pictures finished.`
      : previous !== undefined
        ? `${this.state.moves} moves. Your best is ${best?.moves}. ${done}/${LEVELS.length} finished.`
        : `Finished in ${this.state.moves} moves. ${done}/${LEVELS.length} pictures finished.`;

    setTimeout(() => this.setOverlay(this.state.level.name, sub, 'Replay'), 1700);
  }

  private setOverlay(title: string, sub: string, againLabel: string): void {
    const t = document.getElementById('win-title');
    const s = document.getElementById('win-sub');
    const a = document.getElementById('win-again');
    if (t) t.textContent = title;
    if (s) s.textContent = sub;
    if (a) a.textContent = againLabel;
    document.getElementById('overlay')?.classList.add('show');
  }

  private hideOverlay(): void {
    document.getElementById('overlay')?.classList.remove('show');
  }

  private frame = (now: number): void => {
    this.renderer.draw(now);
    requestAnimationFrame(this.frame);
  };

  // ---- test hook ----------------------------------------------------------

  getState(): GameState {
    return this.state;
  }

  getSolution(): readonly Action[] {
    return this.generated.trace;
  }

  getDifficulty(): GeneratedLevel['difficulty'] {
    return this.generated.difficulty;
  }

  getLevelIds(): string[] {
    return LEVELS.map((l) => l.id);
  }

  getStatus(): ReturnType<typeof status> {
    return status(this.state);
  }

  getLegalMoves(): Action[] {
    return legalMoves(this.state);
  }

  /** Play the certified solution straight through. Used by the e2e test. */
  solve(): boolean {
    for (const action of this.generated.trace) {
      if (!this.dispatch(action)) return false;
    }
    return status(this.state) === 'won';
  }
}

const game = new Game();
(window as unknown as { __game: Game }).__game = game;

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
