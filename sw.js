// Slingstar service worker (PLAN.md §6). Owned by stream D.
// tools/build-precache.mjs rewrites the VERSION and FILES lines below; do not reformat them.
//
// - Precaches every shipped file into a versioned cache; deletes older caches on activate. Install
//   is all or nothing: if any file fails, the install fails and the previous worker and cache stay.
// - Cache-first with network fallback for same-origin GETs. App navigations (the scope root,
//   index.html and any ?seed=… variant) are answered from the cached index.html (ignoreSearch).
// - On loopback hosts (localhost / 127.0.0.1) it is network-first with cache fallback instead, so
//   local edits show without a rebuild; register with ?strategy=cache to force cache-first there.
// - Files outside the precache list (dev pages) are network-first and cached for offline use.
const VERSION = "0.1.0+3f4f7cf0";
const FILES = ["css/app.css","icons/icon-180.png","icons/icon-192.png","icons/icon-512.png","icons/icon.svg","index.html","manifest.webmanifest","src/audio/engine.js","src/audio/graph.js","src/audio/music.js","src/audio/sfx.js","src/config.js","src/contracts.js","src/core/events.js","src/core/math.js","src/core/rng.js","src/main.js","src/platform/input.js","src/platform/lifecycle.js","src/platform/pwa.js","src/platform/storage.js","src/render/background.js","src/render/bodies.js","src/render/camera.js","src/render/fx.js","src/render/gl.js","src/render/particles.js","src/render/post.js","src/render/renderer.js","src/render/scaler.js","src/render/shaders/background.js","src/render/shaders/bodies.js","src/render/shaders/common.js","src/render/shaders/fx.js","src/render/shaders/particles.js","src/render/shaders/post.js","src/sim/bot.js","src/sim/generator.js","src/sim/hazards.js","src/sim/scoring.js","src/sim/world.js","src/ui/debug.js","src/ui/hud.js","src/ui/numtext.js","src/ui/screens.js","src/version.js"];

const CACHE = `slingstar-${VERSION}`;
const CACHE_PREFIX = 'slingstar-';
const SCOPE = new URL(self.registration ? self.registration.scope : './', self.location.href);
const INDEX_URL = new URL('index.html', SCOPE).href;
const PRECACHED = new Set(FILES.map((f) => new URL(f, SCOPE).href));
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORCE_CACHE = new URL(self.location.href).searchParams.get('strategy') === 'cache';
const NETWORK_FIRST = !FORCE_CACHE && LOOPBACK.has(self.location.hostname);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const urls = FILES.map((f) => new URL(f, SCOPE).href);
    try {
      const cache = await caches.open(CACHE);
      await cache.addAll(urls.map((u) => new Request(u, { cache: 'reload' })));
    } catch (err) {
      // All or nothing: a partial copy must never replace a complete one. Rejecting fails this
      // install, so the previous worker and its cache stay in charge; the next launch retries.
      await caches.delete(CACHE).catch(() => {});
      throw err;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

/** Is this a navigation to the app itself (scope root or index.html, any query)? */
function isAppNavigation(request, url) {
  if (request.mode !== 'navigate') return false;
  const p = url.pathname;
  return p === SCOPE.pathname || p === SCOPE.pathname + 'index.html';
}

async function fromNetwork(request, cacheKey) {
  const res = await fetch(request);
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(cacheKey || request, copy)).catch(() => {});
  }
  return res;
}

async function cacheFirst(request, cacheKey) {
  const hit = await caches.match(cacheKey || request, { ignoreSearch: true, cacheName: CACHE })
    || await caches.match(cacheKey || request, { ignoreSearch: true });
  if (hit) return hit;
  return fromNetwork(request, cacheKey);
}

async function networkFirst(request, cacheKey) {
  try {
    return await fromNetwork(request, cacheKey);
  } catch (err) {
    const hit = await caches.match(cacheKey || request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  if (isAppNavigation(request, url)) {
    // Fetch the canonical index.html without the query so ?seed=… variants share one entry.
    event.respondWith(NETWORK_FIRST
      ? networkFirst(new Request(INDEX_URL, { cache: 'no-cache' }), INDEX_URL)
      : cacheFirst(new Request(INDEX_URL), INDEX_URL));
    return;
  }
  const key = url.origin + url.pathname;
  if (NETWORK_FIRST || !PRECACHED.has(key)) event.respondWith(networkFirst(request));
  else event.respondWith(cacheFirst(request));
});
