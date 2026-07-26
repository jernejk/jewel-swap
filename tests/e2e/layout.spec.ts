import { expect, test } from '@playwright/test';

/**
 * Regression guard for a runaway-layout bug found on an installed Android PWA:
 * the play area grew a few pixels per second until the tray walked off screen.
 *
 * Cause: the canvas was a normal flex item, and its width/height *attributes*
 * are its intrinsic size. Each frame measured `clientHeight`, wrote back a
 * rounded pixel size, which grew the intrinsic size, which grew the flex box,
 * which grew the next measurement. Rounding made it creep rather than explode,
 * so it only became obvious after a while — and standalone mode (no browser
 * chrome) is where it had the room to run.
 *
 * These assertions are deliberately about *stability over time* rather than any
 * particular size, because the same failure could return via any route.
 */
async function measure(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement;
    const stage = document.getElementById('stage') as HTMLElement;
    return {
      canvasAttrH: canvas.height,
      canvasAttrW: canvas.width,
      stageH: Math.round(stage.getBoundingClientRect().height),
      docH: document.documentElement.scrollHeight,
      bodyH: Math.round(document.body.getBoundingClientRect().height),
    };
  });
}

test('the play area does not grow over time', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__game !== undefined);
  await page.waitForTimeout(500);

  const first = await measure(page);
  // Several seconds is many hundreds of rendered frames — ample for a
  // one-pixel-per-frame creep to show up.
  await page.waitForTimeout(3500);
  const second = await measure(page);

  expect(second, 'layout drifted while idle').toEqual(first);
});

test('the play area does not grow while jewels are moving', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__game !== undefined);
  await page.waitForTimeout(400);
  const before = await measure(page);

  const box = (await page.locator('#canvas').boundingBox())!;
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.45);
    await page.waitForTimeout(200);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 46);
    await page.waitForTimeout(900);
  }

  const after = await measure(page);
  expect(after, 'layout drifted during play').toEqual(before);
});

test('nothing overflows the viewport, and the tray stays on screen', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__game !== undefined);
  await page.waitForTimeout(3000);

  const fits = await page.evaluate(() => {
    const stage = document.getElementById('stage') as HTMLElement;
    const footer = document.querySelector('footer') as HTMLElement;
    return {
      overflowY: document.documentElement.scrollHeight - window.innerHeight,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      stageBottom: Math.round(stage.getBoundingClientRect().bottom),
      footerBottom: Math.round(footer.getBoundingClientRect().bottom),
      viewport: window.innerHeight,
    };
  });

  expect(fits.overflowY, 'page scrolls vertically').toBeLessThanOrEqual(1);
  expect(fits.overflowX, 'page scrolls horizontally').toBeLessThanOrEqual(1);
  expect(fits.stageBottom, 'stage extends past the viewport').toBeLessThanOrEqual(
    fits.viewport + 1,
  );
  expect(fits.footerBottom, 'buttons pushed off screen').toBeLessThanOrEqual(fits.viewport + 1);
});
