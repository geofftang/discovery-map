import { defineConfig } from 'vite';

// Two builds from one app (council step 4):
//   default  -> publicDir docs/    (committed; GitHub Pages)      data: ./discovery.geojson
//   private  -> publicDir private/ (gitignored; owner build only) data: ./private.json
// The private payload never enters docs/ -- build_places_index.py refuses that path outright.
export default defineConfig(({ mode }) => {
  const isPrivate = mode === 'private';
  return {
    base: './',
    publicDir: isPrivate ? 'private' : 'docs',
    build: {
      outDir: isPrivate ? 'dist-private' : 'dist',
      emptyOutDir: true,
    },
  };
});
