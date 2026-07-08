// Offline cache: stale-while-revalidate for all GETs. Unlike a typical same-origin-only
// SW, this also caches cross-origin responses (CartoCDN basemap tiles, Photon geocoder) —
// both are CORS-enabled public endpoints with no auth/cookies, and the tiles/geocoder ARE
// the offline value here (the app shell alone is just an empty page without them).
const CACHE_NAME = "discovery-map-v1";
const ROOT = new URL(".", self.location.href).href;
const APP_SHELL = [ROOT, `${ROOT}discovery.geojson`];

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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

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
