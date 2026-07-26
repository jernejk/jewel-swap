# Design review — Jewel Swap

Review only. Do NOT generate images, do NOT edit source, do NOT run npm.
Write your answer to `art/UI-CRITIQUE.md` and nothing else. Budget ~10 minutes.

## The game
A calm colour-permutation puzzle. Each cell shows a **square socket** in the colour that
cell must end up as (the answer key is always visible) with a **round jewel** on top in
whatever colour is there now. A circle never covers its square, so a mismatch shows two
colours in one cell; when they match, the ring disappears and the cell reads solid.
The player taps a jewel to select its connected same-coloured batch, then taps a
destination: the tray at the bottom (a limited buffer) or matching empty sockets on the
board. Finishing a colour permanently grows the tray. No ads, no timers, no energy, ever.

## Look at these (read the image files)
- `shots/tactile2.png` — board with a batch selected (blue jewels, slightly enlarged with a
  contact shadow). Is the selection legible? Is the enlargement right?
- `shots/gallery2.png` — the picture gallery. Unsolved pictures show as grey silhouettes so
  the reveal stays a reward.
- `shots/ui-03-shelf.png` — after a batch moved to the tray.

## Answer these, specifically and in priority order
1. What is genuinely confusing or ugly, versus what is fine? Be blunt. Rank by impact.
2. Is the socket/jewel relationship readable at this density on a phone?
3. The header is a single line: "101 left · shelf 0/12 · 0 moves". Is that the right
   information? What would you cut or add?
4. There is a lot of empty vertical space above and below the board on a tall phone.
   What should occupy it, if anything?
5. Gallery: the metadata line is `●●○○○ · 12×12 · 3` (relative difficulty, grid, colours).
   Useful or noise?
6. Anything about the colour palettes across levels that looks wrong or muddy.

Give concrete, actionable changes — CSS/canvas-level, not vague advice. Say plainly if
something is already good; do not invent problems. End with the single highest-impact
change you would make.
