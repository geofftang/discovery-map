// Offline cache. Three stores:
//   SHELL_CACHE (build-stamped, replaced every deploy): index.html + the hashed JS/CSS bundle.
//   DATA_CACHE  (persistent): the place feed. A deploy must not wipe it, or the first open on bad
//                signal after a deploy shows no dots.
//   TILE_CACHE  (persistent, capped): CartoCDN style/tiles/sprites/fonts and the Photon geocoder.
//                Tiles are only saved once seen; a region pre-download is a separate trigger (TBD).
// Shell and data are network-first with a short timeout: on weak signal a fetch hangs instead of
// failing, so without the timeout the cached copy would never be used.
// The build stamps SHELL_CACHE (scripts/stamp-sw.mjs) so every deploy installs a fresh worker.
const SHELL_CACHE = "discovery-map-__BUILD__";
const DATA_CACHE = "discovery-map-data-v1";
const TILE_CACHE = "discovery-map-tiles-v1";
const KEEP = [SHELL_CACHE, DATA_CACHE, TILE_CACHE];
const TILE_CAP = 6000; // entries; oldest-inserted are dropped past this
const NETWORK_TIMEOUT_MS = 3000;
const ROOT = new URL(".", self.location.href).href;
// The private build (dist-private/) copies this file and serves ./private.json instead.
const APP_SHELL = [ROOT];
const DATA_PATTERN = /(discovery\.geojson|private\.json)$/;

// This is a client-rendered SPA (index.html is nearly empty) — the built, content-hashed
// JS/CSS bundle IS the app. Those filenames change every build, so we can't hardcode them;
// instead parse them out of the just-fetched index.html and precache alongside the shell.
async function precacheAppShell(cache) {
  await cache.addAll(APP_SHELL);
  try {
    const html = await (await fetch(ROOT)).text();
    const assetPaths = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    const assetUrls = assetPaths.map((p) => new URL(p, ROOT).href);
    await cache.addAll(assetUrls);
  } catch {
    // best-effort — the fetch handler's opportunistic caching still covers this on next visit
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => precacheAppShell(cache)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for the app shell: instant 5ms boot from cache, background refresh.
async function staleWhileRevalidateShell(event, request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = (await cache.match(request, { ignoreSearch: true }))
    || (await cache.match(ROOT, { ignoreSearch: true }))
    || (await cache.match(new URL('.', self.location.href).href, { ignoreSearch: true }))
    || (await cache.match(self.location.pathname.replace(/sw\.js$/, ''), { ignoreSearch: true }));

  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached || Response.error());

  if (cached) {
    event.waitUntil(networkFetch);
    return cached;
  }
  return networkFetch;
}

let tilePutCount = 0;
async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_CAP) return;
  await Promise.all(keys.slice(0, keys.length - TILE_CAP).map((k) => cache.delete(k)));
}

// Stale-while-revalidate for the data feed: instant paint from cache, silent background refresh.
// Uses canonical pathname as key so query auth tokens (?vault_token=...) never cause cache misses.
async function staleWhileRevalidateData(event, request) {
  const cache = await caches.open(DATA_CACHE);
  const url = new URL(request.url);
  const cacheKey = url.pathname;
  const cached = (await cache.match(cacheKey)) || (await cache.match(request, { ignoreSearch: true }));
  const networkFetch = fetch(request)
    .then(async (response) => {
      if (response.ok) {
        await cache.put(cacheKey, response.clone());
        if (cached) {
          const clients = await self.clients.matchAll();
          clients.forEach((c) => c.postMessage({ type: 'DATA_UPDATED' }));
        }
      }
      return response;
    })
    .catch(() => cached || Response.error());

  if (cached) {
    event.waitUntil(networkFetch);
    return cached;
  }
  return networkFetch;
}

// Stale-while-revalidate: tiles, style, sprites, fonts and geocoder answers are stable enough
// that instant-from-cache beats freshness.
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone()).then(() => {
          tilePutCount++;
          if (tilePutCount % 50 === 0) trimTiles(cache);
        });
      }
      return response;
    })
    .catch(() => cached || Response.error());
  if (cached) {
    event.waitUntil(networkFetch);
    return cached;
  }
  return networkFetch;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Page loads: stale-while-revalidate for sub-5ms instant app boot.
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(staleWhileRevalidateShell(event, request));
    return;
  }

  // Mutation API: never cached.
  if (new URL(request.url).pathname.includes("/api/")) return;

  // The place feed: stale-while-revalidate for instant load (<100ms) with background update.
  if (DATA_PATTERN.test(new URL(request.url).pathname)) {
    event.respondWith(staleWhileRevalidateData(event, request));
    return;
  }

  // Same-origin app assets (hashed JS/CSS) are immutable per build: shell cache, cache-first.
  if (new URL(request.url).origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(event, request));
});
