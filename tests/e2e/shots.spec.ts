import { test } from '@playwright/test';

/**
 * Not assertions — this spec exists to produce images a human (or an agent with
 * eyes) can judge. Feel is not unit-testable.
 */
test('visual sweep', async ({ page }) => {
  const dir = 'shots';
  await page.goto('/');
  await page.waitForFunction(() => (window as never as { __game?: unknown }).__game !== undefined);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${dir}/01-start.png` });

  const box = (await page.locator('#canvas').boundingBox())!;
  const boardTap = { x: box.x + box.width / 2, y: box.y + box.height * 0.45 };
  const trayTap = { x: box.x + box.width / 2, y: box.y + box.height - 46 };

  // Selected, board still full: the tray is the only offered destination.
  await page.mouse.click(boardTap.x, boardTap.y);
  await page.waitForTimeout(260);
  await page.screenshot({ path: `${dir}/02-selected-tray-only.png` });

  await page.mouse.click(trayTap.x, trayTap.y);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${dir}/03-on-shelf.png` });

  // Now holes exist, so a second selection shows real board destinations.
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.waitForTimeout(260);
  await page.screenshot({ path: `${dir}/04-destinations.png` });

  await page.getByRole('button', { name: 'Shapes' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${dir}/05-symbols.png` });
  await page.getByRole('button', { name: 'Shapes' }).click();

  await page.evaluate(() => {
    const g = window as never as { __game: { loadLevel(i: number, s?: number): void } };
    g.__game.loadLevel(4, 1);
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${dir}/06-rocket-scrambled.png` });

  await page.evaluate(() => {
    const g = window as never as { __game: { solve(): boolean } };
    g.__game.solve();
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${dir}/07-win-reveal.png` });
});
