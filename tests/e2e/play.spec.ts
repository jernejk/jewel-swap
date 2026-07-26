import { expect, test, type Page } from '@playwright/test';

interface TestHook {
  getStatus(): 'playing' | 'won' | 'stuck';
  getState(): { moves: number; shelf: number[]; capacity: number };
  getLegalMoves(): { type: string; cell: number }[];
  getDifficulty(): Record<string, number>;
  loadLevel(index: number, seed?: number): void;
  solve(): boolean;
}

declare global {
  interface Window {
    __game: TestHook;
  }
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__game !== undefined);
}

test('boots with a playable board and no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await boot(page);
  const status = await page.evaluate(() => window.__game.getStatus());
  expect(status).toBe('playing');

  const moves = await page.evaluate(() => window.__game.getLegalMoves());
  expect(moves.length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('the board fits the viewport without scrolling', async ({ page }) => {
  await boot(page);
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - window.innerWidth,
    y: document.documentElement.scrollHeight - window.innerHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(1);
  expect(overflow.y).toBeLessThanOrEqual(1);

  // The shelf is the game's only unconstrained space; if it is off-screen the
  // level is unplayable no matter how correct the core is.
  const shelfVisible = await page.evaluate(() => {
    const c = document.getElementById('canvas') as HTMLCanvasElement;
    return c.getBoundingClientRect().bottom <= window.innerHeight + 1;
  });
  expect(shelfVisible).toBe(true);
});

test('one tap selects, a second tap on the tray sends the batch there', async ({ page }) => {
  await boot(page);
  const box = (await page.locator('#canvas').boundingBox())!;

  // First tap picks a batch up but must not commit anything on its own.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.45);
  await page.waitForTimeout(150);
  const afterSelect = await page.evaluate(() => window.__game.getState());
  expect(afterSelect.shelf.length, 'selecting must not move anything').toBe(0);
  expect(afterSelect.moves).toBe(0);

  // Second tap names the destination.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 46);
  await page.waitForFunction(() => window.__game.getState().shelf.length > 0, undefined, {
    timeout: 5_000,
  });
  const after = await page.evaluate(() => window.__game.getState());
  expect(after.shelf.length).toBeGreaterThan(0);
  expect(after.moves).toBe(1);
});

test('every level can be played to victory through the real game', async ({ page }) => {
  await boot(page);
  const count = 5;
  for (let i = 0; i < count; i++) {
    const won = await page.evaluate((index) => {
      window.__game.loadLevel(index, 1);
      return window.__game.solve();
    }, i);
    expect(won, `level ${i} did not reach a win`).toBe(true);
    expect(await page.evaluate(() => window.__game.getStatus())).toBe('won');
  }
});

test('undo walks a move back', async ({ page }) => {
  await boot(page);
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.45);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 46);
  await page.waitForFunction(() => window.__game.getState().moves === 1);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__game.getState().moves))
    .toBe(0);
});

test('captures the finished picture', async ({ page }, testInfo) => {
  await boot(page);
  await page.evaluate(() => {
    window.__game.loadLevel(4, 1);
    window.__game.solve();
  });
  await page.waitForTimeout(1800);
  await testInfo.attach('win', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
