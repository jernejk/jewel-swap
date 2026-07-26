import { expect, test, type Page } from '@playwright/test';

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__game !== undefined);
}

test('gallery lists every picture and marks the current one', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Gallery' }).click();

  const tiles = page.locator('#gallery-grid [data-level]');
  const count = await tiles.count();
  expect(count).toBeGreaterThan(0);

  const levels = await page.evaluate(() => window.__game.getLevelIds());
  expect(count).toBe(levels.length);
  await expect(page.locator('#gallery-grid .current')).toHaveCount(1);
  await expect(page.locator('#gallery-summary')).toContainText(`of ${levels.length}`);
});

test('finishing a picture is remembered across a reload', async ({ page }) => {
  await boot(page);
  const id = await page.evaluate(() => window.__game.getState().level.id);

  await page.evaluate(() => window.__game.solve());
  await expect.poll(() => page.evaluate(() => window.__game.getStatus())).toBe('won');

  // The win must survive a full restart, not just live in memory.
  await page.reload();
  await page.waitForFunction(() => window.__game !== undefined);
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem('jewel-swap:v2') as string) as { completed: Record<string, { moves: number }> },
  );
  expect(Object.keys(saved.completed)).toContain(id);
  expect(saved.completed[id]?.moves).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Gallery' }).click();
  await expect(page.locator(`#gallery-grid [data-level="${id}"]`)).toHaveClass(/done/);
  await expect(page.locator('#gallery-grid .done')).toHaveCount(1);
});

test('picking a picture from the gallery loads it', async ({ page }) => {
  await boot(page);
  const ids = await page.evaluate(() => window.__game.getLevelIds());
  const target = ids[ids.length - 1] as string;

  await page.getByRole('button', { name: 'Gallery' }).click();
  await page.locator(`#gallery-grid [data-level="${target}"]`).click();

  await expect
    .poll(() => page.evaluate(() => window.__game.getState().level.id))
    .toBe(target);
  await expect(page.locator('#gallery')).not.toHaveClass(/show/);
  expect(await page.evaluate(() => window.__game.getStatus())).toBe('playing');
});

test('progress from an older save is not lost when levels are reordered', async ({ page }) => {
  await page.goto('/');
  // Progress is keyed by level id precisely so this holds.
  await page.evaluate(() => {
    localStorage.setItem(
      'jewel-swap:v2',
      JSON.stringify({
        completed: { heart: { moves: 40, at: 1, plays: 1 } },
        levelId: null,
        symbols: false,
        sound: true,
      }),
    );
  });
  await boot(page);
  await page.getByRole('button', { name: 'Gallery' }).click();
  await expect(page.locator('#gallery-grid [data-level="heart"]')).toHaveClass(/done/);
  await expect(page.locator('#gallery-grid [data-level="heart"]')).toContainText('best 40');
});
