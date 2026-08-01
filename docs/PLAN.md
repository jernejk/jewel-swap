# Jewel Swap — POC Plan

> Kept as written, before any code existed. The build diverged from it in
> places; the README describes what actually shipped.

A calm colour-permutation puzzle dressed as diamond painting. Clone of the verified
"Jewel Coloring" loop (pkg `color.number.paint.pixle.art.sort.jigsaw`), keeping the
mechanic, deliberately dropping the monetisation funnel, and improving on it.

Status: **plan only — no code yet.** Target: playable browser POC, headlessly testable.

---

## 1. Stack decision — CONFIRMED with one addition

**TypeScript + HTML5 Canvas 2D + Vite. Zero runtime dependencies. Vitest for unit
tests, Playwright for e2e.**

The brief's default is right, and no alternative beats it:

- Phaser/Pixi are overkill for ~700 rounded rects; Canvas 2D holds 60fps trivially
  and removes a dependency an agent would otherwise have to learn/debug.
- DOM/SVG per-cell would work but animation of 600+ nodes gets jankier than one
  canvas, and hit-testing a canvas grid is 5 lines of math.
- WebGL buys nothing at this scale and costs shader plumbing.

**The addition: a first-class test hook.** The app exposes `window.__game` with
`{ getState(), dispatch(action), loadLevel(id|spec, seed), solve() }`. This is not a
debug afterthought — it is the contract that lets Playwright/claude-in-chrome
*play the game to completion* (drive the solver, assert win) rather than
pixel-poking. Every e2e test drives through it; screenshots verify rendering
separately.

Audio: WebAudio-synthesised (filtered-noise plop, sine chime) — no asset pipeline,
no licensing, tuneable in code.

Persistence: `localStorage` (level progress, settings). No backend, fully offline.

## 2. Core architecture

Strict layering; the arrow of dependency points only downward:

```
app/      glue, screens, settings           (DOM allowed)
render/   canvas renderer + animation timeline (reads state, never mutates)
input/    pointer/keyboard → actions, hit-test, zoom/pan
solver/   greedy+backtrack solver, hint finder   (pure)
gen/      image → level pipeline, scramble, difficulty  (pure, runs in Node AND Worker)
core/     types, reducer, legal moves, win/fail, seeded RNG  (pure, zero DOM)
```

### core/ — the pure game

```ts
type ColourId = number;                       // index into level palette
interface Cell { target: ColourId; jewel: ColourId | null; }   // null = empty socket
interface Shelf { jewels: ColourId[]; capacity: number; }
interface GameState {
  cells: Cell[];              // flat, row-major; masked cells absent via level.mask
  shelf: Shelf;
  seed: number;               // all randomness via seeded mulberry32
  completedColours: Set<ColourId>;
  history: Action[];          // for undo/replay/share
}
type Action =
  | { type: 'pickup'; cell: number }          // lift batch to shelf
  | { type: 'place';  cell: number }          // pour matching colour from shelf
  | { type: 'undo' };
```

- `reduce(state, action): GameState` — pure, immutable (state is small; full
  snapshots for undo are fine, no structural sharing needed).
- `legalMoves(state): Action[]` — enumerates every legal pickup and place. This is
  the single source of truth for the solver, the hint system, the fail detector,
  and input highlighting. One function, four consumers.
- `status(state): 'playing' | 'won' | 'stuck'` — won = all cells matched (shelf
  empty follows automatically since jewels only place on matching sockets and the
  scramble is histogram-preserving); stuck = `legalMoves` empty.
- Determinism: every random choice goes through the seeded RNG in state. Same
  level + seed + action list ⇒ identical state. Enables replay, seed-share URLs,
  and solver/game equivalence tests.

Animations are **presentation-only**: core state jumps instantly on dispatch; the
renderer diffs old→new state and schedules tweens. The solver and tests never wait
on animation.

### Pinned rules (the brief leaves these ambiguous — decisions + why)

