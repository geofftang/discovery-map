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

// Network first, but if the network has not answered within NETWORK_TIMEOUT_MS and a cached copy
// exists, serve the cache and let the fetch finish in the background to refresh it.
async function networkFirst(event, cacheName, request, fallbacks) {
  const cache = await caches.open(cacheName);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  const lookup = async () => {
    for (const key of fallbacks || [request]) {
      const hit = await cache.match(key);
      if (hit) return hit;
    }
    return null;
  };
  const timeout = new Promise((resolve) =>
    setTimeout(async () => resolve(await lookup()), NETWORK_TIMEOUT_MS)
  );
  event.waitUntil(network.catch(() => {}));
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    return await network; // timed out with nothing cached: keep waiting on the network
  } catch {
    const cached = await lookup();
    if (cached) return cached;
    return Response.error();
  }
}

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length <= TILE_CAP) return;
  await Promise.all(keys.slice(0, keys.length - TILE_CAP).map((k) => cache.delete(k)));
}

// Stale-while-revalidate: tiles, style, sprites, fonts and geocoder answers are stable enough
// that instant-from-cache beats freshness.
async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone()).then(() => trimTiles(cache));
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

  // Page loads: a reload must show the current build, but never hang on weak signal.
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(networkFirst(event, SHELL_CACHE, request, [request, ROOT]));
    return;
  }

  // Mutation API: never cached.
  if (new URL(request.url).pathname.includes("/api/")) return;

  // The place feed changes on every publish; staleness shows outdated hours, so prefer the network.
  if (DATA_PATTERN.test(new URL(request.url).pathname)) {
    event.respondWith(networkFirst(event, DATA_CACHE, request));
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
