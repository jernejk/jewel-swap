import { expect, test } from '@playwright/test';

const PROD = 'http://localhost:4173';

// Playwright's WebKit does not run service workers, so offline behaviour cannot
// be observed there. Real iPad Safari does support them — this is a limitation
// of the test browser, not of the app.
test.skip(({ browserName }) => browserName === 'webkit', 'WebKit has no service worker support');

test('ships the icons an installer needs', async ({ page }) => {
  const manifest = await page.request.get(`${PROD}/manifest.webmanifest`);
  expect(manifest.ok()).toBe(true);
  const json = (await manifest.json()) as {
    icons: { src: string; sizes: string; type: string }[];
    display: string;
    start_url: string;
  };
  expect(json.display).toBe('standalone');

  // iOS reads none of the manifest icons — it reads <link rel="apple-touch-icon">.
  await page.goto(PROD);
  const appleIcon = page.locator('link[rel="apple-touch-icon"]');
  await expect(appleIcon).toHaveCount(1);

  const sources = [
    ...json.icons.map((i) => i.src),
    (await appleIcon.getAttribute('href')) as string,
  ];
  for (const src of sources) {
    const res = await page.request.get(`${PROD}/${src.replace('./', '')}`);
    expect(res.ok(), `${src} is missing`).toBe(true);
    expect((await res.body()).length, `${src} is empty`).toBeGreaterThan(500);
  }

  // A PNG at 180 is the specific thing iOS wants; an SVG-only PWA installs blank.
  const png = json.icons.filter((i) => i.type === 'image/png');
  expect(png.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
});

test('plays with the network cut', async ({ page, context }) => {
  await page.goto(PROD);
  await page.waitForFunction(() => window.__game !== undefined);

  // Wait for the worker to take control, then for the precache to settle.
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.state;
  });
  await page.waitForTimeout(1200);

  await context.setOffline(true);
  await page.reload();

  await page.waitForFunction(() => window.__game !== undefined, undefined, { timeout: 15_000 });
  expect(await page.evaluate(() => window.__game.getStatus())).toBe('playing');

  // Booting offline is not enough — it has to be playable offline.
  const box = (await page.locator('#canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.45);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 46);
  await page.waitForFunction(() => window.__game.getState().shelf.length > 0, undefined, {
    timeout: 10_000,
  });

  await context.setOffline(false);
});
