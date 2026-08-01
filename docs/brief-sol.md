# Brief for Sol

You are working in the repo root.

## The game

A calm colour-permutation puzzle, a deliberately ad-free take on the mobile game
*Jewel Coloring*. Each board cell shows a **square socket** in the colour that cell must
end up as (the answer key is always visible) with a **round jewel** sitting on it in
whatever colour is currently there. A circle never covers its square, so a mismatch reads
as two colours in one cell; when they match, the ring vanishes and the cell looks solid.
The player selects a batch of same-coloured jewels and taps where they go — either the
shelf/tray at the bottom (a limited buffer) or matching empty sockets on the board.
Finishing a colour permanently grows the shelf.

The reference user has played the original for 113 hours across 400+ levels, so their
instincts about feel are trustworthy. The goal is to scale to **hundreds of levels**.

## Task 1 — critique the UI and mock up improvements

Look at these actual screenshots (you can read images — reference them by path):

- `shots/ui-01-board.png` — the board at level start
- `shots/ui-02-selected.png` — a batch selected (mint glow) with the tray offered as a destination
- `shots/ui-03-shelf.png` — after the batch moved to the shelf
- `shots/gallery.png` — the picture gallery

Write a critique to `art/UI-CRITIQUE.md`. Be specific and opinionated, and prioritise:
what is genuinely confusing or ugly, versus what is fine. Consider readability of the
socket/jewel relationship on a dense grid, the header stats line, the tray, the button row,
wasted vertical space, and whether the current level's *goal* is legible.

Then generate **3–4 mockup images** of concrete improvements using the image-gen wrapper:

```bash
~/.claude/skills/image-gen/scripts/gen-image.sh "PROMPT" --out art/mock-<name>.png --size 1024x1536
```

Mock up whole-screen redesigns of the puzzle screen at phone aspect ratio. Keep the core
mechanic visible and recognisable (square sockets, round jewels, a tray of slots). Do not
invent monetisation, timers, energy or ads — this build has none by design and never will.
Reference each mockup from the critique file with a sentence on what it is proposing.

## Task 2 — level artwork

The game converts images into puzzles automatically with
`scripts/image-to-level.ts` (k-means in CIELAB, backdrop flood-fill masking, solver
certification). It works best on **already-stylised flat-colour art**, which is what to make.

Generate **12 images** into `art/`, named `art/lv-<subject>.png`. Each must be:

- **Pixel art / flat vector style**, hard edges, NO gradients, NO soft shading, NO
  anti-aliasing, NO noise or texture
- Exactly **4–7 flat colours** on the subject, each clearly distinguishable
- **One centred subject** filling most of the frame — fruit, animals, food, space, plants,
  weather, simple objects, symbols. No text, no letters, no numbers.
- A **plain solid white background** (the converter flood-fills the border colour away, so
  the board ends up shaped like the subject)
- Square, 1024x1024

Vary the subjects widely and vary how the colour is distributed: some with roughly equal
amounts of each colour, some where one or two colours are a small accent. That ratio is a
real difficulty lever in this game.

## Rules

- Work only inside `art/` and `shots/`. Do not modify `src/`, `tests/`,
  `package.json`, or anything else — another agent is editing those concurrently.
- Do not run `npm install`, do not commit, do not push, do not deploy.
- Look at each image you generate and regenerate it if it does not match the brief.
- Finish with a short summary at `art/SOL-REPORT.md`: what you critiqued, what you
  generated, and anything you could not do.
