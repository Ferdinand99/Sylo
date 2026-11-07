# Contributing to Sylo

Thanks for taking a look. Sylo is a single Node.js process (Discord bot + web
dashboard) with SQLite persistence, run as a Docker container.

## Getting set up

```bash
npm install
cp .env.example .env      # add DISCORD_TOKEN + DISCORD_CLIENT_ID (a test bot)
npm start                 # or: npm run dev  (node --watch)
```

Set `DISCORD_DEV_GUILD_IDS` to a private test server's id so slash commands
register instantly (comma-separate for several). `npm run register` re-syncs
without a restart. Run `npm run build:v2` once to build the dashboard (`/v2` answers with a
plain message until you do). Full setup: [docs/self-hosting.md](docs/self-hosting.md).

## Architecture

One process. The bot and the API need no build step; the dashboard (`web-v2/`, React + Vite) is
built with `npm run build:v2`. Entry point `src/index.js` starts both halves:

| Area | Where |
|---|---|
| Discord client, command loader, event wiring | `src/bot/` |
| Slash commands (auto-discovered) | `src/bot/commands/*.js` — each exports `data` + `execute` |
| Message-component routing | `src/bot/lib/components.js` (`registerComponent(scope, prefix, fn)`) |
| Feature modules | `src/modules/<id>.js` — register with `on(moduleId, event, fn)` from `dispatch.js`; timers with `every()` / `after()` from `schedule.js` |
| Module catalogue | `src/modules/registry.js` |
| SQLite connection + forward-only migrations | `src/db/index.js` (`MIGRATIONS` array) |
| Per-table data access | `src/db/<name>.js` — prepared statements |
| Guild / user data erasure | `src/db/purge.js` (`GUILD_TABLES`, `forgetUser`, `describeUserData`) |
| Express app + routes | `src/web/server.js`, `src/web/routes/` |
| Dashboard (React + Vite) | `web-v2/src/`, built to `web-v2/dist` |
| Public pages (login, verify, appeal, leaderboard) | `src/web/views/`, styled by `src/web/public/public.css` |

Per-module docs live in [docs/modules/](docs/modules/README.md) — add a page when
you add a module.

## Before opening a PR

- `npm test` — the suite must pass. It runs in CI and gates every image build.
- `npm run lint` and `npm run format:check` — ESLint + Prettier, also gated in CI.
- Add or update tests for behaviour you change. Pure helpers get unit tests;
  DB-touching tests import `test/helpers/tmpDb.js` first so they use a throwaway
  database.
- Keep to the existing style: ESM, no new runtime dependencies without
  discussion, hand-written CSS (no CSS framework) in `web-v2/src` and
  `src/web/public`.
- `npm run test:v2` runs the dashboard's Vitest suite; CI runs it and
  `npm run build:v2` too.
- New per-guild storage goes in a migration in `src/db/index.js` (append only —
  migrations are forward-only and run automatically on boot).
- New guild-scoped tables must be added to `GUILD_TABLES` in `src/db/purge.js`
  (a test enforces this) so they are wiped when Sylo leaves a server. If the
  table keys on a user id, also handle it in `forgetUser` / `describeUserData`.

## Commits & releases

Use [Conventional Commits](https://www.conventionalcommits.org): `feat:`,
`fix:`, `refactor:`, `docs:`, `chore:`, and `feat!:` / `BREAKING CHANGE:` for a
major bump. Only `feat:` (minor) and `fix:` (patch) bump the version.
[release-please](https://github.com/googleapis/release-please) maintains the
release PR and `CHANGELOG.md` from commit subjects — one bullet per subject line,
so write them for a human reader.

## Adding a module

1. `src/modules/<id>.js` — register handlers with `on(moduleId, event, fn)` from
   `dispatch.js`. Run scheduled work with `every()` / `after()` from
   `src/modules/schedule.js`, never a bare `setInterval` or `setTimeout` (the
   scheduler starts and stops the timers with the bot). Export a `LIMITS`
   object for the module's setting limits and a `normalise…Config` that
   clamps with them.
2. Add it to `MODULES` in `src/modules/registry.js` and import it in
   `src/modules/index.js`.
3. If it stores per-guild config: add the form `web-v2/src/moduleForms/<Name>.jsx`
   (registered in `moduleForms/index.js`, reading its limits through
   `useModuleLimits`) and a `GET`/`POST /api/v2/guilds/:guildId/modules/<id>/config`
   pair in `src/web/routes/v2Api.js` that uses the module's `normalise…Config`.
   The limits reach the form through `/api/v2/modules/limits`.
4. Icon: add an entry to `MODULE_ICONS` in `src/web/lib/moduleIcons.js` and the
   matching SF Symbol in `ModuleSymbol.swift`
   (`apps/sylo-ios/SyloKit/Sources/SyloKit/Presentation/`); `test/moduleIcons.test.js`
   keeps the two in step. Add a card line in `src/web/lib/overviewSummary.js`.
5. If it stores per-guild rows, add the table to `GUILD_TABLES`; if user-scoped,
   to `forgetUser` / `describeUserData` too.
6. Write `docs/modules/<id>.md` and add it to `docs/modules/README.md`.
7. Add tests: a unit test for the pure helpers and `normalise…Config`, a route
   test for the config pair, and a form test in `web-v2/src/__tests__` when the
   form has logic worth testing.
