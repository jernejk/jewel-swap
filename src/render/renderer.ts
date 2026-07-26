import type { ColourId, GameState, MoveEffect } from '../core/types';
import { hexToRgb } from '../gen/ciede2000';
import {
  arc,
  clamp01,
  easeInOutQuad,
  easeOutBack,
  easeOutCubic,
  stagger,
  type Point,
} from './tweens';

/**
 * Shape carries the colour information for anyone who cannot rely on hue.
 * Chosen for silhouette contrast rather than prettiness — a circle, a triangle
 * and a square stay distinguishable at 20px on a phone; twelve pretty glyphs do not.
 */
const ACCENT = '#7be0c0';

const GLYPHS = ['●', '▲', '■', '◆', '★', '✚', '▼', '⬢', '◗', '✦', '⬒', '⬔'] as const;

export type SymbolMode = 'off' | 'on';

export interface Layout {
  readonly board: { x: number; y: number; w: number; h: number; cell: number };
  readonly shelf: { x: number; y: number; w: number; h: number; slot: number; cols: number };
}

interface Flying {
  colour: ColourId;
  from: Point;
  to: Point;
  delay: number;
  duration: number;
  kind: 'pickup' | 'place';
  cell: number;
  slot: number;
  index: number;
  batch: number;
  start: number;
  soundPlayed: boolean;
}

interface Shimmer {
  colour: ColourId;
  start: number;
}

export interface RenderCallbacks {
  onLand(kind: 'pickup' | 'place', indexInBatch: number, total: number): void;
}

/**
 * Timings are deliberately unhurried. At a 34ms stagger the batch read as one
 * blurred event rather than a countable sequence — you could tell something had
 * moved but not what, or how many. Wider spacing turns each jewel into its own
 * beat, which is the satisfying part and the part a distractible brain can
 * actually follow. Slower is also more legible: you can see *which* sockets
 * filled without replaying it in your head.
 */
