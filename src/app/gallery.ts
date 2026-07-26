import { staticDifficulty } from '../gen/difficulty';
import type { ColourId, LevelSpec } from '../core/types';
import { isComplete, type Save } from './store';

const THUMB = 132;

/** Named difficulty bands. Dots alone made the reader decode an unlabelled scale. */
const BANDS = ['Gentle', 'Easy', 'Medium', 'Hard', 'Tough'] as const;

/**
 * The picture is the reward, so the gallery only shows it in colour once you
 * have finished it. Unsolved levels appear as a flat silhouette: enough to see
 * the shape and choose one, not enough to spoil the reveal.
 */
function drawThumb(canvas: HTMLCanvasElement, level: LevelSpec, revealed: boolean): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = THUMB * dpr;
  canvas.height = THUMB * dpr;
  canvas.style.width = `${THUMB}px`;
  canvas.style.height = `${THUMB}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, THUMB, THUMB);

  const cell = Math.max(1, Math.floor(Math.min(THUMB / level.width, THUMB / level.height)));
  const offX = (THUMB - cell * level.width) / 2;
  const offY = (THUMB - cell * level.height) / 2;
  const pad = cell > 5 ? 1 : 0;

  for (let i = 0; i < level.target.length; i++) {
    const target = level.target[i];
    if (target == null) continue;
    const x = offX + (i % level.width) * cell;
    const y = offY + ((i / level.width) | 0) * cell;
    ctx.fillStyle = revealed ? (level.palette[target as ColourId] as string) : 'rgba(255,255,255,0.16)';
    ctx.fillRect(x, y, cell - pad, cell - pad);
  }
}

export interface GalleryOptions {
  readonly levels: readonly LevelSpec[];
  readonly onPick: (levelId: string) => void;
  readonly onClose: () => void;
}

export class Gallery {
  private grid: HTMLElement;
  private summary: HTMLElement;
  private root: HTMLElement;
  /** Level id → 1-5. */
  private stars = new Map<string, number>();

  constructor(private opts: GalleryOptions) {
    this.rankDifficulty();
    this.root = document.getElementById('gallery') as HTMLElement;
    this.grid = document.getElementById('gallery-grid') as HTMLElement;
    this.summary = document.getElementById('gallery-summary') as HTMLElement;

    document.getElementById('gallery-close')?.addEventListener('click', () => opts.onClose());
    this.grid.addEventListener('click', (e) => {
      const tile = (e.target as HTMLElement).closest('[data-level]');
      if (tile) opts.onPick((tile as HTMLElement).dataset.level as string);
    });
    // Divs are not keyboard-activatable for free, so put that back.
    this.grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const tile = (e.target as HTMLElement).closest('[data-level]');
      if (!tile) return;
      e.preventDefault();
      opts.onPick((tile as HTMLElement).dataset.level as string);
    });
  }

  /**
   * Stars are a *relative* ranking, not a fixed scale. Absolute thresholds bunch
   * up — a set of similarly-sized pictures would all land on three stars and tell
   * the player nothing. Quintiles guarantee the gallery always spans one to five,
   * so the rating answers the only question being asked: harder or easier than
   * the others here?
   */
  private rankDifficulty(): void {
    const ranked = [...this.opts.levels]
      .map((l) => ({ id: l.id, d: staticDifficulty(l) }))
      .sort((a, b) => a.d - b.d);
    ranked.forEach((entry, i) => {
      const quintile = Math.floor((i / Math.max(1, ranked.length)) * 5);
      this.stars.set(entry.id, Math.min(5, quintile + 1));
    });
  }

  get visible(): boolean {
    return this.root.classList.contains('show');
  }

  show(save: Save, currentId: string): void {
    this.render(save, currentId);
    this.root.classList.add('show');
  }

  hide(): void {
    this.root.classList.remove('show');
  }

  render(save: Save, currentId: string): void {
    const done = this.opts.levels.filter((l) => isComplete(save, l)).length;
    this.summary.textContent = `${done} of ${this.opts.levels.length} pictures finished`;

    this.grid.replaceChildren();
    for (const level of this.opts.levels) {
      const revealed = isComplete(save, level);
      const best = save.completed[level.id];
      const colours = new Set(level.target.filter((t) => t != null)).size;

      // A div, not a button. A <button> used as a flex container does not size
      // to its own content in Chrome — the tile collapsed to a fraction of its
      // height and the thumbnails spilled over each other. Semantics are
      // restored with role/tabindex, and the grid already delegates clicks.
      const tile = document.createElement('div');
      tile.setAttribute('role', 'button');
      tile.tabIndex = 0;
      tile.className = `tile${revealed ? ' done' : ''}${level.id === currentId ? ' current' : ''}`;
      tile.dataset.level = level.id;
      tile.setAttribute(
        'aria-label',
        `${level.name}, ${revealed ? `finished in ${best?.moves} moves` : 'not yet finished'}`,
      );

      const canvas = document.createElement('canvas');
      drawThumb(canvas, level, revealed);
      tile.append(canvas);

      const name = document.createElement('span');
      name.className = 'tile-name';
      name.textContent = level.name;
      tile.append(name);

      const meta = document.createElement('span');
      meta.className = 'tile-meta';
      const stars = this.stars.get(level.id) ?? 3;
      meta.textContent = `${BANDS[stars - 1]} · ${level.width}×${level.height} · ${colours} colours`;
      tile.append(meta);

      // "unsolved" was redundant — every unfinished card is already a grey
      // silhouette and the header counts them. Only say something when there
      // is something to say.
      if (revealed) {
        const status = document.createElement('span');
        status.className = 'tile-best';
        status.textContent = `best ${best?.moves} moves`;
        tile.append(status);
      }

      this.grid.append(tile);
    }
  }
}
