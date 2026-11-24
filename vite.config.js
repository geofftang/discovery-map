import { defineConfig } from 'vite';

// Two builds from one app (council step 4):
//   default  -> publicDir docs/    (committed; GitHub Pages)      data: ./discovery.geojson
//   private  -> publicDir private/ (gitignored; owner build only) data: ./private.json
// The private payload never enters docs/ -- build_places_index.py refuses that path outright.
export default defineConfig(({ mode }) => {
  const isPrivate = mode === 'private';
  return {
    base: './',
    // Per-build id baked into the service-worker URL (registerServiceWorker.js). A new URL is a new
    // cache key at the CDN, so a deploy reaches phones even when an edge holds the old sw.js.
    define: { __SW_BUILD__: JSON.stringify(Date.now().toString(36)) },
    publicDir: isPrivate ? 'private' : 'docs',
    build: {
      outDir: isPrivate ? 'dist-private' : 'dist',
      emptyOutDir: true,
    },
  };
});