1. **Pickup batch = the 8-connected region of same-colour *mismatched* jewels
   containing the tapped cell, in BFS order from the tap, capped at free shelf
   capacity.**
   - Strict connectivity, not "near-but-unconnected": predictable > mysterious;
     players hate grabs they can't anticipate. (Original reportedly sometimes
     grabs unconnected neighbours — we treat that as a bug, not a feature.)
   - *Mismatched-only* — correctly-seated jewels are never lifted. This makes
     progress monotone (correct placements are permanent), which players
     experience as kindness and the solver experiences as a massively pruned
     search space. If the original allows regressing, ours is strictly friendlier;
     accept the divergence.
   - Cap-at-capacity instead of refusing an oversized region: partial pickup
     always leaves *something* to do and avoids "why did nothing happen" taps.
2. **Place = tap any empty socket whose colour is on the shelf; jewels of that
   colour pour from the shelf into the 8-connected region of empty matching
   sockets reachable from the tapped cell, BFS wavefront order, until the shelf
   runs out of that colour or the region is full.** Placement only onto empty
   matching sockets (matches observed behaviour); to fix a wrong cell you must
   first lift its occupant — that's the whole game.
3. **Shelf growth:** completing a colour grants +2 capacity (parameterised
   `growthPerColour`, cap `maxCapacity = 24`, initial 12 — mirrors the observed
   12 + locked second row of 12). Numbers are a tuning knob, not architecture.
4. **First move is always a pickup** — the board starts 100% full, so there are
   zero legal *placements* (brief nit: not "zero legal moves"; pickups are always
   legal while shelf has space).
5. **Stuck** = shelf full AND no shelf colour has a reachable empty matching
   socket AND no pickup possible (capacity 0 free). With free undo, stuck is a
   soft state — offer "undo to last safe point" and "restart", never a paywall.

## 3. Level generation — the real engineering

Pipeline (`gen/`), identical code in Node (build-time bundled levels) and a Web
Worker (bring-your-own-image):

1. **Quantise.** Source PNG → grid ≤ 32×32, transparent pixels = mask. Palette:
   accept pre-quantised pixel art as-is; for photos, median-cut in **Lab space**
   to K ≤ 10 colours. Merge any palette pair with CIEDE2000 ΔE < 20 (visual
   confusability floor); if the art demands closer colours, symbol badges
   force-on (see §6).
2. **De-noise.** Optional: reassign 1-px orphan cells to the majority
   Lab-nearest neighbour colour. Kept as a knob — isolated pixels are a
   legitimate difficulty ingredient, not always noise.
3. **Decompose.** Per colour: 8-connected components of the *target* image →
   component count, sizes, isolation stats. These drive both the pour mechanic
   and the difficulty metric.
4. **Scramble.** A permutation of the jewel multiset over cells (histogram
   preserved by construction) with constraints: (a) zero pre-matched cells at
   start (parameterisable `preMatchedPct` as an easing knob for early levels),
   (b) solvable per step 5. Method: random shuffle + local repair swaps to kill
   accidental matches; regenerate on solver rejection.
5. **Solvability certificate — greedy + bounded backtracking, not BFS/IDA\*.**
   - Why not exact search: state space is a permutation of ~600 items with a
     12-slot buffer; even with symmetry reduction, BFS/IDA* is hopeless and
     *unnecessary* — we control generation, so the solver's job is to emit a
     **certificate of solvability**, not an optimal solution.
   - Why greedy works here: the monotone rule set (pinned above) means the only
     real decision is *ordering* — which mismatched region to lift next, which
     shelf colour to pour where. Search over "next colour-region to lift"
     (branching ≈ number of mismatched regions, typically < 30), with a
     1-ply heuristic: prefer moves that (a) empty shelf colours, (b) complete
     colours (capacity growth), (c) expose large pourable regions. Depth-limited
     DFS with a 10k-node budget and memoisation on a coarse state signature
     (per-colour matched counts + shelf histogram).
   - Failure direction is safe: a false negative costs one regeneration; a false
     positive (shipping an unsolvable board) cannot happen because we only ship
     boards with a found solution trace. The trace is stored with the level and
     doubles as the hint source and the e2e "play to win" script.
   - **Minimum required capacity S\***: binary-search initial capacity over the
     solver (solver succeeds at S, fails at S−1). O(log 12) solver runs.
