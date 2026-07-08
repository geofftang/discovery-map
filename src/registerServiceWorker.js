// Registers the offline-cache service worker (docs/sw.js -> dist/sw.js at build).
// Production-only: a SW during `vite dev` would cache dev-server output and cause
// stale-content confusion across hot reloads.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((err) => {
    console.error("Service worker registration failed", err);
  });
}
