# Sylo V2 dashboard

The dashboard is a React 19 + Vite single-page app. It has no `package.json` of its own: its
dependencies live in the root `package.json`, and every command below runs from the repo root.

- `npm run dev:v2` starts the Vite dev server. It proxies `/api/v2` and `/auth` to the Sylo server
  on port 3000, so start that too (`npm run dev`) and sign in there first.
- `npm run build:v2` writes the production bundle to `web-v2/dist/` (served by Sylo under `/v2`).
  CI runs this on every pull request, so a JSX or import error fails the build.
- `npm run test:v2` runs the unit tests (Vitest, jsdom and Testing Library). They live in
  `web-v2/src/__tests__/` and are named `*.test.js` or `*.test.jsx`.

The server tests (`npm test`, the built-in `node --test` over `test/`) are separate. The two runners do
not pick up each other's files: Vitest only looks under `web-v2/`, and `npm test` only runs `test/`.
