import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: 'docs',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