6. **Difficulty scalar** (0–100, weighted sum; weights are a calibration TODO,
   POC reports raw components alongside):
   - **Shelf tightness** `S*/S₀` — how close the level runs to the buffer limit.
     Dominant term; this is the mechanic's real pressure.
   - **Fragmentation** — Σ per-colour (components − 1), normalised by cell
     count. More disconnected regions = more pours = more shelf traffic.
   - **Isolated singletons** — count of 1-cell components (each forces a
     dedicated shelf visit).
   - **Colour confusability** — inverse mean CIEDE2000 over palette pairs that
     are *spatially adjacent* in the target image (confusable colours far apart
     don't hurt; adjacent ones cause misreads). CIEDE2000, never RGB distance.
   - **Cycle pressure** — build the colour-level digraph "scrambled jewels of
     colour A occupy sockets of colour B"; cycles in this multigraph force
     shelf buffering (A can't go home until B moves, …). Score = Σ (cycle
     length − 1) over the cycle decomposition. This is the permutation-structure
     term the brief asked for, lifted to colour classes where it actually binds.
7. **Iterate**: rescramble until the level lands in the target difficulty band
   for its campaign slot. Honest curve: levels are *ordered by measured
   difficulty*, and the number is shown to the player.

## 4. Feel — the taste calls

The genre is ASMR-adjacent; every choice below serves *calm with tactility*.

- **Pickup**: jewels lift in BFS order from the tap, 40ms stagger, scale
  1→1.15, quadratic-bezier arc to their shelf slot, ~260ms each,
  ease-out; a soft tick per jewel with pitch rising up the batch (the
  "counting" sound is half the satisfaction).
- **Pour**: reverse stream — shelf jewels fly out in the BFS wavefront order the
  region fills, 40ms stagger, landing squash-and-settle (scaleY 0.85→1 over
  80ms), plop with ±4% random pitch so 12 plops don't sound robotic, subtle
  socket flash on each landing.
- **Colour complete**: one shimmer sweep across that colour's cells + a single
  soft chime + new shelf slots slide in. No confetti, no modal, no "+50 coins".
- **Win**: the reveal is the reward — grid lines and sockets fade over ~1.2s,
  cells blend to the true artwork, gentle sparkle particles, then a beat of
  silence with the finished picture. Exportable (see §5).
- **Input on a dense grid**: hit-test = nearest cell centre within 0.6×cellSize;
  pinch-zoom 0.5×–3× + pan; 6px slop threshold so pans never misfire taps;
  wrong-tap (no legal action) = 3px shake + dull thud, never a dialog.
- **Haptics**: `navigator.vibrate(10)` on landings — works on Android, silently
  no-ops on iOS Safari; acceptable for a POC.
- **Reduced motion**: `prefers-reduced-motion` ⇒ instant moves, cross-fades only.
- **Perf**: one canvas, full redraw per frame (fine at this scale),
  devicePixelRatio-aware so jewels are crisp on retina.

## 5. Better than the original (keep the calm, drop the funnel)

1. **Colour-blind-safe mode as a headline feature** — see §6. The original is
   unplayable for ~8% of men; ours is fully playable with symbols on.
2. **Free unlimited undo + solver-powered "show me a move"** — replaces the paid
   wand/magnet/brush. The hint highlights one provably-progressing pickup (from
   the stored solution trace, re-planned from current state); it teaches instead
   of skipping.
3. **Honest difficulty** — measured, ordered, displayed. No engineered
   frustration spike at level N to sell boosters. The generosity *is* the
   design: undo/hints/restart free, capacity growth as the only economy.
4. **Bring-your-own-image** — drop any photo, the gen pipeline (in a worker)
   quantises, scrambles, certifies solvability, scores difficulty, and you play
   your own picture. This is the feature the original can't ship (it would
   cannibalise the level-pack economy) and our biggest genuine addition.
5. **Shareable reveal + seed URLs** — win screen exports the reveal as PNG
   (M2; animated GIF later), and `#level=X&seed=Y` reproduces the exact board so
   a friend can race the same puzzle. Zero backend.

Killed ideas (violate the calm): daily streaks, timers, energy, score
multipliers, leaderboards, cosmetic meta-progression, achievement toasts.

## 6. Accessibility — first-class

The entire game is colour discrimination, so:

