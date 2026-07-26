/**
 * Render the SVG icon to PNGs at the sizes installers actually want.
 *
 * iOS ignores SVG for home-screen icons, so a PWA with only SVG icons installs
 * to the iPad with a blank or screenshot tile. Playwright is already a dev
 * dependency for the e2e suite, so we borrow its browser rather than add an
 * image library.
 *
 *   node scripts/make-icons.mjs
 */
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** [source svg, output png, size] — 180 is the one iOS reads. */
const TARGETS = [
  ['public/icon.svg', 'public/icon-192.png', 192],
  ['public/icon.svg', 'public/icon-512.png', 512],
  ['public/icon.svg', 'public/apple-touch-icon.png', 180],
  ['public/icon-maskable.svg', 'public/icon-maskable-512.png', 512],
];

const browser = await chromium.launch();
try {
  for (const [src, out, size] of TARGETS) {
    const svg = await readFile(resolve(root, src), 'utf8');
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    // No transparency: an opaque tile looks deliberate on every launcher.
    await page.setContent(
      `<style>html,body{margin:0;padding:0;background:#171528}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: false });
    await writeFile(resolve(root, out), png);
    await page.close();
    console.log(`${out}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} kB`);
  }
} finally {
  await browser.close();
}
