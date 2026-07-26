import {
  countOnShelf,
  emptyRegions,
  isLiftable,
  legalMoves,
  selectedBatch,
  status,
} from '../core/moves';
import { reduce } from '../core/reducer';
import type { Action, GameState } from '../core/types';
import { generate, stateFrom, type GeneratedLevel } from '../gen/scramble';
import { LEVELS } from '../levels';
import { Sfx } from '../render/audio';
import { Renderer } from '../render/renderer';
import { findHint } from '../solver/solver';

const STORE_KEY = 'jewel-swap:v1';

/** The cell an action points at, for shake feedback and hint highlighting. */
function anchorCell(action: Action): number {
  return action.type === 'move' ? action.from : action.cell;
}

interface Persisted {
  levelIndex: number;
  symbols: boolean;
  sound: boolean;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { levelIndex: 0, symbols: false, sound: true, ...JSON.parse(raw) };
  } catch {
    /* private mode, corrupt value — defaults are fine */
  }
  return { levelIndex: 0, symbols: false, sound: true };
}

function save(p: Persisted): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* nothing we can do, and nothing that matters */
  }
}

class Game {
  private canvas = document.getElementById('canvas') as HTMLCanvasElement;
  private renderer: Renderer;
  private sfx = new Sfx();
  private prefs = load();
  private generated: GeneratedLevel;
  private state: GameState;
  private history: GameState[] = [];
  private levelIndex: number;
  private seed = 1;
  private selection: {
    cells: ReadonlySet<number>;
    colour: number;
    onShelf: boolean;
    origin: number;
  } | null = null;

  constructor() {
    this.levelIndex = Math.min(this.prefs.levelIndex, LEVELS.length - 1);
    this.generated = this.build(this.levelIndex, this.seed);
    this.state = stateFrom(this.generated);
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
    this.wire();
    this.refresh();
    requestAnimationFrame(this.frame);
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

    on('undo', () => this.undo());
    on('hint', () => this.hint());
    on('restart', () => this.restart());
    on('next', () => this.nextLevel());
    on('win-again', () => this.restart());
    on('win-next', () => this.nextLevel());
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
      this.clearSelection();
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

    this.clearSelection();
  }

  private tapShelf(slot: number): void {
    const sel = this.selection;
    // A batch in hand, tapped over the tray: that is where it wants to go.
    if (sel && !sel.onShelf) {
      if (this.dispatch({ type: 'pickup', cell: sel.origin })) this.clearSelection();
      return;
    }
    const colour = slot >= 0 ? this.state.shelf[slot] : undefined;
    if (colour == null) {
      this.clearSelection();
      return;
    }
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
  }

  private hint(): void {
    const move = findHint(this.state);
    if (!move) return;
    this.renderer.setHint(anchorCell(move));
    setTimeout(() => this.renderer.setHint(null), 2600);
  }

  private restart(): void {
    this.state = stateFrom(this.generated);
    this.history = [];
    this.selection = null;
    this.renderer.reset(this.state);
    this.hideOverlay();
    this.refresh();
  }

  private nextLevel(): void {
    this.levelIndex = (this.levelIndex + 1) % LEVELS.length;
    this.loadLevel(this.levelIndex, this.seed);
  }

  loadLevel(index: number, seed = 1): void {
    this.levelIndex = ((index % LEVELS.length) + LEVELS.length) % LEVELS.length;
    this.seed = seed;
    this.generated = this.build(this.levelIndex, seed);
    this.state = stateFrom(this.generated);
    this.history = [];
    this.selection = null;
    this.renderer.reset(this.state);
    this.prefs.levelIndex = this.levelIndex;
    save(this.prefs);
    this.hideOverlay();
    this.refresh();
  }

  private refresh(): void {
    const s = status(this.state);
    const level = this.state.level;
    const title = document.getElementById('title');
    if (title) title.textContent = level.name;

    const remaining = level.target.reduce<number>(
      (n, t, i) => (t != null && this.state.jewels[i] !== t ? n + 1 : n),
      0,
    );
    const stats = document.getElementById('stats');
    if (stats) {
      stats.textContent = `${remaining} left · shelf ${this.state.shelf.length}/${this.state.capacity} · ${this.state.moves} moves`;
    }

    (document.getElementById('undo') as HTMLButtonElement).disabled = this.history.length === 0;

    if (s === 'won') this.showWin();
  }

  private showWin(): void {
    this.renderer.triggerWin();
    if (this.prefs.sound) this.sfx.win();
    this.prefs.levelIndex = (this.levelIndex + 1) % LEVELS.length;
    save(this.prefs);
    setTimeout(() => {
      this.setOverlay(
        this.state.level.name,
        `Finished in ${this.state.moves} moves.`,
        'Replay',
      );
    }, 1400);
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
