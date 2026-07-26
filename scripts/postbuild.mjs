/**
 * Inject the real precache list into the built service worker.
 *
 * Vite content-hashes asset filenames, so the worker cannot name them up front.
 * Rather than maintain a list by hand (which rots silently and only fails when
 * a user is offline), we read what was actually emitted.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    if ((await stat(full)).isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const files = await walk(dist);
const hash = createHash('sha256');

const precache = ['./'];
for (const file of files.sort()) {
  const rel = relative(dist, file).split(/[\\/]/).join('/');
  // The worker is hashed but never precached: it must not cache itself, yet a
  // change to its logic still has to invalidate the old cache. Hashing happens
  // before token substitution, so this stays stable rather than circular.
  hash.update(await readFile(file));
  if (rel === 'sw.js') continue;
  precache.push(`./${rel}`);
}

const version = hash.digest('hex').slice(0, 12);
const swPath = join(dist, 'sw.js');
const sw = (await readFile(swPath, 'utf8'))
  .replace('__BUILD_VERSION__', version)
  .replace('__PRECACHE__', JSON.stringify(precache, null, 2));

await writeFile(swPath, sw);
console.log(`sw.js: ${precache.length} files precached, version ${version}`);