const PICKUP_MS = 420;
const PLACE_MS = 400;
const STAGGER_MS = 108;
/** Long batches would otherwise crawl, so the stagger eases off as they grow. */
const STAGGER_MIN_MS = 48;
const STAGGER_FALLOFF = 8;
const SLIDE_MS = 320;
const SHIMMER_MS = 1600;
const UNLOCK_MS = 760;
/** Reference size for cached jewel sprites; blitted scaled to the real cell. */
const SPRITE_PX = 96;
const WIN_MS = 1900;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private state: GameState;
  private layout: Layout | null = null;
  private flying: Flying[] = [];
  private shimmers: Shimmer[] = [];
  private slideFrom = new Map<number, { x: number; start: number }>();
  private suppressCells = new Set<number>();
  private suppressSlots = new Set<number>();
  private shake: { cell: number; start: number } | null = null;
  private winStart: number | null = null;
  private sparkles: { x: number; y: number; vx: number; vy: number; born: number; hue: string }[] = [];
  private unlocks: { slot: number; start: number }[] = [];
  private hintCell: number | null = null;
  private selection: { cells: ReadonlySet<number>; colour: ColourId; onShelf: boolean } | null =
    null;
  private targets: ReadonlySet<number> = new Set();
  /** One pre-rendered jewel per colour, blitted scaled. See `jewelSprite`. */
  private sprites = new Map<ColourId, HTMLCanvasElement>();
  private shadowSprite: HTMLCanvasElement | null = null;
  private socketSprite: HTMLCanvasElement | null = null;
  symbols: SymbolMode = 'off';
  reducedMotion = false;

  constructor(
    private canvas: HTMLCanvasElement,
    state: GameState,
    private callbacks: RenderCallbacks,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.state = state;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  private scale(ms: number): number {
    return this.reducedMotion ? 1 : ms;
  }

  /**
   * When the nth jewel of a batch sets off. The gap starts wide so each one
   * lands as its own beat, then decays toward a floor — a twenty-four jewel
   * batch at a flat 82ms would take two seconds to finish pouring.
   */
  private batchDelay(index: number): number {
    let total = 0;
    for (let k = 0; k < index; k++) {
      total += Math.max(STAGGER_MIN_MS, STAGGER_MS - k * STAGGER_FALLOFF);
    }
    return this.scale(total);
  }

  setState(state: GameState): void {
    this.state = state;
  }

  /**
   * Draw each jewel once into an offscreen canvas, then blit it scaled.
   *
   * The previous code built a fresh `createLinearGradient` for every jewel on
   * every frame — over six hundred gradient objects per frame on a 25x25 board.
   * A laptop absorbs that; a phone does not, which is exactly where the stutter
   * showed up. Gradients, arcs and the specular highlight are all baked in here
   * once per colour, so the per-frame cost collapses to a single drawImage.
   *
   * Rendered generously large so scaling up for big cells stays crisp.
   */
  private jewelSprite(colour: ColourId): HTMLCanvasElement {
    const cached = this.sprites.get(colour);
    if (cached) return cached;

    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const px = Math.round(SPRITE_PX * dpr);
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const hex = this.state.level.palette[colour] as string;
    const r = px / 2;

    ctx.beginPath();
    ctx.arc(r, r, r, 0, Math.PI * 2);
    const grad = ctx.createLinearGradient(r, 0, r, px);
    grad.addColorStop(0, shade(hex, 0.3));
    grad.addColorStop(0.5, hex);
    grad.addColorStop(1, shade(hex, -0.26));
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.save();
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.beginPath();
    ctx.ellipse(r - r * 0.34, r - r * 0.4, r * 0.4, r * 0.26, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    this.sprites.set(colour, canvas);
    return canvas;
  }

  /**
   * The empty-socket recess, baked once. It is pure black alpha and therefore
   * colour-independent, so a single sprite serves every socket on the board —
   * which matters because a freshly scrambled board is mostly empty sockets
   * once play starts, and this was rebuilding a gradient for each one, each frame.
   */
  private socketRecess(): HTMLCanvasElement {
    if (this.socketSprite) return this.socketSprite;
    const px = 64;
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const grad = ctx.createRadialGradient(px / 2, px / 2, px * 0.08, px / 2, px / 2, px * 0.55);
    grad.addColorStop(0, 'rgba(0,0,0,0.26)');
    grad.addColorStop(1, 'rgba(0,0,0,0.04)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, px, px);
    this.socketSprite = canvas;
    return canvas;
  }

  /**
   * The contact shadow, baked once. It used to be an ellipse drawn under a
   * `ctx.filter = 'blur(1px)'`, and a canvas filter forces a separate
   * compositing pass per call — the single most expensive thing in the frame
   * on mobile. A pre-blurred radial gradient looks the same and costs nothing.
   */
  private contactShadow(): HTMLCanvasElement {
    if (this.shadowSprite) return this.shadowSprite;
    const px = 64;
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const grad = ctx.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
    grad.addColorStop(0, 'rgba(0,0,0,0.42)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.20)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, px, px);
    this.shadowSprite = canvas;
    return canvas;
  }

  reset(state: GameState): void {
    this.state = state;
    // Palettes are per level, so cached sprites are only valid for one board.
    this.sprites.clear();
    this.socketSprite = null;
    this.flying = [];
    this.shimmers = [];
    this.slideFrom.clear();
    this.suppressCells.clear();
    this.suppressSlots.clear();
    this.sparkles = [];
    this.winStart = null;
    this.shake = null;
    this.hintCell = null;
    this.unlocks = [];
    this.selection = null;
    this.targets = new Set();
  }

  setHint(cell: number | null): void {
    this.hintCell = cell;
  }

  /**
   * What is picked up and where it may go. Showing the destinations is the
   * whole point of a selection model — without them the player is guessing
   * which sockets are connected to which.
   */
  setSelection(
    selection: { cells: ReadonlySet<number>; colour: ColourId; onShelf: boolean } | null,
    targets: ReadonlySet<number> = new Set(),
  ): void {
    this.selection = selection;
    this.targets = targets;
  }

  get busy(): boolean {
    return this.flying.length > 0;
  }

  /** Snap every in-flight jewel home. Undo and restart must never fight an animation. */
  finishAnimations(): void {
    this.flying = [];
    this.suppressCells.clear();
    this.suppressSlots.clear();
    this.slideFrom.clear();
  }

  rejectTap(cell: number): void {
    this.shake = { cell, start: performance.now() };
  }

  triggerWin(): void {
    this.winStart = performance.now();
    const l = this.layout;
    if (!l || this.reducedMotion) return;
    for (let i = 0; i < 90; i++) {
      const angle = (i / 90) * Math.PI * 2 + Math.random();
      const speed = 40 + Math.random() * 140;
      const colour = this.state.level.palette[i % this.state.level.palette.length] as string;
      this.sparkles.push({
        x: l.board.x + l.board.w / 2,
        y: l.board.y + l.board.h / 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 40,
        born: this.winStart,
        hue: colour,
      });
    }
  }

  /**
   * Turns a move's effect into motion. The core has already jumped to the new
   * state; everything here is presentation, so tests never wait on it.
   */
  applyEffect(effect: MoveEffect, shelfBefore: readonly ColourId[]): void {
    const l = this.layout;
    if (!l) return;
    const now = performance.now();

    if (effect.kind === 'move') {
      effect.cells.forEach((cell, i) => {
        const from = effect.fromCells[i] as number;
        this.suppressCells.add(cell);
        this.flying.push({
          colour: effect.colour,
          from: this.cellCentre(from),
          to: this.cellCentre(cell),
          delay: this.batchDelay(i),
          duration: this.scale(PLACE_MS),
          kind: 'place',
          cell,
          slot: -1,
          index: i,
          batch: effect.cells.length,
          start: now,
          soundPlayed: false,
        });
      });
      for (const colour of effect.completed) {
        this.shimmers.push({ colour, start: now });
        this.celebrateColour(colour);
      }
      this.unlockSlots(effect.capacityBefore, effect.capacityAfter, now);
      return;
    }

    if (effect.kind === 'pickup') {
      effect.cells.forEach((cell, i) => {
        const slot = effect.slots[i] as number;
        this.suppressSlots.add(slot);
        this.flying.push({
          colour: effect.colour,
          from: this.cellCentre(cell),
          to: this.slotCentre(slot),
          delay: this.batchDelay(i),
          duration: this.scale(PICKUP_MS),
          kind: 'pickup',
          cell,
          slot,
          index: i,
          batch: effect.cells.length,
          start: now,
          soundPlayed: false,
        });
      });
    } else {
      effect.cells.forEach((cell, i) => {
        const slot = effect.slots[i] as number;
        this.suppressCells.add(cell);
        this.flying.push({
          colour: effect.colour,
          from: this.slotCentre(slot),
          to: this.cellCentre(cell),
          delay: this.batchDelay(i),
          duration: this.scale(PLACE_MS),
          kind: 'place',
          cell,
          slot,
          index: i,
          batch: effect.cells.length,
          start: now,
          soundPlayed: false,
        });
      });
      // The shelf compacts when jewels leave; slide the survivors rather than
      // letting them teleport left.
      const removed = new Set(effect.slots);
      let newIndex = 0;
      for (let old = 0; old < shelfBefore.length; old++) {
        if (removed.has(old)) continue;
        if (old !== newIndex) {
          this.slideFrom.set(newIndex, { x: this.slotCentre(old).x, start: now });
        }
        newIndex++;
      }
    }

    for (const colour of effect.completed) {
      this.shimmers.push({ colour, start: now });
      this.celebrateColour(colour);
    }
    this.unlockSlots(effect.capacityBefore, effect.capacityAfter, now);
  }

  /**
   * Newly earned tray slots pop in one after another, timed to land just after
   * the colour sweep that paid for them. Earning room is the only reward the
   * game has, so the payout should be visible rather than a silent state change.
   */
  private unlockSlots(before: number, after: number, now: number): void {
    for (let slot = before; slot < after; slot++) {
      this.unlocks.push({
        slot,
        start: now + this.scale(340 + (slot - before) * 110),
      });
    }
  }

  /** Progress of a slot's unlock pop: 0 before it starts, null once settled. */
  private unlockProgress(now: number, slot: number): number | null {
    for (const u of this.unlocks) {
      if (u.slot !== slot) continue;
      const t = (now - u.start) / this.scale(UNLOCK_MS);
      if (t < 0) return 0;
      if (t <= 1) return t;
    }
    return null;
  }

  // ---- geometry -----------------------------------------------------------

  private computeLayout(): Layout {
    const dpr = window.devicePixelRatio || 1;
    // Measure the stage, never the canvas. Reading a box you also write to is
    // how the runaway-height bug happened; the stage is laid out by flex alone.
    const stage = this.canvas.parentElement ?? this.canvas;
    // Third guard, and the one that holds even if the DOM misbehaves: never
    // lay out a board taller than the window can show, no matter what the
    // element claims its height is. The shelf is drawn relative to `cssH`, so
    // an inflated value is precisely what walks it off the bottom of the screen.
    const limitH = Math.max(1, Math.floor(window.visualViewport?.height ?? window.innerHeight));
    const cssW = Math.max(1, Math.min(Math.floor(stage.clientWidth), window.innerWidth));
    const cssH = Math.max(1, Math.min(Math.floor(stage.clientHeight), limitH));

    const wantW = Math.round(cssW * dpr);
    const wantH = Math.round(cssH * dpr);
    if (this.canvas.width !== wantW || this.canvas.height !== wantH) {
      this.canvas.width = wantW;
      this.canvas.height = wantH;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { level } = this.state;
    const pad = Math.max(10, cssW * 0.035);
    const cols = Math.min(12, Math.max(6, this.state.level.maxCapacity));
    const shelfRows = Math.ceil(level.maxCapacity / cols);

    // Reserve the shelf first — it must never be squeezed off-screen on a short
    // viewport, because a shelf you cannot see is a game you cannot play.
    const maxSlot = Math.min(38, (cssW - pad * 2 - (cols + 1) * 4) / cols);
    const shelfH = shelfRows * (maxSlot + 8) + 14;

    const availH = cssH - shelfH - pad * 3;
    const availW = cssW - pad * 2;
    const cell = Math.floor(Math.min(availW / level.width, availH / level.height));
    const boardW = cell * level.width;
    const boardH = cell * level.height;
    const boardX = (cssW - boardW) / 2;
    const boardY = Math.max(pad, (availH - boardH) / 2 + pad);

    const shelfW = cols * maxSlot + (cols + 1) * 4;
    return {
      board: { x: boardX, y: boardY, w: boardW, h: boardH, cell },
      shelf: {
        x: (cssW - shelfW) / 2,
        y: cssH - shelfH - pad,
        w: shelfW,
        h: shelfH,
        slot: maxSlot,
        cols,
      },
    };
  }

  cellCentre(index: number): Point {
    const l = this.layout ?? this.computeLayout();
    const { width } = this.state.level;
    const x = index % width;
    const y = (index / width) | 0;
    return {
      x: l.board.x + x * l.board.cell + l.board.cell / 2,
      y: l.board.y + y * l.board.cell + l.board.cell / 2,
    };
  }

  slotCentre(index: number): Point {
    const l = this.layout ?? this.computeLayout();
    const { cols, slot } = l.shelf;
    const col = index % cols;
    const row = (index / cols) | 0;
    return {
      x: l.shelf.x + 4 + col * (slot + 4) + slot / 2,
      y: l.shelf.y + 10 + row * (slot + 8) + slot / 2,
    };
  }

  /** Slot index under the point, or -1 for the tray but not a slot, null if outside. */
  hitTestShelf(px: number, py: number): number | null {
    const l = this.layout;
    if (!l) return null;
    if (
      px < l.shelf.x - 10 ||
      px > l.shelf.x + l.shelf.w + 10 ||
      py < l.shelf.y - 8 ||
      py > l.shelf.y + l.shelf.h
    ) {
      return null;
    }
    for (let i = 0; i < this.state.capacity; i++) {
      const p = this.slotCentre(i);
      const half = l.shelf.slot * 0.62;
      if (Math.abs(px - p.x) <= half && Math.abs(py - p.y) <= half) return i;
    }
    return -1;
  }

  /** Nearest cell within a forgiving radius — dense grids need generous targets. */
  hitTestCell(px: number, py: number): number | null {
    const l = this.layout;
    if (!l) return null;
    const { cell } = l.board;
    const x = Math.floor((px - l.board.x) / cell);
    const y = Math.floor((py - l.board.y) / cell);
    const { width, height } = this.state.level;
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const index = y * width + x;
    return this.state.level.target[index] == null ? null : index;
  }

  // ---- drawing ------------------------------------------------------------

  draw(now: number): void {
    this.layout = this.computeLayout();
    const ctx = this.ctx;
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    ctx.clearRect(0, 0, cssW, cssH);

    this.retireFlying(now);

    const winT = this.winStart === null ? 0 : clamp01((now - this.winStart) / WIN_MS);

    this.drawBoard(now, winT);
    if (winT < 1) this.drawShelf(now);
    this.drawFlying(now);
    this.drawSparkles(now);
  }

  private retireFlying(now: number): void {
    const still: Flying[] = [];
    for (const f of this.flying) {
      const t = stagger(now, f.start, f.delay, f.duration);
      if (t >= 1) {
        if (f.kind === 'pickup') this.suppressSlots.delete(f.slot);
        else this.suppressCells.delete(f.cell);
        continue;
      }
      still.push(f);
    }
    this.flying = still;
  }

  private drawBoard(now: number, winT: number): void {
    const l = this.layout as Layout;
    const { level } = this.state;
    const { cell } = l.board;
    const gap = winT > 0 ? cell * 0.06 * (1 - easeInOutQuad(winT)) : cell * 0.06;
    // Lifted jewels are drawn in a second pass. Painted inline, the very next
    // cell would overdraw the shadow that makes them look raised.
    const raised: (() => void)[] = [];

    for (let i = 0; i < level.target.length; i++) {
      const target = level.target[i];
      if (target == null) continue;
      const cx = i % level.width;
      const cy = (i / level.width) | 0;
      let x = l.board.x + cx * cell;
      let y = l.board.y + cy * cell;

      if (this.shake && this.shake.cell === i) {
        const st = clamp01((now - this.shake.start) / 260);
        if (st >= 1) this.shake = null;
        else x += Math.sin(st * Math.PI * 6) * 3 * (1 - st);
      }

      const targetHex = level.palette[target] as string;
      const jewel = this.suppressCells.has(i) ? null : this.state.jewels[i];

      // The socket is the answer key: it always shows the colour this cell
      // must end up as, which is why the game needs no instructions.
      this.roundRect(x + gap / 2, y + gap / 2, cell - gap, cell - gap, cell * 0.22);
      // Only lightly darkened. The socket's job is to state the target colour,
      // and a heavy recess was winning that argument — empty cells stopped
      // looking like the colour they are waiting for.
      this.ctx.fillStyle = jewel == null ? shade(targetHex, -0.1) : targetHex;
      this.ctx.fill();

      if (jewel == null) {
        // A recess, not a tile. A single dark band across the top read as a
        // brick — the cell looked disabled rather than open, which is bad for
        // the one state the whole move grammar depends on. An inset rim on all
        // four sides plus a darkened centre says "hole" instead.
        this.ctx.save();
        this.ctx.clip();
        this.ctx.drawImage(this.socketRecess(), x, y, cell, cell);
        this.ctx.strokeStyle = 'rgba(0,0,0,0.28)';
        this.ctx.lineWidth = Math.max(1, cell * 0.08);
        this.roundRect(x + gap / 2, y + gap / 2, cell - gap, cell - gap, cell * 0.22);
        this.ctx.stroke();
        this.ctx.restore();
        if (this.symbols === 'on') this.drawGlyph(x + cell / 2, y + cell / 2, cell * 0.4, target, 0.45);
      } else {
        const shim = this.shimmerAmount(now, jewel, cx);
        // Picked-up jewels physically rise off the board rather than merely
        // being outlined. Size and shadow are what read as "in hand" on a
        // phone; an outline is something you have to notice and decode.
        const picked =
          this.selection !== null && !this.selection.onShelf && this.selection.cells.has(i);
        const breathe = picked ? 0.02 * Math.sin(now / 340) : 0;
        const paint = (): void => {
          // A contact shadow cast onto the socket, rather than a glow around
          // the jewel. Grounding the shape is what makes it read as lifted;
          // a halo just reads as a highlight, which is why the earlier version
          // looked off even though the scale was doing its job.
          if (picked) {
            const sw = cell * 0.78;
            this.ctx.drawImage(
              this.contactShadow(),
              x + cell / 2 - sw / 2,
              y + cell / 2 + cell * 0.1 - sw * 0.28,
              sw,
              sw * 0.56,
            );
          }
          this.drawJewel(
            x + cell / 2,
            y + cell / 2 - (picked ? cell * 0.06 : 0),
            cell * (winT > 0 ? 1 - gap / cell : 0.78),
            jewel,
            1 + shim * 0.3 + (picked ? 0.16 : 0) + breathe,
            shim * 0.72,
          );
        };
        if (picked) raised.push(paint);
        else paint();
        if (shim > 0.02) {
          this.ctx.save();
          this.ctx.globalAlpha = shim * 0.85;
          this.ctx.strokeStyle = `rgba(255,255,255,${shim})`;
          this.ctx.lineWidth = Math.max(1.5, cell * 0.07);
          this.roundRect(x + gap / 2, y + gap / 2, cell - gap, cell - gap, cell * 0.22);
          this.ctx.stroke();
          this.ctx.restore();
        }
        if (this.symbols === 'on' && winT === 0) {
          this.drawGlyph(x + cell / 2, y + cell / 2, cell * 0.36, jewel, 0.7);
          // The jewel's own glyph is only half the information. What the player
          // has to judge is jewel *against* socket, so a mismatch also tags the
          // corner with the colour this cell is waiting for.
          if (jewel !== target) {
            this.drawCornerGlyph(x, y, cell, target);
          }
        }
      }

      const pulse = 0.5 + 0.5 * Math.sin(now / 260);

      // Where this batch may land. Without this the player is guessing which
      // sockets are 8-connected to which — the one thing the board cannot show.
      if (this.targets.has(i)) {
        this.ctx.save();
        this.ctx.strokeStyle = `rgba(255,255,255,${0.34 + pulse * 0.44})`;
        this.ctx.lineWidth = Math.max(2, cell * 0.1);
        this.roundRect(x + gap / 2, y + gap / 2, cell - gap, cell - gap, cell * 0.22);
        this.ctx.stroke();
        this.ctx.globalAlpha = 0.18 + pulse * 0.22;
        this.ctx.fillStyle = level.palette[target] as string;
        this.ctx.fill();
        this.ctx.restore();
      }

      // The lifted jewel now carries the message, so the socket outline is a
      // faint confirmation rather than the signal itself. Kept, not dropped:
      // it is the only cue that survives when a picked jewel sits next to a
      // same-coloured one, and size alone would be ambiguous there.
      if (this.selection && !this.selection.onShelf && this.selection.cells.has(i)) {
        this.ctx.save();
        this.ctx.strokeStyle = `rgba(123,224,192,${0.26 + pulse * 0.14})`;
        this.ctx.lineWidth = Math.max(1, cell * 0.05);
        this.roundRect(x + gap / 2, y + gap / 2, cell - gap, cell - gap, cell * 0.22);
        this.ctx.stroke();
        this.ctx.restore();
      }

      if (this.hintCell === i) {
        this.ctx.strokeStyle = `rgba(123,224,192,${0.55 + pulse * 0.45})`;
        this.ctx.lineWidth = Math.max(2, cell * 0.12);
        this.roundRect(x + gap / 2, y + gap / 2, cell - gap, cell - gap, cell * 0.22);
        this.ctx.stroke();
      }
    }

    for (const paint of raised) paint();
  }

  /**
   * A wave of light travelling left to right across every cell of the colour
   * that just finished. Sweeping rather than flashing everything at once makes
   * it read as one connected group — it shows you *which* colour you completed,
   * which is the information the moment is actually carrying.
   */
  private shimmerAmount(now: number, colour: ColourId, col: number): number {
    let best = 0;
    for (const s of this.shimmers) {
      if (s.colour !== colour) continue;
      const t = (now - s.start) / SHIMMER_MS;
      if (t < 0 || t > 1) continue;
      const wave = t * (this.state.level.width + 10) - 5;
      const d = Math.abs(col - wave);
      if (d < 4) best = Math.max(best, (1 - d / 4) * (1 - t * 0.25));
    }
    this.shimmers = this.shimmers.filter((s) => now - s.start < SHIMMER_MS);
    return best;
  }

  /** Sparkle burst over every cell of a colour that has just been finished. */
  private celebrateColour(colour: ColourId): void {
    if (this.reducedMotion) return;
    const now = performance.now();
    const hex = this.state.level.palette[colour] as string;
    const { target } = this.state.level;
    for (let i = 0; i < target.length; i++) {
      if (target[i] !== colour) continue;
      const p = this.cellCentre(i);
      for (let k = 0; k < 2; k++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 12 + Math.random() * 34;
        this.sparkles.push({
          x: p.x,
          y: p.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 26,
          born: now + (p.x / Math.max(1, this.layout?.board.w ?? 1)) * SHIMMER_MS * 0.7,
          hue: hex,
        });
      }
    }
  }

  private drawShelf(now: number): void {
    const l = this.layout as Layout;
    const ctx = this.ctx;

    // With a batch in hand the tray is always a legal destination — and at the
    // start of a level it is the *only* one, since the board has no holes yet.
    const trayOffered =
      this.selection !== null && !this.selection.onShelf && this.state.shelf.length < this.state.capacity;
    const pulse = 0.5 + 0.5 * Math.sin(now / 260);

    ctx.save();
    this.roundRect(l.shelf.x - 6, l.shelf.y - 4, l.shelf.w + 12, l.shelf.h, 16);
    ctx.fillStyle = trayOffered ? `rgba(255,255,255,${0.13 + pulse * 0.09})` : 'rgba(255,255,255,0.10)';
    ctx.fill();
    ctx.strokeStyle = trayOffered
      ? `rgba(123,224,192,${0.55 + pulse * 0.4})`
      : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = trayOffered ? 2 : 1;
    ctx.stroke();
    ctx.restore();

    this.unlocks = this.unlocks.filter((u) => now - u.start < this.scale(UNLOCK_MS));

    // Locked slots stay visible so the capacity reward is legible before it
    // arrives — you can see the room you are about to earn.
    for (let i = 0; i < this.state.level.maxCapacity; i++) {
      const p = this.slotCentre(i);
      const opening = this.unlockProgress(now, i);
      const unlocked = i < this.state.capacity && opening === null;
      const size = l.shelf.slot;

      if (opening !== null) {
        const t = easeOutBack(opening);
        const s = size * (0.35 + 0.65 * t);
        ctx.save();
        this.roundRect(p.x - s / 2, p.y - s / 2, s, s, s * 0.28);
        ctx.fillStyle = `rgba(123,224,192,${0.5 * (1 - opening) + 0.08})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(123,224,192,${0.9 * (1 - opening * 0.6)})`;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        continue;
      }

      this.roundRect(p.x - size / 2, p.y - size / 2, size, size, size * 0.28);
      ctx.fillStyle = unlocked ? 'rgba(0,0,0,0.20)' : 'rgba(0,0,0,0.07)';
      ctx.fill();
      if (!unlocked) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    this.state.shelf.forEach((colour, i) => {
      if (this.suppressSlots.has(i)) return;
      const p = this.slotCentre(i);
      let x = p.x;
      const slide = this.slideFrom.get(i);
      if (slide) {
        const t = clamp01((now - slide.start) / this.scale(SLIDE_MS));
        if (t >= 1) this.slideFrom.delete(i);
        else x = slide.x + (p.x - slide.x) * easeOutCubic(t);
      }
      const picked =
        this.selection !== null && this.selection.onShelf && this.selection.colour === colour;
      const lift = picked ? 1 + 0.08 * (0.5 + 0.5 * Math.sin(now / 260)) : 1;
      this.drawJewel(x, p.y, l.shelf.slot * 0.86 * lift, colour, 1);
      if (picked) {
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 2.5;
        this.roundRect(
          x - l.shelf.slot / 2,
          p.y - l.shelf.slot / 2,
          l.shelf.slot,
          l.shelf.slot,
          l.shelf.slot * 0.28,
        );
        ctx.stroke();
      }
      if (this.symbols === 'on') this.drawGlyph(x, p.y, l.shelf.slot * 0.42, colour, 0.7);
    });
  }

  private drawFlying(now: number): void {
    const l = this.layout as Layout;
    const size = Math.min(l.board.cell * 0.78, l.shelf.slot * 0.9);
    for (const f of this.flying) {
      const t = stagger(now, f.start, f.delay, f.duration);
      if (t <= 0) {
        // Not launched yet: hold it at the source so nothing visibly pops.
        this.drawJewel(f.from.x, f.from.y, size, f.colour, 1);
        continue;
      }
      const eased = easeOutCubic(t);
      const p = arc(f.from, f.to, eased, f.kind === 'pickup' ? 0.22 : 0.18);
      // Squash on arrival gives the landing weight; the lift gets a small pop.
      const settle = f.kind === 'place' ? 1 + 0.18 * (1 - easeOutBack(clamp01(t * 1.15))) : 1 + 0.15 * Math.sin(t * Math.PI);
      this.drawJewel(p.x, p.y, size * settle, f.colour, 1);

      if (!f.soundPlayed && t > 0.82) {
        f.soundPlayed = true;
        this.callbacks.onLand(f.kind, f.index, f.batch);
      }
    }
  }

  private drawSparkles(now: number): void {
    if (this.sparkles.length === 0) return;
    const ctx = this.ctx;
    this.sparkles = this.sparkles.filter((s) => now - s.born < 1600);
    for (const s of this.sparkles) {
      if (now < s.born) continue;
      const t = (now - s.born) / 1600;
      const x = s.x + s.vx * t * 1.6;
      const y = s.y + s.vy * t * 1.6 + 260 * t * t;
      ctx.globalAlpha = 1 - t;
      ctx.fillStyle = s.hue;
      ctx.beginPath();
      ctx.arc(x, y, 3.5 * (1 - t) + 1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Round jewel on a square socket. The shape difference is doing real work:
   * a circle never fills its cell, so the socket colour always shows as a ring
   * around it, and a mismatch reads as two colours in one cell without the
   * player having to compare anything. When jewel and socket agree the ring
   * vanishes into the jewel and the cell reads as one solid block — which is
   * why a finished picture looks finished.
   */
  private drawJewel(
    cx: number,
    cy: number,
    size: number,
    colour: ColourId,
    scale: number,
    flash = 0,
  ): void {
    const ctx = this.ctx;
    const d = size * scale;
    ctx.drawImage(this.jewelSprite(colour), cx - d / 2, cy - d / 2, d, d);

    if (flash > 0) {
      ctx.save();
      ctx.globalAlpha = flash;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawGlyph(cx: number, cy: number, size: number, colour: ColourId, alpha: number): void {
    const ctx = this.ctx;
    const hex = this.state.level.palette[colour] as string;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = luminance(hex) > 0.55 ? 'rgba(0,0,0,0.72)' : 'rgba(255,255,255,0.88)';
    ctx.font = `${Math.round(size)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GLYPHS[colour % GLYPHS.length] as string, cx, cy + size * 0.04);
    ctx.restore();
  }

  /** The target colour's glyph, tucked into the cell corner on the socket ring. */
  private drawCornerGlyph(x: number, y: number, cell: number, target: ColourId): void {
    const ctx = this.ctx;
    const size = cell * 0.3;
    const cx = x + size * 0.62;
    const cy = y + size * 0.6;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.56, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();
    ctx.fillStyle = this.state.level.palette[target] as string;
    ctx.font = `${Math.round(size)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(GLYPHS[target % GLYPHS.length] as string, cx, cy + size * 0.04);
    ctx.restore();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}

function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (v: number): number =>
    Math.round(amount > 0 ? v + (255 - v) * amount : v * (1 + amount));
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
