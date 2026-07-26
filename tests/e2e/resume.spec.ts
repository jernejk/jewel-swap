import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__game !== undefined);
}

test('an unfinished board survives a reload', async ({ page }) => {
  await boot(page);
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.45);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 46);
  await page.waitForFunction(() => window.__game.getState().moves === 1);

  const before = await page.evaluate(() => {
    const s = window.__game.getState();
    return { id: s.level.id, moves: s.moves, shelf: s.shelf.length, jewels: s.jewels.join(',') };
  });
  expect(before.shelf).toBeGreaterThan(0);

  // A crash, a swipe-away, or the OS reclaiming memory all look like this.
  await page.reload();
  await page.waitForFunction(() => window.__game !== undefined);

  const after = await page.evaluate(() => {
    const s = window.__game.getState();
    return { id: s.level.id, moves: s.moves, shelf: s.shelf.length, jewels: s.jewels.join(',') };
  });
  expect(after, 'the board was not restored exactly').toEqual(before);
});

test('a finished board is not resumed', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.__game.solve());
  await expect.poll(() => page.evaluate(() => window.__game.getStatus())).toBe('won');

  const stored = await page.evaluate(
    () => (JSON.parse(localStorage.getItem('jewel-swap:v2') as string) as { inProgress: unknown }).inProgress,
  );
  expect(stored, 'a completed board should not linger as resumable').toBeNull();
});

test('a snapshot from another level is ignored', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem(
      'jewel-swap:v2',
      JSON.stringify({
        completed: {},
        levelId: null,
        // Deliberately mismatched: wrong level, wrong length.
        inProgress: { levelId: 'not-a-real-level', seed: 1, jewels: [0, 1, 2], shelf: [], moves: 9 },
        symbols: false,
        sound: true,
      }),
    );
  });
  await boot(page);
  const s = await page.evaluate(() => window.__game.getState());
  expect(s.moves, 'a mismatched save must not be applied').toBe(0);
  expect(await page.evaluate(() => window.__game.getStatus())).toBe('playing');
});

test('the board still renders after returning from the background', async ({ page }) => {
  await boot(page);
  await page.waitForTimeout(600);

  const ink = async (): Promise<number> =>
    page.evaluate(() => {
      const c = document.getElementById('canvas') as HTMLCanvasElement;
      const ctx = c.getContext('2d') as CanvasRenderingContext2D;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      // Count non-transparent pixels: a blank board is the failure being guarded.
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 97) if (d[i] !== 0) n++;
      return n;
    });

  const before = await ink();
  expect(before).toBeGreaterThan(0);

  // Mobile browsers may drop cached canvas pixels while backgrounded; the app
  // rebuilds its sprites when it comes back.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
  });
  await page.waitForTimeout(600);

  expect(await ink(), 'board went blank after returning').toBeGreaterThan(before * 0.8);
});
