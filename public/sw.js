/**
 * Offline-first service worker.
 *
 * The precache list and version are injected at build time by
 * scripts/postbuild.mjs — Vite hashes the asset filenames, so this file cannot
 * know them ahead of time, and a hand-written list would silently rot.
 */
const VERSION = '__BUILD_VERSION__';
const CACHE = `jewel-swap-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * `ignoreVary` is not optional here. `cache.addAll` stores whatever `Vary`
 * header the server sent, and a later request for the same URL carries
 * different headers — Vite tags module scripts `crossorigin`, so the script
 * request is not header-identical to the one that filled the cache. Without
 * this, the HTML serves offline and the JS bundle misses, which fails in the
 * worst possible way: a blank page that looks like it loaded.
 */
const MATCH = { ignoreVary: true };

function fromCache(request) {
  return caches.match(request, MATCH);
}

function store(request, response) {
  const copy = response.clone();
  caches
    .open(CACHE)
    .then((c) => c.put(request, copy))
    .catch(() => {});
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations go network-first so a redeploy is picked up on the next online
  // launch; the cache is the fallback that makes the game work on a plane.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => store(request, res))
        .catch(() =>
          fromCache(request).then(
            (hit) => hit || caches.match('./index.html', MATCH) || Response.error(),
          ),
        ),
    );
    return;
  }

  // Assets are content-hashed, so a hit is always correct and always fastest.
  event.respondWith(
    fromCache(request).then(
      (hit) => hit || fetch(request).then((res) => store(request, res)),
    ),
  );
});
