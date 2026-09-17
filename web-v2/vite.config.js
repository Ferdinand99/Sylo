// Config for the V2 dashboard SPA. Run from the repo root via
// `npm run build:v2` (see package.json), which is `vite build --config
// web-v2/vite.config.js`. `root`/`base` are set explicitly because that
// command's cwd is the repo root, not this directory.
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  base: '/v2/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev:v2` — proxy API calls to the real Express server (started
    // separately with `npm run dev`) so the SPA has real data and a real
    // session cookie during development.
    proxy: {
      '/api/v2': 'http://localhost:3000',
    },
  },
});
