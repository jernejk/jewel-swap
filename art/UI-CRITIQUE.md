# Jewel Swap UI critique

I could read all three screenshots. One discrepancy matters: in `tactile2.png`, the batch with the raised/contact-shadow treatment reads as the central **white** batch, not blue as described in the brief.

## 1. Confusing or ugly, ranked by impact

1. **The vacated cells in `ui-03-shelf.png` look like solid red blocks, not empty sockets.** The dark top band makes them resemble bricks or disabled cells. This is the most confusing state because those cells are part of the core move grammar. Render an empty socket as a recess: keep the target-colour square, add a 1–2 px darker inset outline on all four sides, and put a subtle dark radial/inner fill in its centre. Remove the single horizontal top band. The result should say “red hole” rather than “red tile.”

2. **Selection is detectable once I know where to look, but it is not immediately legible.** The enlargement is about right; increasing it further would make this dense board feel crowded and cause neighbouring pieces to merge. Keep the selected jewels at roughly `scale(1.06–1.08)`, lift them by about 2 px, and strengthen the contact shadow to a consistent neutral shadow such as `0 3px 0 rgba(0,0,0,.28), 0 5px 9px rgba(0,0,0,.22)`. Add a thin selection-colour rim around the selected jewels or, better, one outline around the connected batch. Do not use target/socket colour as part of the selection cue: the gold/teal edges under the white batch currently read as board colour leakage.

3. **The header’s “left” count appears to reward moving pieces into the shelf, not solving them.** In the Rocket shot, putting 12 jewels on the shelf leaves “90 left,” which sounds like genuine progress even though those jewels are merely buffered. That is a semantic problem, not just copy polish. Either relabel it `90 on board`, or replace it with actual progress such as `0/5 colours solved`.

4. **The gallery metadata uses two unexplained encodings.** Five dots are recognisable as a rating, but `· 3` is not recognisable as “three colours.” `unsolved` is also redundant when every card is a grey silhouette and the header already says `0 of 44 pictures finished`.

5. **The active Gallery card’s mint outline is ambiguous.** It could mean selected, current, focused, or completed. If it means the current puzzle, add a small `Current` label and use the mint outline with it. If it is merely focus, show it only under `:focus-visible`, not persistently on touch.

What is already good: the dark background, restrained chrome, large tap targets, fixed bottom actions, and grey gallery silhouettes all suit a calm puzzle. The gallery genuinely preserves the reveal. The jewel gloss is consistent and readable, and the board shape remains clear despite the cell density.

## 2. Socket/jewel relationship at phone density

Yes, it is readable on these 12×12-ish boards. The round jewel leaves enough of the square’s corners visible to expose the target colour, and a mismatch usually reads instantly as two colours in one cell. Keep the jewel diameter around `76–80%` of the socket width and preserve at least 2 px of dark separation between adjacent sockets at the smallest supported board scale.

The weak case is same-colour placement: the strong spherical highlight means a matched cell still reads as “ball on square,” even when both colours match. That is acceptable—the colour match is clear—but if “solid” is meant to be a reward state, reduce the jewel’s drop shadow on a match and slightly lower the contrast of its gloss. Do not remove the gloss entirely; that would make solved cells look like empty sockets.

For larger grids, enforce a minimum rendered cell size rather than shrinking indefinitely. Below roughly 28 CSS px per cell, the exposed corners and highlight will stop carrying enough information. At that point, scale the entire board to the available width and allow the page to use a compact vertical scroll rather than making the symbols smaller.

## 3. Header information

`101 left · shelf 0/12 · 0 moves` is too much low-value telemetry for a calm game.

- Replace `101 left` with a truthful progress measure: preferably `0/3 colours solved`; otherwise use `101 on board`.
- Remove `shelf 0/12` from the header while the shelf itself is visible and already shows capacity spatially. When the shelf is full, use a brief local label or pulse on the shelf rather than duplicating it permanently.
- Remove `moves` unless move count affects a rating, unlock, personal best, or explicit challenge. Otherwise it adds pressure without helping a decision and conflicts with the “no timers, no energy” tone.

A better single line would be `0/3 colours solved`, with a temporary second status only during interaction, for example `12 selected · shelf full`.

## 4. Empty vertical space

Mostly leave it empty. The breathing room supports the calm tone, and filling it with decoration or more statistics would weaken the board. The board is already width-limited, so simply enlarging it would not solve the tall-screen gap.

Use the space only for contextual help:

- Before the first move: one quiet line, `Tap a connected colour, then choose its destination`.
- While selected: `12 selected · tap the shelf or matching empty sockets`.
- After the player has demonstrated the interaction: remove the helper entirely.

Layout-wise, centre the board in the flexible region between header and shelf with a bounded gap, e.g. a column using `grid-template-rows: auto minmax(0, 1fr) auto auto`, and centre the canvas inside the middle row. Keep the shelf and controls anchored near the bottom safe area. Do not distribute the board, shelf, and controls with `space-between`; that would make their functional relationship feel weaker on tall screens.

## 5. Gallery metadata

Grid size and colour count are useful because they set expectations before opening a puzzle. The current syntax is too cryptic. Use:

`Easy · 12×12 · 3 colours`

If relative difficulty is reliably calculated and meaningfully varies, dots can stay, but give them an accessible label and do not make users decode both dots and an unlabeled number. If difficulty mostly tracks grid size and colour count, remove the dots because the other two values already explain it. Remove the separate `unsolved` line; use that space to shorten cards or give silhouettes more room.

## 6. Colour palettes

Shield’s blue/yellow/white palette is strong: the hues and lightness values separate cleanly, and white works well as both jewel and socket.

Rocket is muddier. Red, orange, and yellow occupy too much of the same warm range; red and orange are especially close once the gradients and shadows darken them. Push them apart in both hue and lightness, not hue alone: make red deeper and slightly cooler, keep orange brighter and more amber, and keep yellow distinctly lighter. In practical palette terms, aim for a visibly different lightness step between adjacent colours (roughly 12–15 points in OKLCH `L`) and test the rendered jewels—not just flat swatches—with deuteranopia/protanopia simulation. Cyan is an effective separator and should stay.

Avoid choosing socket shades separately by manually darkening RGB values; the empty red sockets show how that can become brown and muddy. Derive socket, jewel highlight, and jewel shadow from one OKLCH base colour with controlled lightness/chroma offsets so each colour keeps its identity across all states.

**Single highest-impact change:** redesign vacated board cells as unmistakably recessed, target-coloured empty sockets instead of flat dark blocks.
