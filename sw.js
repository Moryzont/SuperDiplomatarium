---
# Front matter so Jekyll inlines the build stamp and base URL below.
---
// Service worker: keeps the site's data files (search indexes, the core and
// map tables, the letter detail chunks, the fuzzy vocabulary) in the browser
// between visits. Pages, CSS and JS are never served from here. The cache is
// named after the build: a new deploy activates a new worker, which drops the
// previous build's cache, so a visitor never sees stale data.
const BUILD = 'sd-data-{{ site.time | date: "%s" }}';
const DATA_PREFIX = '{{ "/data/" | relative_url }}';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== BUILD) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(DATA_PREFIX)) return;
  event.respondWith((async () => {
    const cache = await caches.open(BUILD);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  })());
});