- **Symbols mode** (the core mechanism): each palette colour gets a distinct
  glyph (♦ ● ▲ ✦ …, from a fixed 12-glyph set chosen for shape contrast)
  rendered small on the socket AND on the jewel. A mismatch then reads as a
  glyph clash, not only a hue clash. Three-state toggle: off / symbols /
  symbols + high-contrast patterns. **Force-on automatically** when the level
  palette contains any pair under ΔE2000 20 — including BYO-image levels.
- Mismatch ring uses shape (ring + notch) as well as colour; never
  colour-alone signalling anywhere in the UI.
- Bundled palettes validated at build time: min pairwise ΔE2000 ≥ 20.
- Full keyboard play (arrow keys move a cursor, Enter acts) — cheap to build,
  doubles as another headless-driving path.
- Deferred, path noted: screen-reader grid (cells as a11y-tree buttons) is
  feasible but heavy; not in POC.

## 7. Milestones

**M1 — vertical slice ("one level, winnable, tested"):**
core/ complete (types, reducer, legalMoves, status, RNG) · solver (greedy +
backtrack) · one hand-made 16×16 level · scramble with retry-until-certified ·
canvas render (static + basic linear tweens) · tap pickup/pour · shelf UI ·
undo · win/stuck detection · `window.__game` hook · Vitest unit suite on
core+solver · one Playwright test that **plays the level to victory via the
solver** and screenshots the win. No audio, no zoom, no menus.
Definition of done: `npm test` green, `npx playwright test` wins the game.

**M2 — generation + juice:** PNG→level pipeline · difficulty metric + report ·
10 bundled levels ordered by difficulty · arcs/stagger/squash/audio/shimmer ·
zoom/pan · reveal animation + PNG export · localStorage progress.

**M3 — the improvements:** symbols mode + auto-force-on · hint system · BYO
image (worker) · seed-share URLs · difficulty calibration pass (play 10 levels,
adjust weights) · reduced-motion + keyboard play.

**Deferred beyond POC:** GIF export, PWA/offline install, iOS haptics, screen
reader, level editor, monetisation-seam analysis writeup (where a shipped
version would put fair seams — cosmetic palettes, level packs — as a doc, not
code).

## 8. Risks & unknowns — and the POC's defensible answers

| Unknown | Our pin | Why defensible without the original |
|---|---|---|
| Exact batch-pickup rule (connected vs "near") | Strict 8-connected, mismatched-only, BFS, capped at capacity | Predictable and kinder; nondeterministic grabs read as bugs |
| Pour semantics (per-tap amount) | Pour all shelf jewels of that colour into the tapped region | Fewest taps, matches "flow through region" observation |
| Can pickup lift correctly-placed jewels? | No (monotone progress) | Friendlier; hugely simplifies solver; divergence acceptable |
| Shelf growth numbers | +2 per completed colour, 12→24 | Parameterised; tune in M2 playtest |
| Booster semantics (wand/brush/magnet) | Not cloned; replaced by undo + hint | Boosters exist to sell relief from engineered friction we removed |
| Solver false negatives | Regenerate scramble | Costs generation time only; unsolvable boards can never ship |
| Greedy solver's S\* overestimates true minimum capacity | Accept upper bound | Difficulty metric only needs consistency, not optimality |
| IP | Mechanics aren't copyrightable; all art/name/sounds original | Private POC; own pixel art from day one anyway |

**Brief corrections (minor):** "zero legal moves at start" → zero legal
*placements*; pickups are always legal. "Win = all matched AND shelf empty" →
the second clause is implied by the first under histogram-preserving scramble +
match-only placement; checked as an invariant in tests rather than a rule.

## 9. Proposed layout

```
jewel-swap/
  src/core/     state.ts reducer.ts moves.ts rng.ts types.ts
  src/solver/   solver.ts hints.ts
  src/gen/      quantise.ts scramble.ts difficulty.ts components.ts ciede2000.ts
  src/render/   renderer.ts tweens.ts audio.ts
  src/input/    pointer.ts keyboard.ts camera.ts
  src/app/      main.ts screens.ts settings.ts testhook.ts
  levels/       *.png source art + generated *.level.json (with solution trace)
  tests/        unit (vitest) + e2e (playwright)
```
