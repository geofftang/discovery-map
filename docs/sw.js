// Offline cache: stale-while-revalidate for all GETs. Unlike a typical same-origin-only
// SW, this also caches cross-origin responses (CartoCDN basemap tiles, Photon geocoder) —
// both are CORS-enabled public endpoints with no auth/cookies, and the tiles/geocoder ARE
// the offline value here (the app shell alone is just an empty page without them).
// The build stamps this name (scripts/stamp-sw.mjs), so every deploy installs a fresh worker and
// drops the previous cache; a byte-identical worker would never reinstall and the shell would stick.
const CACHE_NAME = "discovery-map-__BUILD__";
const ROOT = new URL(".", self.location.href).href;
// The private build (dist-private/) copies this file and serves ./private.json instead.
const APP_SHELL = [ROOT];

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
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => precacheAppShell(cache)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// The data feed changes on every publish and staleness here means showing
// outdated places/hours — worth an extra round trip. Everything else (tiles,
// app shell) is stable enough that stale-while-revalidate's instant-from-cache
// win is worth the small staleness risk.
const NETWORK_FIRST_PATTERN = /(discovery\.geojson|private\.json)$/;

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  // Page loads are network-first: a reload must show the current build, not the cached shell.
  // Offline still works from the cached copy. (Before this, a new deploy needed two reloads.)
  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch {
          return (await cache.match(request)) || (await cache.match(ROOT)) || Response.error();
        }
      })
    );
    return;
  }

  if (NETWORK_FIRST_PATTERN.test(request.url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response.ok) cache.put(request, response.clone());
          return response;
        } catch {
          const cached = await cache.match(request);
          if (cached) return cached;
          throw new Error("place feed unavailable (offline, not yet cached)");
        }
      })
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);

      if (cached) {
        event.waitUntil(networkFetch);
        return cached;
      }
      return networkFetch;
    })
  );
});
