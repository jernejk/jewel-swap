import { describe, expect, it } from 'vitest';
import { LEVELS } from '../src/levels';
import { colourHistogram, minimumPreMatched, playableCells } from '../src/gen/art';
import { generate, maxPickupBatch, scramble, stateFrom } from '../src/gen/scramble';
import { createState, reduce } from '../src/core/reducer';
import { paletteDistance } from '../src/gen/ciede2000';
import { isWon, moveRegions, pickupRegions, status } from '../src/core/moves';

describe('level art', () => {
  it('builds every level without shearing rows', () => {
    expect(LEVELS.length).toBeGreaterThan(0);
    for (const level of LEVELS) {
      expect(level.target.length).toBe(level.width * level.height);
      expect(playableCells(level).length).toBeGreaterThan(20);
    }
  });

  it('keeps every palette pair perceptually distinguishable', () => {
    for (const level of LEVELS) {
      for (let a = 0; a < level.palette.length; a++) {
        for (let b = a + 1; b < level.palette.length; b++) {
          const dE = paletteDistance(level.palette[a] as string, level.palette[b] as string);
          expect(
            dE,
            `${level.id}: ${level.palette[a]} vs ${level.palette[b]} ΔE=${dE.toFixed(1)}`,
          ).toBeGreaterThan(20);
        }
      }
    }
  });
});

describe('scramble', () => {
  it('preserves the colour histogram exactly', () => {
    for (const level of LEVELS) {
      const jewels = scramble(level, 42);
      const want = colourHistogram(level);
      const got = new Map<number, number>();
      for (const j of jewels) {
        if (j == null) continue;
        got.set(j, (got.get(j) ?? 0) + 1);
      }
      expect(got, level.id).toEqual(want);
    }
  });

  it('gets within a whisker of the pigeonhole floor on pre-matched cells', () => {
    for (const level of LEVELS) {
      const jewels = scramble(level, 7);
      const cells = playableCells(level);
      const matched = cells.filter((c) => jewels[c] === level.target[c]).length;
      const floor = minimumPreMatched(level);
      // Judge the scrambler against what is achievable, not a flat percentage:
      // some pictures simply cannot be fully deranged.
      expect(matched, `${level.id} (floor ${floor} of ${cells.length})`).toBeLessThanOrEqual(
        floor + Math.ceil(cells.length * 0.03),
      );
    }
  });

  it('keeps art balanced enough that most cells can start misplaced', () => {
    for (const level of LEVELS) {
      const cells = playableCells(level).length;
      const floor = minimumPreMatched(level);
      expect(floor / cells, `${level.id} is too dominated by one colour`).toBeLessThan(0.15);
    }
  });
});

describe('no opening tap can dead-end the game', () => {
  for (const level of LEVELS) {
    it(`${level.id} has at least one liftable batch`, () => {
      const gen = generate(level, { seed: 1 });
      const state = stateFrom(gen);
      expect(maxPickupBatch(state)).toBeGreaterThan(0);
    });

    it(`${level.id} survives every possible first tap`, () => {
      const gen = generate(level, { seed: 1 });
      const start = stateFrom(gen);
      // A player taps before they understand the board. No single opening move
      // may leave them with nothing to do.
      for (const region of pickupRegions(start)) {
        const step = reduce(start, { type: 'pickup', cell: region.rep });
        expect(step).not.toBeNull();
        expect(
          status(step!.state),
          `${level.id}: tapping cell ${region.rep} ends the game`,
        ).not.toBe('stuck');
      }
    });
  }
});

describe('the shelf is a choice, not a toll', () => {
  it('lets a batch go straight across the board once a hole exists', () => {
    const level = LEVELS[0]!;
    const start = stateFrom(generate(level, { seed: 1 }));

    // Opening a hole is the only thing the shelf is strictly needed for.
    const first = reduce(start, { type: 'pickup', cell: pickupRegions(start)[0]!.rep });
    expect(first).not.toBeNull();
    const opened = first!.state;

    const carries = moveRegions(opened);
    expect(carries.length, 'no board-to-board route opened up').toBeGreaterThan(0);

    const pick = carries[0]!;
    const shelfBefore = opened.shelf.length;
    const step = reduce(opened, { type: 'move', from: pick.from.rep, to: pick.to.rep });
    expect(step).not.toBeNull();

    // The defining property: the jewels arrived without passing through the shelf.
    expect(step!.state.shelf.length, 'a direct move must not touch the shelf').toBe(shelfBefore);
    for (const cell of step!.effect.cells) {
      expect(step!.state.jewels[cell]).toBe(step!.effect.colour);
    }
    for (const cell of step!.effect.fromCells) {
      expect(step!.state.jewels[cell]).toBeNull();
    }
  });

  it('never moves more jewels than there are sockets waiting', () => {
    for (const level of LEVELS) {
      const start = stateFrom(generate(level, { seed: 1 }));
      const opened = reduce(start, { type: 'pickup', cell: pickupRegions(start)[0]!.rep })!.state;
      for (const { from, to } of moveRegions(opened)) {
        const step = reduce(opened, { type: 'move', from: from.rep, to: to.rep });
        if (!step) continue;
        expect(step.effect.cells.length).toBe(step.effect.fromCells.length);
        expect(step.effect.cells.length).toBeLessThanOrEqual(to.cells.length);
        expect(step.effect.cells.length).toBeLessThanOrEqual(from.cells.length);
      }
    }
  });
});

describe('generation certifies solvability', () => {
  for (const level of LEVELS) {
    it(`${level.id} generates a winning trace`, () => {
      const gen = generate(level, { seed: 1 });
      expect(gen.trace.length).toBeGreaterThan(0);

      // Replay the certificate: it must actually win the game.
      let state = createState(gen.level, gen.jewels);
      let celebrations = 0;
      for (const action of gen.trace) {
        const step = reduce(state, action);
        expect(step, `illegal action ${JSON.stringify(action)} in ${level.id}`).not.toBeNull();
        celebrations += step!.effect.completed.length;
        state = step!.state;
      }
      expect(isWon(state), `${level.id} trace did not win`).toBe(true);

      // Every colour finishes exactly once, and each one pays out shelf room —
      // this is the only economy in the game, so it has to actually fire.
      expect(celebrations, `${level.id} never reported a completed colour`).toBe(
        level.palette.length,
      );
      const earned = Math.min(
        level.maxCapacity,
        level.initialCapacity + level.palette.length * level.growthPerColour,
      );
      expect(state.capacity, `${level.id} shelf did not grow as colours finished`).toBe(earned);
      expect(gen.difficulty.score).toBeGreaterThanOrEqual(0);
      expect(gen.difficulty.score).toBeLessThanOrEqual(100);
    });
  }
});
