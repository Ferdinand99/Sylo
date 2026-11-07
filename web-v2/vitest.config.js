// Unit tests for the V2 dashboard (React + jsdom). Run from the repo root with
// `npm run test:v2`. The server suite (`npm test`, built-in `node --test`) lives
// in test/ and never touches this; `root` is web-v2/, so Vitest cannot collect it.
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // describe/it/expect/vi as globals, so Testing Library cleans up after each test by itself.
    globals: true,
    include: ['src/**/*.test.{js,jsx}'],
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
